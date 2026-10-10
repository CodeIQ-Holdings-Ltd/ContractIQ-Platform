\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

-- ═══ Test: the Sandbox is a one-off, then read-only; no founding seat ═══
-- Run after SETUP and MIGRATIONS 003 to 009 on a LOCAL Postgres only.

do $$
declare
  u_new  uuid := gen_random_uuid();
  u_id   uuid := gen_random_uuid();
  a_new  uuid;
  a_sand uuid;
  a_paid uuid;
  fails  int := 0;
  r      record;
  ent    jsonb;
  n      int;
  j      jobs;
  refused boolean;
  u_pay  uuid := gen_random_uuid();
  a_pay  uuid;
  declare_block text;
begin
  -- 1 · A brand-new sign-up gets the Sandbox allowance and NO founding seat
  insert into auth.users(id, email, raw_user_meta_data) values (u_new, 'new@newco.test', '{"company":"NewCo"}');
  select a.id into a_new from accounts a join account_members m on m.account_id = a.id where m.user_id = u_new;
  select * into r from credits_breakdown(a_new);
  if r.total_left = 100 then raise notice 'PASS  a new sign-up starts with 100 Sandbox credits';
  else fails := fails + 1; raise notice 'FAIL  new sign-up has % credits, expected 100', r.total_left; end if;
  select count(*) into n from founding_members where account_id = a_new;
  if n = 0 then raise notice 'PASS  sign-up no longer claims a founding seat';
  else fails := fails + 1; raise notice 'FAIL  sign-up claimed a founding seat'; end if;

  -- 2 · An active Sandbox reports that it is one-off and has not ended
  -- Signing up creates the workspace (the real path); age it by hand.
  insert into auth.users(id, email) values (u_id, 'tester@example.com');
  select m.account_id into a_sand from account_members m where m.user_id = u_id;
  update accounts set period_started_at = now() - interval '3 days' where id = a_sand;
  perform set_config('request.jwt.claim.sub', u_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  ent := my_entitlement();
  if (ent->'sandbox'->>'one_off')::boolean and not (ent->'sandbox'->>'ended')::boolean then
    raise notice 'PASS  at day 3 the Sandbox is one-off and has not ended';
  else fails := fails + 1; raise notice 'FAIL  entitlement at day 3: %', ent->'sandbox'; end if;

  -- 3 · After 10 days the allowance is gone, even though none was used
  update accounts set period_started_at = now() - interval '11 days' where id = a_sand;
  select * into r from credits_breakdown(a_sand);
  if r.plan_allowance = 0 and r.total_left = 0 then raise notice 'PASS  after 10 days the Sandbox allowance is zero (unused credits expire)';
  else fails := fails + 1; raise notice 'FAIL  after 10 days: allowance %, left %', r.plan_allowance, r.total_left; end if;
  ent := my_entitlement();
  if (ent->'sandbox'->>'ended')::boolean then raise notice 'PASS  the app is told the Sandbox has ended';
  else fails := fails + 1; raise notice 'FAIL  entitlement says the Sandbox has not ended'; end if;

  -- 4 · And the server refuses new work
  insert into contracts(id, account_id, supplier, name) values ('s-' || u_id::text, a_sand, 'Acme', 'Test');
  refused := false;
  begin
    j := enqueue_job(a_sand, 's-' || u_id::text, 'analysis', '{}'::jsonb, null);
  exception when others then refused := true; end;
  if refused then raise notice 'PASS  an ended Sandbox cannot queue an analysis';
  else fails := fails + 1; raise notice 'FAIL  an ended Sandbox queued an analysis'; end if;

  -- 5 · Bought credits survive the end of the Sandbox
  update accounts set credits_bolton = 100 where id = a_sand;
  select * into r from credits_breakdown(a_sand);
  if r.total_left = 100 and r.plan_left = 0 then raise notice 'PASS  bought bolt-on credits still work after the Sandbox ends';
  else fails := fails + 1; raise notice 'FAIL  bolt-on after expiry: total %, plan %', r.total_left, r.plan_left; end if;

  -- 6 · Using the 100 credits up ends it early (before day 10)
  update accounts set period_started_at = now() - interval '2 days', credits_bolton = 0 where id = a_sand;
  insert into credit_ledger(account_id, kind, credits, source, reason) values (a_sand, 'analysis', 100, 'plan', 'test spend');
  select * into r from credits_breakdown(a_sand);
  if r.total_left = 0 then raise notice 'PASS  spending all 100 credits ends the Sandbox before day 10';
  else fails := fails + 1; raise notice 'FAIL  after spending 100, % left', r.total_left; end if;

  -- 7 · A lapsed subscription is read-only, not a fresh 100 credits
  insert into accounts(name, plan, credits_included, period_started_at, stripe_subscription_id)
       values ('Lapsing Co', 'growth', 500, now() - interval '40 days', 'sub_test_lapse') returning id into a_paid;
  perform billing_subscription_ended('sub_test_lapse', 'cancelled');
  select * into r from credits_breakdown(a_paid);
  if r.total_left = 0 and (select plan from accounts where id = a_paid) = 'sandbox'
    then raise notice 'PASS  a cancelled subscription drops to a read-only Sandbox with no credits';
  else fails := fails + 1; raise notice 'FAIL  cancelled subscription left % credits', r.total_left; end if;

  -- 8 · Pay first, sign up second: the subscription must follow them in
  declare_block := null;
  perform billing_checkout_completed('payer@newfirm.test', 'growth', 'cus_x', 'sub_x');
  select count(*) into n from pending_subscriptions where email = 'payer@newfirm.test' and claimed_at is null;
  if n = 1 then raise notice 'PASS  a payment with no account yet is parked against the email';
  else fails := fails + 1; raise notice 'FAIL  payment was not parked (% rows)', n; end if;

  insert into auth.users(id, email, raw_user_meta_data)
       values (u_pay, 'payer@newfirm.test', '{"company":"NewFirm"}');
  select a.id into a_pay from accounts a
    join account_members m on m.account_id = a.id where m.user_id = u_pay;
  if (select plan from accounts where id = a_pay) = 'growth'
     and (select credits_included from accounts where id = a_pay) = 500
    then raise notice 'PASS  signing up after paying puts them straight onto the plan they bought';
  else fails := fails + 1; raise notice 'FAIL  paid-then-signed-up account is on % with % credits',
       (select plan from accounts where id = a_pay), (select credits_included from accounts where id = a_pay); end if;
  select count(*) into n from pending_subscriptions where email = 'payer@newfirm.test' and claimed_at is null;
  if n = 0 then raise notice 'PASS  the parked payment is marked claimed, so it cannot be claimed twice';
  else fails := fails + 1; raise notice 'FAIL  parked payment still unclaimed'; end if;
  if (select stripe_subscription_id from accounts where id = a_pay) = 'sub_x'
    then raise notice 'PASS  the Stripe subscription is attached, so renewals and cancellation find the account';
  else fails := fails + 1; raise notice 'FAIL  subscription id not attached'; end if;

  if fails = 0 then raise notice '--- ALL SANDBOX TESTS PASSED ---';
  else raise exception '% SANDBOX TEST(S) FAILED', fails; end if;
end $$;
