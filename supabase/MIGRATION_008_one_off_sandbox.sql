-- ═══════════════════════════════════════
--  ContractIQ · MIGRATION 008 · One-off Sandbox, no founding offer
--  CodeIQ Holdings Ltd · 6 October 2026
--
--  Run AFTER SETUP.sql and MIGRATIONS 003 to 007. Safe to run more than once.
--
--  WHAT THIS DOES, IN PLAIN ENGLISH
--
--   1. The Evaluation Sandbox is now a ONE-OFF 100 credits. It ends when the
--      credits are used or after the window in plan_catalogue.period_days,
--      whichever comes first. (Migration 009 sets that window to 10 days.)
--      After that the workspace is read-only: the customer can still open
--      and export what they have, but cannot run new analyses or ask Cedric
--      until they buy a plan. (Until now nothing ever expired it, and the
--      pricing page wrongly said "every 90 days".)
--   2. A subscription that ends no longer drops the account onto a fresh
--      100 credits. It drops to the Sandbox plan with none, so read-only.
--      Bought bolt-on credits are never touched.
--   3. The founding offer (ten places, 200 credits a month for six months)
--      is withdrawn: new sign-ups no longer claim a seat. Existing founding
--      rows, if any, are left as the audit trail and are unaffected.
--   4. A subscription bought BEFORE signing up is now actually claimed.
--      claim_pending_subscription() has existed since migration 004 and
--      nothing ever called it, so the ordinary self-serve journey — pay on
--      the pricing page, then create a login — left the customer on the free
--      Sandbox having just been charged. Sign-up now calls it. Anyone already
--      in that position is fixed by the back-fill at the end of this file.
--
--  NOTE: any Sandbox account created more than 90 days ago becomes
--  read-only the moment this runs. That is the intent.
-- ═══════════════════════════════════════

begin;

-- ── 1 · The Sandbox expires ─────────────────────────────────────────
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
    select case
             when ac.plan = 'sandbox'
              and now() >= coalesce(ac.period_started_at, now())
                           + make_interval(days => coalesce(pc.period_days, 90))
             then 0
             else coalesce(ac.credits_included,0) + coalesce(ac.credits_banked,0)
           end as allowance,
           coalesce(ac.credits_bolton,0) as bolton,
           coalesce(ac.period_started_at, now()) as period_start
      from accounts ac
      left join plan_catalogue pc on pc.plan = ac.plan
     where ac.id = acct
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
grant execute on function credits_breakdown(uuid) to authenticated;

-- ── 2 · What the app reads: says whether the Sandbox has ended ──────
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
  sb       jsonb       := null;
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
  -- The Evaluation Sandbox is a one-off allowance: it ends when it is used
  -- up or when its period has run out, whichever is first. The app reads
  -- this to show the upgrade prompt; the server enforces it regardless.
  if a.plan = 'sandbox' then
    sb := jsonb_build_object(
      'ends_at', coalesce(a.period_started_at, now()) + make_interval(days => coalesce(pc.period_days, 90)),
      'ended',   now() >= coalesce(a.period_started_at, now()) + make_interval(days => coalesce(pc.period_days, 90)),
      'one_off', true);
  end if;
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
    'sandbox', sb,
    'founding', case when f_seat is not null
                     then jsonb_build_object('seat', f_seat, 'free_until', f_until)
                     else null end
  );
exception when undefined_table then
  -- MIGRATION_003 has not been run. Everything else still works.
  select * into a  from accounts where id = acct;
  select * into pc from plan_catalogue where plan = a.plan;
  -- The Evaluation Sandbox is a one-off allowance: it ends when it is used
  -- up or when its period has run out, whichever is first. The app reads
  -- this to show the upgrade prompt; the server enforces it regardless.
  if a.plan = 'sandbox' then
    sb := jsonb_build_object(
      'ends_at', coalesce(a.period_started_at, now()) + make_interval(days => coalesce(pc.period_days, 90)),
      'ended',   now() >= coalesce(a.period_started_at, now()) + make_interval(days => coalesce(pc.period_days, 90)),
      'one_off', true);
  end if;
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
    'sandbox', sb,
    'founding', null
  );
end $$;
grant execute on function my_entitlement() to authenticated;

-- ── 3 · A lapsed subscription is read-only, not a fresh Sandbox ─────
create or replace function billing_subscription_ended(
  p_subscription text, p_status text default 'cancelled'
) returns void
language plpgsql security definer set search_path = public
as $$
begin
  update accounts
     set plan              = 'sandbox',
         credits_included  = 0,
         credits_banked    = 0,
         billing_status    = p_status,
         period_started_at = now()
   where stripe_subscription_id = p_subscription;
end $$;

-- ── 4 · Sign-up: no founding offer, and claim anything already paid for ──
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

  -- If they paid before creating this login, the webhook parked the
  -- subscription against their email. Hand it over now. Wrapped, because a
  -- failure here must never stop someone signing up: the back-office query
  -- at the bottom of this file finds anything left behind.
  begin
    perform claim_pending_subscription(new.id);
  exception when others then
    raise warning 'claim_pending_subscription failed for %: %', new.email, sqlerrm;
  end;

  return new;
end $$;

-- ── 5 · Back-fill: anyone who paid and was left on the Sandbox ──────
-- Safe to run more than once; it only touches unclaimed rows.
do $$
declare u record; n int := 0;
begin
  for u in
    select au.id, au.email
      from pending_subscriptions ps
      join auth.users au on lower(au.email) = ps.email
     where ps.claimed_at is null
  loop
    if claim_pending_subscription(u.id) then n := n + 1; end if;
  end loop;
  if n > 0 then raise notice 'claimed % paid subscription(s) that were stranded on the Sandbox', n; end if;
end $$;

commit;

-- ── How to check it worked ───────────────────────────────────────
-- 1. select (my_entitlement()) -> 'sandbox';     -- as a signed-in Sandbox user
--      → {"ends_at": "...", "ended": false, "one_off": true}
-- 2. update accounts set period_started_at = now() - interval '91 days' where id = '<test acct>';
--    select * from credits_breakdown('<test acct>');
--      → plan_allowance 0, total_left 0 (plus any bolt-on credits)
-- 3. select prosrc like '%claim_founding_seat%' from pg_proc where proname = 'handle_new_user';
--      → false
-- 4. select email, plan, claimed_at from pending_subscriptions order by created_at desc;
--      → every row that has a matching sign-up has a claimed_at
