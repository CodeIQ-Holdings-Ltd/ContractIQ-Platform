-- ═══════════════════════════════════════════════════════════════════
--  ContractIQ · MIGRATION 007 · Amazon Bedrock and data safety
--  CodeIQ Holdings Ltd · 19 September 2026
--
--  Run AFTER SETUP.sql and MIGRATIONS 003, 004, 005 and 006.
--  Safe to run more than once.
--
--  WHAT THIS DOES, IN PLAIN ENGLISH
--
--   1. Locks the back-office functions. Supabase lets the public API call
--      any database function unless told otherwise. Several of ours were
--      never meant to be called by a customer — the ones that ADD CREDITS,
--      CHANGE A PLAN, or SETTLE A CHARGE. Anyone holding the app's public
--      key could have given themselves Enterprise for nothing. They now
--      answer only to the server.
--   2. Stops queued work lingering. When a background analysis finishes,
--      the copy of the contract text that was queued with it is deleted.
--   3. Closes a gap between workspaces. A background job can no longer
--      write its result onto a contract that belongs to someone else.
--   4. Zero-Retention becomes a real, saved, per-workspace setting that
--      the server enforces, not a switch that forgot itself on refresh.
--   5. Each workspace has a data region: 'eu' (the default, and the only
--      one used at launch) or 'us' (for a US customer who insists).
--   6. Free Sandbox goes from 150 to 100 credits for new sign-ups.
--   7. Re-runs inside the revision window are recognised as free however
--      the analysis was run — in the browser or in the background.
--   8. The background dispatcher is pinned to London and sends the key
--      in the form the rewritten job-worker checks.
-- ═══════════════════════════════════════════════════════════════════

begin;

-- ── 1 · Workspace settings ──────────────────────────────────────────
alter table accounts add column if not exists data_region    text    not null default 'eu';
alter table accounts add column if not exists zero_retention boolean not null default false;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'accounts_data_region_check') then
    alter table accounts add constraint accounts_data_region_check check (data_region in ('eu', 'us'));
  end if;
end $$;

comment on column accounts.data_region is
  'Where AI processing runs for this workspace. eu = Amazon Bedrock EU route (UK/EEA/Switzerland), the default. us = Bedrock US route (US and Canada). Changed by CodeIQ only, never by the customer.';
comment on column accounts.zero_retention is
  'Enterprise only. When true, document text is never stored in the database and is removed from any contract once it has been analysed.';


-- ── 2 · Sandbox: 150 → 100 credits ─────────────────────────────────
-- Existing accounts keep what they were given. Only the catalogue and
-- new sign-ups change.
update plan_catalogue set credits_included = 100, updated_at = now()
 where plan = 'sandbox' and credits_included = 150;
alter table accounts alter column credits_included set default 100;

-- Sign-up now reads the Sandbox allowance from the catalogue instead of
-- carrying its own copy of the number — which is how two numbers drift.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  new_account_id uuid;
  org_name text;
  sandbox_credits int;
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name',
             new.raw_user_meta_data->>'name',
             split_part(new.email, '@', 1)),
    new.raw_user_meta_data->>'avatar_url'
  )
  on conflict (id) do nothing;

  org_name := coalesce(new.raw_user_meta_data->>'company',
                       initcap(split_part(split_part(new.email,'@',2), '.', 1)));

  select coalesce((select credits_included from plan_catalogue where plan = 'sandbox'), 100)
    into sandbox_credits;

  insert into public.accounts (name, plan, credits_included, billing_email)
  values (org_name, 'sandbox', sandbox_credits, new.email)
  returning id into new_account_id;

  insert into public.account_members (account_id, user_id, role)
  values (new_account_id, new.id, 'owner')
  on conflict do nothing;

  -- Founding seat, if any remain.
  perform claim_founding_seat(new_account_id);

  return new;
end $$;


-- ── 3 · Re-runs are free however the first analysis was run ────────
-- 006 looked only at the analyses table, which only the background queue
-- writes. An analysis run in the browser left no row there, so its re-run
-- was charged. A settled analysis charge now counts too.
create or replace function reanalysis_is_free(
  p_account_id  uuid,
  p_contract_id text
) returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select pc.revision_days > 0
            and (
              exists (
                select 1 from analyses an
                 where an.account_id  = p_account_id
                   and an.contract_id = p_contract_id
                   and an.created_at >= now() - make_interval(days => pc.revision_days))
              or exists (
                select 1 from credit_holds h
                 where h.account_id  = p_account_id
                   and h.contract_id = p_contract_id
                   and h.kind        = 'analysis'
                   and h.status      = 'settled'
                   and h.resolved_at >= now() - make_interval(days => pc.revision_days))
            )
       from accounts a
       join plan_catalogue pc on pc.plan = a.plan
      where a.id = p_account_id),
    false)
$$;
grant execute on function reanalysis_is_free(uuid, text) to authenticated;


-- ── 4 · authorise_ai_call: members only ────────────────────────────
-- Unchanged except the first check. It used to accept any account id,
-- so a signed-in stranger could tie up another workspace's credits.
create or replace function authorise_ai_call(
  p_account_id  uuid,
  p_kind        text,
  p_cost        int,
  p_contract_id text default null,
  p_run_id      text default null
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  cap    int;
  used   int;
  h      credit_holds;
  b      record;
begin
  if p_account_id is null or p_account_id not in (select my_account_ids()) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden',
                              'message', 'This sign-in is not a member of that workspace.');
  end if;

  if p_run_id is not null then
    select * into h from credit_holds
     where account_id = p_account_id and run_id = p_run_id and status = 'held';
    if found then
      select * into b from credits_breakdown(p_account_id);
      return jsonb_build_object(
        'ok', true, 'hold_id', h.id, 'continuation', true,
        'from_plan', h.plan_credits, 'from_bolton', h.bolton_credits,
        'credits_left', b.total_left
      );
    end if;
  end if;

  select max_per_hour into cap from ai_limits where kind = p_kind;
  cap  := coalesce(cap, 20);
  used := ai_calls_last_hour(p_account_id, p_kind);

  if used >= cap then
    return jsonb_build_object(
      'ok', false, 'reason', 'rate_limit',
      'limit', cap, 'used', used,
      'message', format('This workspace has reached its limit of %s %s an hour. Try again shortly.',
                        cap, case when p_kind = 'cedric' then 'questions' else 'analyses' end)
    );
  end if;

  begin
    h := reserve_credits(p_account_id, p_kind, p_cost, p_contract_id, null, p_run_id);
  exception when sqlstate 'CIQ02' then
    select * into b from credits_breakdown(p_account_id);
    return jsonb_build_object(
      'ok', false, 'reason', 'insufficient_credits',
      'needed', p_cost, 'available', b.total_left,
      'message', format('This costs %s credits and %s remain.', p_cost, b.total_left)
    );
  end;

  select * into b from credits_breakdown(p_account_id);
  return jsonb_build_object(
    'ok', true, 'hold_id', h.id,
    'from_plan', h.plan_credits, 'from_bolton', h.bolton_credits,
    'credits_left', b.total_left
  );
end $$;
grant execute on function authorise_ai_call(uuid, text, int, text, text) to authenticated;


-- ── 5 · Queueing: refuse someone else's contract ───────────────────
-- Identical to 006 apart from the ownership check near the top.
create or replace function enqueue_job(
  p_account_id  uuid,
  p_contract_id text,
  p_kind        text,
  p_payload     jsonb default '{}'::jsonb,
  p_idempotency text default null
) returns jobs
language plpgsql security definer set search_path = public
as $$
declare
  j      jobs;
  cost   int;
  cap    int;
  used   int;
  h      credit_holds;
  v_hold uuid := null;
begin
  if not can_edit(p_account_id) then
    raise exception 'not permitted to queue work for this account';
  end if;

  -- Contract ids are made in the browser, so they can be guessed. A job
  -- may only name a contract that is this workspace's own. (One that is
  -- not saved yet is refused by the foreign key; the app then runs the
  -- analysis in the browser instead.)
  if p_contract_id is not null and exists (
       select 1 from contracts where id = p_contract_id and account_id <> p_account_id) then
    raise exception 'That contract belongs to a different workspace' using errcode = 'CIQ04';
  end if;

  if p_idempotency is not null then
    select * into j from jobs
     where account_id = p_account_id
       and idempotency_key = p_idempotency
       and status in ('queued','running','succeeded')
     limit 1;
    if found then return j; end if;
  end if;

  cost := case
            when p_kind = 'analysis'   then 10
            when p_kind = 'reanalysis' then
              case when reanalysis_is_free(p_account_id, p_contract_id) then 0 else 10 end
            else 0
          end;

  if p_kind in ('analysis', 'reanalysis') then
    select max_per_hour into cap from ai_limits where kind = 'analysis';
    cap  := coalesce(cap, 20);
    used := ai_calls_last_hour(p_account_id, 'analysis');
    if used >= cap then
      raise exception 'Hourly analysis limit reached'
        using errcode = 'CIQ03',
              detail  = json_build_object('limit', cap, 'used', used)::text;
    end if;
  end if;

  if cost > 0 then
    h := reserve_credits(p_account_id, 'analysis', cost, p_contract_id, null);
    v_hold := h.id;
  end if;

  insert into jobs (account_id, contract_id, kind, payload,
                    priority, requested_by, idempotency_key, hold_id)
  values (p_account_id, p_contract_id, p_kind, p_payload,
          case (select plan from accounts where id = p_account_id)
            when 'enterprise' then 10
            when 'scale'      then 30
            when 'growth'     then 50
            else 100 end,
          auth.uid(), p_idempotency, v_hold)
  returning * into j;

  if v_hold is not null then
    update credit_holds set job_id = j.id where id = v_hold;
  end if;

  return j;
end $$;


-- ── 6 · Completing a job: own contract only, payload cleared ───────
create or replace function complete_job(
  p_job_id uuid, p_result jsonb
) returns void
language plpgsql security definer set search_path = public
as $$
declare
  j  jobs;
  zr boolean;
begin
  select * into j from jobs where id = p_job_id;
  if not found then return; end if;

  -- The queued copy of the contract text has done its job. Delete it.
  update jobs
     set status = 'succeeded', progress = 100, result = p_result,
         payload = '{}'::jsonb,
         finished_at = now(), locked_by = null, error = null
   where id = p_job_id;

  if j.kind in ('analysis','reanalysis') and j.contract_id is not null then
    -- Written ONLY onto a contract this workspace owns. The result also
    -- stays on the job row, where the app can read it through my_jobs.
    update contracts
       set analysis = p_result, updated_at = now()
     where id = j.contract_id
       and account_id = j.account_id;

    if found then
      insert into analyses (account_id, contract_id, analysis)
      values (j.account_id, j.contract_id, p_result);
    end if;

    select zero_retention into zr from accounts where id = j.account_id;
    if coalesce(zr, false) then
      update documents
         set extracted_text = null
       where contract_id = j.contract_id
         and account_id  = j.account_id;
    end if;
  end if;

  if j.hold_id is not null then
    perform settle_credit_hold(j.hold_id);
  end if;
end $$;


-- ── 7 · A job that dies also lets go of its payload ───────────────
create or replace function fail_job(
  p_job_id uuid, p_error text, p_retryable boolean default true
) returns void
language plpgsql security definer set search_path = public
as $$
declare j jobs;
begin
  select * into j from jobs where id = p_job_id;
  if not found then return; end if;

  if p_retryable and j.attempts < j.max_attempts then
    update jobs
       set status = 'queued',
           run_after = now() + (interval '10 seconds' * power(2, least(j.attempts, 6))),
           error = p_error, locked_by = null, progress_note = 'Retrying…'
     where id = p_job_id;
  else
    update jobs
       set status = 'dead', error = p_error, finished_at = now(),
           locked_by = null, progress_note = 'Failed — needs investigation',
           payload = '{}'::jsonb
     where id = p_job_id;

    if j.hold_id is not null then
      perform release_credit_hold(j.hold_id);
    end if;
  end if;
end $$;

-- Anything already finished before this migration.
update jobs set payload = '{}'::jsonb
 where status in ('succeeded', 'dead', 'failed')
   and payload is distinct from '{}'::jsonb;

-- my_jobs now carries the result, so the app can read a finished analysis
-- straight from the job. Scoped to the caller's own workspaces.
drop view if exists my_jobs;
create view my_jobs as
  select j.id, j.contract_id, j.kind, j.status, j.progress, j.progress_note,
         j.attempts, j.max_attempts, j.error, j.enqueued_at, j.started_at,
         j.finished_at, c.ref, c.supplier,
         extract(epoch from (now() - j.enqueued_at))::int as age_seconds,
         j.result
    from jobs j
    left join contracts c on c.id = j.contract_id
   where j.account_id in (select my_account_ids())
     and j.enqueued_at > now() - interval '24 hours';


-- ── 8 · The dispatcher: London, and the key the worker checks ─────
create or replace function dispatch_jobs()
returns int
language plpgsql security definer set search_path = public
as $$
declare
  waiting int;
  fn_url  text;
  svc_key text;
begin
  select count(*) into waiting
    from jobs where status = 'queued' and run_after <= now();
  if waiting = 0 then return 0; end if;

  select decrypted_secret into fn_url
    from vault.decrypted_secrets where name = 'job_worker_url';
  select decrypted_secret into svc_key
    from vault.decrypted_secrets where name = 'service_role_key';
  if fn_url is null or svc_key is null then
    raise notice 'dispatch_jobs: vault secrets not set; skipping';
    return 0;
  end if;

  -- Run the worker in London, next to the database, whoever is asking.
  if position('forceFunctionRegion' in fn_url) = 0 then
    fn_url := fn_url || case when position('?' in fn_url) > 0 then '&' else '?' end
                     || 'forceFunctionRegion=eu-west-2';
  end if;

  -- One wake-up per waiting job (up to five), so jobs run side by side.
  for i in 1 .. least(waiting, 5) loop
    perform net.http_post(
      url     := fn_url,
      headers := jsonb_build_object(
                   'Content-Type',  'application/json',
                   'apikey',        svc_key,
                   'Authorization', 'Bearer ' || svc_key),
      body    := jsonb_build_object('trigger', 'cron', 'waiting', waiting),
      timeout_milliseconds := 5000
    );
  end loop;
  return waiting;
end $$;


-- ── 9 · Zero-Retention, saved per workspace ───────────────────────
create or replace function my_workspace_settings()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select jsonb_build_object('ok', true, 'account_id', a.id,
                               'zero_retention', a.zero_retention,
                               'data_region', a.data_region)
       from accounts a
      where a.id in (select my_account_ids())
      order by a.created_at
      limit 1),
    jsonb_build_object('ok', false, 'reason', 'no_account'))
$$;
grant execute on function my_workspace_settings() to authenticated;

create or replace function set_zero_retention(p_account_id uuid, p_on boolean)
returns boolean
language plpgsql security definer set search_path = public
as $$
begin
  if not can_admin(p_account_id) then
    raise exception 'Only a workspace owner or admin can change this' using errcode = 'CIQ05';
  end if;
  if p_on and coalesce((select plan from accounts where id = p_account_id), '') <> 'enterprise' then
    raise exception 'Zero-Retention mode is part of the Enterprise plan' using errcode = 'CIQ05';
  end if;
  update accounts set zero_retention = p_on where id = p_account_id;
  return p_on;
end $$;
grant execute on function set_zero_retention(uuid, boolean) to authenticated;

-- Server-side guarantee: while Zero-Retention is on, document text is not
-- stored, whatever a browser sends.
create or replace function enforce_zero_retention()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.extracted_text is not null
     and coalesce((select zero_retention from accounts where id = new.account_id), false) then
    new.extracted_text := null;
  end if;
  return new;
end $$;

drop trigger if exists documents_zero_retention on documents;
create trigger documents_zero_retention
  before insert or update of extracted_text on documents
  for each row execute function enforce_zero_retention();


-- ── 10 · Back-office functions answer to the server only ──────────
-- Postgres lets PUBLIC execute every new function, and Supabase exposes
-- the public schema through its API. These functions add credits,
-- change plans, settle charges and run the queue: the webhook, the
-- worker and the proxy call them with the secret key; nobody else may.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = any (array[
         'billing_apply_plan', 'billing_apply_credits', 'billing_checkout_completed',
         'billing_payment_failed', 'billing_subscription_ended',
         'reserve_credits', 'settle_credit_hold', 'release_credit_hold', 'reap_stale_holds',
         'claim_job', 'complete_job', 'fail_job', 'report_job_progress', 'reap_stale_jobs',
         'dispatch_jobs', 'maintenance_tick',
         'refresh_founding_credits', 'convert_expired_founding', 'claim_founding_seat',
         'stripe_event_seen', 'handle_new_user', 'enforce_zero_retention'
       ])
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

-- And from now on, new functions are private unless granted on purpose.
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema public revoke execute on functions from anon, authenticated;

commit;

-- ── How to check it worked ─────────────────────────────────────────
-- Run each on its own. Expected answers are in the comments.
--
-- 1. select plan, credits_included from plan_catalogue where plan = 'sandbox';
--      → sandbox | 100
--
-- 2. select has_function_privilege('anon', 'billing_apply_credits(uuid,int,text)', 'execute'),
--           has_function_privilege('authenticated', 'billing_apply_plan(uuid,text,text,text,timestamptz)', 'execute');
--      → false | false     (if the second errors, the signature differs — the first is enough)
--
-- 3. select count(*) from jobs where status = 'succeeded' and payload <> '{}'::jsonb;
--      → 0
--
-- 4. select column_name from information_schema.columns
--     where table_name = 'accounts' and column_name in ('data_region','zero_retention');
--      → both rows
