-- ═══════════════════════════════════════════════════════════════
--  ContractIQ Platform · MIGRATION 004 · Credits and billing
--  CodeIQ Holdings Ltd · company 17454743 · ICO 00015500673
-- ═══════════════════════════════════════════════════════════════
--
--  WHAT THIS FIXES
--
--  Before this script, four things were true and all of them cost money:
--
--   1. Nothing checked a balance before starting work. An account on
--      zero could queue as much analysis as it liked.
--   2. Credits were written only when a queued job SUCCEEDED, so two
--      requests started at the same moment both passed any check.
--   3. Cedric questions never touched the ledger at all. Free forever.
--   4. A Stripe payment changed nothing. No webhook existed, so a paid
--      customer stayed on the sandbox plan.
--
--  After it: credits are RESERVED before the work starts, SETTLED when
--  it succeeds and RELEASED when it fails; plan credits are spent before
--  bought ones; and Stripe payments set the plan and the allowance.
--
--  ORDER: run SETUP.sql, then MIGRATION_003_founding.sql, then this.
--  Safe to run more than once.
--
--  NOTE ON PRICES: they live in plan_catalogue below, in the database,
--  not in the app. Change a price there and the product follows. The
--  insert uses ON CONFLICT DO NOTHING, so re-running this script will
--  never overwrite a price you have edited.
-- ═══════════════════════════════════════════════════════════════

begin;

-- ───────────────────────────────────────────────────────────────
--  1 · The plan catalogue — the single source of truth for plans
-- ───────────────────────────────────────────────────────────────
-- The app used to carry `const EDITION = "enterprise"` compiled into
-- the bundle, which is why every founding member got the Enterprise
-- feature set no matter what the database said. The app now reads its
-- entitlement from here at runtime.

create table if not exists plan_catalogue (
  plan             text primary key
                   check (plan in ('sandbox','growth','scale','enterprise')),
  name             text    not null,
  credits_included int     not null,
  period_days      int     not null default 30,
  price_pence      int,                        -- null = talk to us
                                               -- Sept 2026 repricing: Growth £79,
                                               -- Scale £270, Enterprise £700 flat.
                                               -- Enterprise carries a price but stays
                                               -- self_serve = false: it is sold with a
                                               -- conversation, not a card.
  currency         text    not null default 'gbp',
  stripe_price_id  text,                       -- set this once created in Stripe
  self_serve       boolean not null default false,   -- can be bought by card
  sort_order       int     not null default 0,
  updated_at       timestamptz default now()
);

insert into plan_catalogue
  (plan, name, credits_included, period_days, price_pence, self_serve, sort_order)
values
  ('sandbox',    'Evaluation Sandbox',    150, 90,  0,     false, 1),
  ('growth',     'Growth / Professional', 500, 30,  7900,  true,  2),
  ('scale',      'Scale',                1800, 30,  27000, true,  3),
  ('enterprise', 'Enterprise',           5000, 30,  70000, false, 4)
on conflict (plan) do nothing;

-- Bought credit packs. Same reasoning: priced in the database.
create table if not exists credit_packs (
  code            text primary key,
  name            text    not null,
  credits         int     not null,
  price_pence     int     not null,
  currency        text    not null default 'gbp',
  stripe_price_id text,
  active          boolean not null default true,
  sort_order      int     not null default 0
);

-- If an earlier copy of this script already created the catalogue at the
-- pre-September prices, the ON CONFLICT DO NOTHING above would leave them
-- as they were. Correct them here — but only where they still hold the old
-- value, so a price you have since set by hand is never overwritten.
update plan_catalogue set price_pence = 27000, updated_at = now()
 where plan = 'scale'      and price_pence = 19900;
update plan_catalogue set price_pence = 70000, updated_at = now()
 where plan = 'enterprise' and (price_pence is null or price_pence = 49900);

insert into credit_packs (code, name, credits, price_pence, sort_order)
values ('credits100', '100 credits', 100, 2500, 1)
on conflict (code) do nothing;

grant select on plan_catalogue, credit_packs to anon, authenticated;


-- ───────────────────────────────────────────────────────────────
--  2 · Two credit buckets: the plan allowance, and bought credits
-- ───────────────────────────────────────────────────────────────
-- Plan credits reset when the billing period rolls. Bought credits do
-- not. Plan credits are always spent FIRST, so a customer who tops up
-- does not watch their purchase evaporate at the next reset.

alter table accounts add column if not exists credits_bolton int not null default 0;

comment on column accounts.credits_bolton is
  'Bought credits. Never reset by a billing period. Spent only after the plan allowance is exhausted.';

-- The ledger records which bucket each spend came out of.
alter table credit_ledger add column if not exists source  text;
alter table credit_ledger add column if not exists hold_id uuid;

update credit_ledger set source = 'plan' where source is null;

alter table credit_ledger alter column source set default 'plan';
alter table credit_ledger drop constraint if exists credit_ledger_source_check;
alter table credit_ledger add  constraint credit_ledger_source_check
  check (source in ('plan','bolton','purchase'));

-- 'bolton_purchase' is the credit going IN (recorded negative, as topup
-- already was). 'adjustment' is for the times a human has to put things
-- right by hand, which will happen.
alter table credit_ledger drop constraint if exists credit_ledger_kind_check;
alter table credit_ledger add  constraint credit_ledger_kind_check
  check (kind in ('analysis','cedric','revision','topup','bolton_purchase','adjustment'));


-- ───────────────────────────────────────────────────────────────
--  3 · Holds — the reservation that makes a balance mean something
-- ───────────────────────────────────────────────────────────────
-- A hold is taken BEFORE the AI is called and resolved afterwards.
-- Two requests arriving in the same millisecond cannot both reserve the
-- last ten credits, because reserve_credits() locks the account row.

create table if not exists credit_holds (
  id             uuid primary key default gen_random_uuid(),
  account_id     uuid not null references accounts(id) on delete cascade,
  user_id        uuid references auth.users(id) on delete set null,
  contract_id    text,
  kind           text not null check (kind in ('analysis','cedric','revision')),
  plan_credits   int  not null default 0 check (plan_credits   >= 0),
  bolton_credits int  not null default 0 check (bolton_credits >= 0),
  status         text not null default 'held'
                 check (status in ('held','settled','released')),
  job_id         uuid,
  -- One ANALYSIS is five calls to the model, one per stage of the
  -- pipeline. They share a run_id so the run is charged once, not five
  -- times, and so a run that dies at stage four is not charged at all.
  run_id         text,
  created_at     timestamptz default now(),
  resolved_at    timestamptz
);

alter table credit_holds add column if not exists run_id text;

-- At most one open hold per run. A client replaying an old run_id finds
-- nothing open and has to pay for a new one.
create unique index if not exists credit_holds_open_run
  on credit_holds (account_id, run_id) where status = 'held' and run_id is not null;

create index if not exists credit_holds_open
  on credit_holds (account_id, created_at desc) where status = 'held';
create index if not exists credit_holds_recent
  on credit_holds (account_id, kind, created_at desc);

alter table jobs add column if not exists hold_id uuid references credit_holds(id);

alter table credit_holds enable row level security;
drop policy if exists "read my credit holds" on credit_holds;
create policy "read my credit holds" on credit_holds
  for select using (account_id in (select my_account_ids()));
-- Deliberately no insert/update/delete policy. Holds are created and
-- resolved only by the SECURITY DEFINER functions below, never by a
-- browser, however inventive the browser is feeling.


-- ───────────────────────────────────────────────────────────────
--  4 · What is actually left
-- ───────────────────────────────────────────────────────────────
-- Open holds count as spent. Money that might be spent in the next
-- thirty seconds is not money you can spend twice.

create or replace function credits_breakdown(acct uuid)
returns table (
  plan_allowance int,
  plan_spent     int,
  plan_left      int,
  bolton_left    int,
  held           int,
  total_left     int
)
language sql stable security definer set search_path = public as $$
  with a as (
    select coalesce(credits_included,0) + coalesce(credits_banked,0) as allowance,
           coalesce(credits_bolton,0) as bolton,
           coalesce(period_started_at, now()) as period_start
      from accounts where id = acct
  ),
  spent as (
    select coalesce(sum(l.credits),0)::int as plan_spent
      from credit_ledger l, a
     where l.account_id = acct
       and coalesce(l.source,'plan') = 'plan'
       and l.credits > 0
       and l.created_at >= a.period_start
  ),
  holds as (
    select coalesce(sum(plan_credits),0)::int   as held_plan,
           coalesce(sum(bolton_credits),0)::int as held_bolton
      from credit_holds
     where account_id = acct and status = 'held'
  )
  select a.allowance::int,
         spent.plan_spent,
         greatest(0, a.allowance - spent.plan_spent - holds.held_plan)::int,
         greatest(0, a.bolton - holds.held_bolton)::int,
         (holds.held_plan + holds.held_bolton)::int,
         (greatest(0, a.allowance - spent.plan_spent - holds.held_plan)
          + greatest(0, a.bolton - holds.held_bolton))::int
    from a, spent, holds
$$;

-- Same signature as before, so everything that already calls it still works.
create or replace function credits_remaining(acct uuid) returns int
language sql stable security definer set search_path = public as $$
  select coalesce((select total_left from credits_breakdown(acct)), 0)
$$;

grant execute on function credits_breakdown(uuid) to authenticated;
grant execute on function credits_remaining(uuid) to authenticated;


-- ───────────────────────────────────────────────────────────────
--  5 · Rate limiting, per account, that survives a cold start
-- ───────────────────────────────────────────────────────────────
-- The old guard was a counter in an Edge Function's memory: global
-- across every customer, and reset to zero whenever the function went
-- cold. This one is per account and lives in the database.

create table if not exists ai_limits (
  kind         text primary key check (kind in ('analysis','cedric','revision')),
  max_per_hour int not null
);

insert into ai_limits (kind, max_per_hour) values
  ('analysis',  20),    -- Rahul's number, from the launch questionnaire
  ('revision',  20),
  ('cedric',   120)     -- questions are conversational; 20/hour would bite
on conflict (kind) do nothing;

grant select on ai_limits to authenticated;

create or replace function ai_calls_last_hour(acct uuid, p_kind text)
returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from credit_holds
   where account_id = acct
     and kind = p_kind
     and status in ('held','settled')          -- a released hold did no work
     and created_at > now() - interval '1 hour'
$$;


-- ───────────────────────────────────────────────────────────────
--  6 · Reserve · settle · release
-- ───────────────────────────────────────────────────────────────

-- Adding a defaulted parameter does NOT replace a function — Postgres
-- treats the new argument list as a separate overload, and then a call
-- with the old number of arguments is ambiguous and fails. Drop the
-- earlier shapes explicitly so re-running this script stays safe.
drop function if exists reserve_credits(uuid, text, int, text, uuid);
drop function if exists authorise_ai_call(uuid, text, int, text);

create or replace function reserve_credits(
  p_account_id  uuid,
  p_kind        text,
  p_cost        int,
  p_contract_id text default null,
  p_job_id      uuid default null,
  p_run_id      text default null
) returns credit_holds
language plpgsql security definer set search_path = public
as $$
declare
  b           record;
  from_plan   int;
  from_bolton int;
  h           credit_holds;
begin
  if p_cost is null or p_cost < 0 then
    raise exception 'A credit cost cannot be negative' using errcode = 'CIQ00';
  end if;

  -- Serialise every reservation for this account. Without this lock two
  -- simultaneous requests both read the same balance and both proceed.
  perform 1 from accounts where id = p_account_id for update;
  if not found then
    raise exception 'No such account' using errcode = 'CIQ00';
  end if;

  select * into b from credits_breakdown(p_account_id);

  if p_cost > b.total_left then
    raise exception 'Not enough credits'
      using errcode = 'CIQ02',
            detail  = json_build_object(
              'needed',      p_cost,
              'available',   b.total_left,
              'plan_left',   b.plan_left,
              'bolton_left', b.bolton_left
            )::text;
  end if;

  -- Plan allowance first, bought credits only for the remainder.
  from_plan   := least(p_cost, b.plan_left);
  from_bolton := p_cost - from_plan;

  insert into credit_holds
    (account_id, user_id, contract_id, kind, plan_credits, bolton_credits, job_id, run_id)
  values
    (p_account_id, auth.uid(), p_contract_id, p_kind, from_plan, from_bolton, p_job_id, p_run_id)
  returning * into h;

  return h;
end $$;


create or replace function settle_credit_hold(p_hold_id uuid) returns void
language plpgsql security definer set search_path = public
as $$
declare h credit_holds;
begin
  select * into h from credit_holds where id = p_hold_id for update;
  if not found or h.status <> 'held' then return; end if;   -- idempotent

  if h.plan_credits > 0 then
    insert into credit_ledger (account_id, user_id, contract_id, kind, credits, source, hold_id)
    values (h.account_id, h.user_id, h.contract_id, h.kind, h.plan_credits, 'plan', h.id);
  end if;

  if h.bolton_credits > 0 then
    insert into credit_ledger (account_id, user_id, contract_id, kind, credits, source, hold_id)
    values (h.account_id, h.user_id, h.contract_id, h.kind, h.bolton_credits, 'bolton', h.id);

    update accounts
       set credits_bolton = greatest(0, coalesce(credits_bolton,0) - h.bolton_credits)
     where id = h.account_id;
  end if;

  update credit_holds set status = 'settled', resolved_at = now() where id = p_hold_id;
end $$;


create or replace function release_credit_hold(p_hold_id uuid) returns void
language plpgsql security definer set search_path = public
as $$
begin
  update credit_holds
     set status = 'released', resolved_at = now()
   where id = p_hold_id and status = 'held';
end $$;


-- A hold whose caller vanished — the Edge Function timed out, the worker
-- was killed — must not hold credits hostage for ever.
create or replace function reap_stale_holds(stale_after interval default '30 minutes')
returns int language plpgsql security definer set search_path = public
as $$
declare n int;
begin
  with released as (
    update credit_holds
       set status = 'released', resolved_at = now()
     where status = 'held'
       and created_at < now() - stale_after
       and (job_id is null or job_id not in (select id from jobs where status in ('queued','running')))
    returning 1
  )
  select count(*)::int into n from released;
  return n;
end $$;


-- The whole thing in one call, for a synchronous action like a Cedric
-- question where there is no job to hang a hold on.
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
  -- A stage of a run that is already paid for. Five model calls, one
  -- charge, and no second bite at the hourly limit.
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
grant execute on function ai_calls_last_hour(uuid, text)                 to authenticated;


-- ───────────────────────────────────────────────────────────────
--  7 · Queueing now reserves, completing settles, failing releases
-- ───────────────────────────────────────────────────────────────

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
  v_hold uuid := null;        -- kept separate: a rowtype field read is not
                              -- a safe way to ask "was a hold taken?"
begin
  if not can_edit(p_account_id) then
    raise exception 'not permitted to queue work for this account';
  end if;

  -- Unchanged: an identical request already in flight returns that job.
  if p_idempotency is not null then
    select * into j from jobs
     where account_id = p_account_id
       and idempotency_key = p_idempotency
       and status in ('queued','running','succeeded')
     limit 1;
    if found then return j; end if;
  end if;

  -- Only AI work costs credits. Ingest, OCR and export are free, exactly
  -- as pricing.html says they are.
  cost := case p_kind when 'analysis' then 10 when 'reanalysis' then 10 else 0 end;

  if cost > 0 then
    select max_per_hour into cap from ai_limits where kind = 'analysis';
    cap  := coalesce(cap, 20);
    used := ai_calls_last_hour(p_account_id, 'analysis');
    if used >= cap then
      raise exception 'Hourly analysis limit reached'
        using errcode = 'CIQ03',
              detail  = json_build_object('limit', cap, 'used', used)::text;
    end if;

    -- Raises CIQ02 with the numbers in DETAIL if the balance is short.
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


create or replace function complete_job(
  p_job_id uuid, p_result jsonb
) returns void
language plpgsql security definer set search_path = public
as $$
declare j jobs;
begin
  select * into j from jobs where id = p_job_id;
  if not found then return; end if;

  update jobs
     set status = 'succeeded', progress = 100, result = p_result,
         finished_at = now(), locked_by = null, error = null
   where id = p_job_id;

  if j.kind in ('analysis','reanalysis') and j.contract_id is not null then
    update contracts
       set analysis = p_result, updated_at = now()
     where id = j.contract_id;

    insert into analyses (account_id, contract_id, analysis)
    values (j.account_id, j.contract_id, p_result);
  end if;

  -- The credits were reserved at enqueue. Charge them now, and only now.
  -- (Previously this inserted a ledger row directly, which meant a job
  -- with no reservation could still be charged, and a reservation with
  -- no job was never charged at all.)
  if j.hold_id is not null then
    perform settle_credit_hold(j.hold_id);
  end if;
end $$;


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
    -- The hold stays open across a retry. The work is still going to happen.
  else
    update jobs
       set status = 'dead', error = p_error, finished_at = now(),
           locked_by = null, progress_note = 'Failed — needs investigation'
     where id = p_job_id;

    -- Nobody pays for a job that died.
    if j.hold_id is not null then
      perform release_credit_hold(j.hold_id);
    end if;
  end if;
end $$;


-- ───────────────────────────────────────────────────────────────
--  8 · Stripe
-- ───────────────────────────────────────────────────────────────
-- Stripe delivers the same event more than once. It is a guarantee, not
-- a fault. Every event id is recorded, and a repeat is ignored.

create table if not exists stripe_events (
  id           text primary key,
  type         text,
  received_at  timestamptz default now(),
  payload      jsonb
);

create or replace function stripe_event_seen(p_id text, p_type text, p_payload jsonb default null)
returns boolean language plpgsql security definer set search_path = public
as $$
begin
  insert into stripe_events (id, type, payload) values (p_id, p_type, p_payload);
  return false;               -- first time
exception when unique_violation then
  return true;                -- already handled
end $$;

-- A buyer pays BEFORE they have a login — that is the whole point of a
-- self-serve checkout. The payment parks here until they sign up with
-- the same email, and is claimed automatically when they do.
create table if not exists pending_subscriptions (
  email                  text primary key,
  plan                   text not null,
  stripe_customer_id     text,
  stripe_subscription_id text,
  first_name             text,
  last_name              text,
  company                text,
  billing_country        text,
  vat_number             text,
  marketing_opt_in       boolean default false,
  created_at             timestamptz default now(),
  claimed_at             timestamptz,
  claimed_by_account     uuid references accounts(id) on delete set null
);

create index if not exists pending_subscriptions_unclaimed
  on pending_subscriptions (created_at desc) where claimed_at is null;

-- No RLS policy at all: nothing in a browser may read this table. It is
-- touched only by the SECURITY DEFINER functions below.
alter table pending_subscriptions enable row level security;


-- Put an account onto a plan and give it that plan's allowance.
create or replace function billing_apply_plan(
  p_account_id   uuid,
  p_plan         text,
  p_customer     text default null,
  p_subscription text default null,
  p_reset_period boolean default true
) returns void
language plpgsql security definer set search_path = public
as $$
declare allowance int;
begin
  select credits_included into allowance from plan_catalogue where plan = p_plan;
  if allowance is null then
    raise exception 'Unknown plan %', p_plan;
  end if;

  update accounts
     set plan                   = p_plan,
         credits_included       = allowance,
         credits_used           = case when p_reset_period then 0 else credits_used end,
         period_started_at      = case when p_reset_period then now() else period_started_at end,
         stripe_customer_id     = coalesce(p_customer,     stripe_customer_id),
         stripe_subscription_id = coalesce(p_subscription, stripe_subscription_id),
         billing_status         = 'active'
   where id = p_account_id;
end $$;


-- Called by the webhook when checkout completes.
create or replace function billing_checkout_completed(
  p_email        text,
  p_plan         text,
  p_customer     text,
  p_subscription text,
  p_account_id   uuid    default null,     -- set when an existing customer upgraded
  p_first_name   text    default null,
  p_last_name    text    default null,
  p_company      text    default null,
  p_country      text    default null,
  p_vat          text    default null,
  p_marketing    boolean default false
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare target uuid;
begin
  target := p_account_id;

  -- Failing that, an account already billed to this address.
  if target is null and p_email is not null then
    select id into target from accounts
     where lower(billing_email) = lower(p_email) limit 1;
  end if;

  -- Failing that, an account belonging to a user with this email.
  if target is null and p_email is not null then
    select m.account_id into target
      from auth.users u join account_members m on m.user_id = u.id
     where lower(u.email) = lower(p_email)
     order by m.account_id limit 1;
  end if;

  if target is not null then
    perform billing_apply_plan(target, p_plan, p_customer, p_subscription, true);
    update accounts
       set billing_email     = coalesce(billing_email, p_email),
           billing_country   = coalesce(p_country, billing_country),
           vat_number        = coalesce(p_vat, vat_number),
           marketing_opt_in  = coalesce(p_marketing, marketing_opt_in)
     where id = target;

    update pending_subscriptions
       set claimed_at = now(), claimed_by_account = target
     where email = lower(p_email) and claimed_at is null;

    return jsonb_build_object('applied', true, 'account_id', target);
  end if;

  -- Nobody to give it to yet. Park it against the email.
  insert into pending_subscriptions
    (email, plan, stripe_customer_id, stripe_subscription_id,
     first_name, last_name, company, billing_country, vat_number, marketing_opt_in)
  values
    (lower(p_email), p_plan, p_customer, p_subscription,
     p_first_name, p_last_name, p_company, p_country, p_vat, coalesce(p_marketing,false))
  on conflict (email) do update
     set plan = excluded.plan,
         stripe_customer_id     = excluded.stripe_customer_id,
         stripe_subscription_id = excluded.stripe_subscription_id,
         created_at = now(), claimed_at = null, claimed_by_account = null;

  return jsonb_build_object('applied', false, 'pending', true);
end $$;


-- Bought credits landing on an account.
create or replace function billing_apply_credits(
  p_account_id uuid,
  p_credits    int,
  p_reference  text default null
) returns void
language plpgsql security definer set search_path = public
as $$
begin
  update accounts
     set credits_bolton = coalesce(credits_bolton,0) + p_credits
   where id = p_account_id;

  -- Recorded negative, matching how 'topup' already worked: credit in,
  -- rather than credit consumed.
  insert into credit_ledger (account_id, kind, credits, source, contract_id)
  values (p_account_id, 'bolton_purchase', -p_credits, 'purchase', p_reference);
end $$;


-- Subscription cancelled, or payment failed for good.
create or replace function billing_subscription_ended(
  p_subscription text, p_status text default 'cancelled'
) returns void
language plpgsql security definer set search_path = public
as $$
begin
  update accounts
     set plan = 'sandbox',
         credits_included = (select credits_included from plan_catalogue where plan = 'sandbox'),
         billing_status = p_status,
         period_started_at = now()
   where stripe_subscription_id = p_subscription;
end $$;


create or replace function billing_payment_failed(
  p_subscription text, p_invoice text
) returns void
language plpgsql security definer set search_path = public
as $$
begin
  -- Flagged, not cut off. Stripe retries for days; cutting a customer's
  -- access off on the first failure is how you lose one over an expired card.
  update accounts
     set billing_status = 'past_due', last_failed_invoice = p_invoice
   where stripe_subscription_id = p_subscription;
end $$;


-- ───────────────────────────────────────────────────────────────
--  9 · Claiming a parked payment at sign-up
-- ───────────────────────────────────────────────────────────────

create or replace function claim_pending_subscription(p_user_id uuid)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare
  u_email text;
  p       pending_subscriptions;
  acct    uuid;
begin
  select email into u_email from auth.users where id = p_user_id;
  if u_email is null then return false; end if;

  select * into p from pending_subscriptions
   where email = lower(u_email) and claimed_at is null;
  if not found then return false; end if;

  select account_id into acct from account_members
   where user_id = p_user_id order by account_id limit 1;
  if acct is null then return false; end if;

  perform billing_apply_plan(acct, p.plan, p.stripe_customer_id, p.stripe_subscription_id, true);

  update accounts
     set billing_email    = coalesce(billing_email, p.email),
         billing_country  = coalesce(p.billing_country, billing_country),
         vat_number       = coalesce(p.vat_number, vat_number),
         marketing_opt_in = coalesce(p.marketing_opt_in, marketing_opt_in)
   where id = acct;

  update pending_subscriptions
     set claimed_at = now(), claimed_by_account = acct
   where email = p.email;

  return true;
end $$;

grant execute on function claim_pending_subscription(uuid) to authenticated;


-- ───────────────────────────────────────────────────────────────
-- 10 · What the app reads on sign-in
-- ───────────────────────────────────────────────────────────────
-- One call, one round trip: who am I, what plan am I on, what does that
-- plan include, and what is left. This is what replaces the compiled
-- EDITION constant.

create or replace function my_entitlement()
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  acct     uuid;
  a        record;
  pc       record;
  b        record;
  f_seat   int         := null;
  f_until  timestamptz := null;
begin
  select account_id into acct from account_members
   where user_id = auth.uid() order by account_id limit 1;
  if acct is null then
    return jsonb_build_object('ok', false, 'reason', 'no_account');
  end if;

  select * into a  from accounts where id = acct;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_account');
  end if;
  select * into pc from plan_catalogue where plan = a.plan;
  select * into b  from credits_breakdown(acct);

  -- Founding members are on Growth with their own allowance; say so, so
  -- the app can show the badge honestly. Scalars, not a record: a record
  -- variable left unassigned by a no-row SELECT throws when you read it.
  select seat_no, free_until into f_seat, f_until
    from founding_members where account_id = acct and status = 'active';

  return jsonb_build_object(
    'ok', true,
    'account_id',      acct,
    'account_name',    a.name,
    'plan',            a.plan,
    'plan_name',       coalesce(pc.name, a.plan),
    'period_days',     coalesce(pc.period_days, 30),
    'billing_status',  coalesce(a.billing_status, 'active'),
    'credits', jsonb_build_object(
      'included',    b.plan_allowance,
      'plan_left',   b.plan_left,
      'bolton_left', b.bolton_left,
      'held',        b.held,
      'total_left',  b.total_left,
      'used',        b.plan_spent
    ),
    'period_started_at', a.period_started_at,
    'founding', case when f_seat is not null
                     then jsonb_build_object('seat', f_seat, 'free_until', f_until)
                     else null end
  );
exception when undefined_table then
  -- MIGRATION_003 has not been run. Everything else still works.
  select * into a  from accounts where id = acct;
  select * into pc from plan_catalogue where plan = a.plan;
  select * into b  from credits_breakdown(acct);
  return jsonb_build_object(
    'ok', true, 'account_id', acct, 'account_name', a.name,
    'plan', a.plan, 'plan_name', coalesce(pc.name, a.plan),
    'period_days', coalesce(pc.period_days, 30),
    'billing_status', coalesce(a.billing_status,'active'),
    'credits', jsonb_build_object(
      'included', b.plan_allowance, 'plan_left', b.plan_left,
      'bolton_left', b.bolton_left, 'held', b.held,
      'total_left', b.total_left, 'used', b.plan_spent),
    'period_started_at', a.period_started_at,
    'founding', null
  );
end $$;

grant execute on function my_entitlement() to authenticated;


-- The credit statement a customer can actually read, for Settings.
create or replace view my_credit_history as
  select l.created_at,
         l.kind,
         l.source,
         case when l.credits < 0 then 'added' else 'spent' end as direction,
         abs(l.credits) as credits,
         l.contract_id
    from credit_ledger l
   where l.account_id in (select my_account_ids())
   order by l.created_at desc;

grant select on my_credit_history to authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════
--  AFTERWARDS — two things this script deliberately does NOT do
--
--  1. It does not schedule reap_stale_holds(). Add it under
--     Database → Cron as:  select reap_stale_holds();  every 15 minutes.
--     Without it, a hold from a function that timed out stays open for
--     30 minutes rather than being cleared promptly. Nothing breaks.
--
--  2. It does not roll the billing period. Stripe's
--     invoice.payment_succeeded webhook does that, by calling
--     billing_apply_plan(account, plan, …, p_reset_period => true).
-- ═══════════════════════════════════════════════════════════════
