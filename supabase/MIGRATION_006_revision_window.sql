-- ═══════════════════════════════════════════════════════════════
--  MIGRATION 006 · Honour the revision window in the database
--
--  Run this in the Supabase SQL editor after MIGRATION_005.
--  Safe to run more than once.
--
--  WHAT THIS FIXES, AND WHY IT MATTERED
--
--  pricing.html promises, in its own panel:
--
--      "0 credits — Re-running an analysis on the same record inside
--       your revision window, on paid plans. Refining is free."
--
--  The app believed it too: EDITIONS carries revisionDays 30 on every
--  paid plan and CREDIT_COST.revision is 0, so the button said the
--  re-run was free and the balance on screen did not move.
--
--  The database disagreed. enqueue_job charged a flat ten credits:
--
--      cost := case p_kind when 'analysis'   then 10
--                          when 'reanalysis' then 10
--                          else 0 end;
--
--  So a customer was told a re-run was free, shown a balance that had
--  not changed, and charged ten credits anyway. Refine a contract four
--  times and forty credits have gone with nothing on screen to explain
--  it. That is a billing fault, not a display one, and it is the sort
--  that surfaces as a refund request rather than a bug report.
--
--  The window is now data, held on the plan alongside everything else,
--  and the decision is taken in the database where it cannot be talked
--  out of by the browser.
-- ═══════════════════════════════════════════════════════════════

begin;

-- ── 1 · How long a re-run stays free, per plan ───────────────────────
-- These four values are exactly what the app's EDITIONS table already
-- shows the user, so screen and ledger now say the same thing. Sandbox
-- is zero deliberately: on a free evaluation plan every run is charged,
-- which is what stops the sandbox being used as unmetered analysis.
alter table plan_catalogue
  add column if not exists revision_days int not null default 0;

update plan_catalogue set revision_days = 0,  updated_at = now()
 where plan = 'sandbox'    and revision_days <> 0;
update plan_catalogue set revision_days = 30, updated_at = now()
 where plan = 'growth'     and revision_days <> 30;
update plan_catalogue set revision_days = 30, updated_at = now()
 where plan = 'scale'      and revision_days <> 30;
update plan_catalogue set revision_days = 30, updated_at = now()
 where plan = 'enterprise' and revision_days <> 30;

-- ── 2 · Is this particular re-run inside the window? ────────────────
-- True only when the plan grants a window AND this contract already has
-- a completed analysis inside it. A first analysis is never a revision,
-- so the free path cannot be used to get the first run for nothing.
create or replace function reanalysis_is_free(
  p_account_id  uuid,
  p_contract_id text
) returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select pc.revision_days > 0
            and exists (
              select 1 from analyses an
               where an.account_id  = p_account_id
                 and an.contract_id = p_contract_id
                 and an.created_at >= now() - make_interval(days => pc.revision_days)
            )
       from accounts a
       join plan_catalogue pc on pc.plan = a.plan
      where a.id = p_account_id),
    false)
$$;

grant execute on function reanalysis_is_free(uuid, text) to authenticated;

-- ── 3 · Charge accordingly ──────────────────────────────────────────
-- Recreated in full because Postgres replaces a function body whole.
-- Only two things differ from MIGRATION_004: the cost line below, and
-- the rate limit, which used to sit inside `if cost > 0`. A free re-run
-- still calls the model and still costs real money at the API, so it
-- must still be counted against the hourly cap — otherwise making
-- revisions free would have opened an unmetered path straight to the
-- AI provider.
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
  -- as pricing.html says they are — and so is a re-run inside the window.
  cost := case
            when p_kind = 'analysis'   then 10
            when p_kind = 'reanalysis' then
              case when reanalysis_is_free(p_account_id, p_contract_id)
                   then 0 else 10 end
            else 0
          end;

  -- The cap applies to the AI call, not to the charge.
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

commit;

-- ── How to check it worked ──────────────────────────────────────────
-- 1.  select plan, credits_included, price_pence, bank_cap, revision_days
--       from plan_catalogue order by sort_order;
--     Expect: sandbox 150/0/0/0, growth 500/7900/500/30,
--             scale 1800/27000/1800/30, enterprise 5000/70000/5000/30.
--
-- 2.  Run an analysis on a contract, let it finish, then re-run it.
--     On Growth the balance should not move the second time, and
--     credit_ledger should gain no row for the re-run.
--
-- 3.  On the Sandbox plan the same re-run should cost ten credits,
--     because revision_days is zero there.
