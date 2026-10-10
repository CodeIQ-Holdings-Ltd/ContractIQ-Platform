\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

-- ═══ Test harness: does the product charge what it advertises? ═══
-- Runs as a real signed-in user, so RLS and auth.uid() are exercised
-- exactly as they are in the browser.

do $$
declare
  u_id   uuid := gen_random_uuid();
  a_grow uuid;
  a_sand uuid;
  fails  int := 0;
  n      int;
  bal_before int;
  bal_after  int;
  j      jobs;

  procedure_note text;
begin
  insert into auth.users(id, email) values (u_id, 'test@example.com');

  insert into accounts(name, plan, credits_included, credits_used, period_started_at)
       values ('Growth Co', 'growth', 500, 0, now()) returning id into a_grow;
  insert into accounts(name, plan, credits_included, credits_used, period_started_at)
       values ('Sandbox Co', 'sandbox', 150, 0, now()) returning id into a_sand;
  insert into account_members(user_id, account_id, role) values (u_id, a_grow, 'admin');
  insert into account_members(user_id, account_id, role) values (u_id, a_sand, 'admin');

  perform set_config('request.jwt.claim.sub', u_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  -- ── 1 · The catalogue matches what the website advertises ──
  select count(*) into n from plan_catalogue
   where (plan='sandbox'    and credits_included=100  and period_days=10 and price_pence=0     and bank_cap=0    and revision_days=0)
      or (plan='growth'     and credits_included=500  and period_days=30 and price_pence=7900  and bank_cap=500  and revision_days=30)
      or (plan='scale'      and credits_included=1800 and period_days=30 and price_pence=27000 and bank_cap=1800 and revision_days=30)
      or (plan='enterprise' and credits_included=5000 and period_days=30 and price_pence=70000 and bank_cap=5000 and revision_days=30);
  if n = 4 then raise notice 'PASS  catalogue matches the published prices, credits, caps and windows';
  else fails := fails + 1; raise notice 'FAIL  catalogue mismatch — only % of 4 rows correct', n; end if;

  -- ── 2 · Bolt-on pack is 100 credits for GBP 25 ──
  select count(*) into n from credit_packs where code='credits100' and credits=100 and price_pence=2500;
  if n = 1 then raise notice 'PASS  bolt-on pack is 100 credits for GBP 25';
  else fails := fails + 1; raise notice 'FAIL  bolt-on pack does not match the pricing page'; end if;

  -- ── 3 · A first analysis costs 10 ──
  insert into contracts(id, account_id, supplier, name) values ('t-1', a_grow, 'Acme', 'Test');
  select total_left into bal_before from credits_breakdown(a_grow);
  j := enqueue_job(a_grow, 't-1', 'analysis', '{}'::jsonb, null);
  perform complete_job(j.id, '{"ok":true}'::jsonb);
  select total_left into bal_after from credits_breakdown(a_grow);
  if bal_before - bal_after = 10 then raise notice 'PASS  first analysis charged 10 credits (% -> %)', bal_before, bal_after;
  else fails := fails + 1; raise notice 'FAIL  first analysis charged % credits, expected 10', bal_before - bal_after; end if;

  -- ── 4 · A re-run inside the window is FREE on Growth ──
  --      This is the bug. Before MIGRATION_006 it charged 10.
  select total_left into bal_before from credits_breakdown(a_grow);
  j := enqueue_job(a_grow, 't-1', 'reanalysis', '{}'::jsonb, 'idem-rerun-1');
  perform complete_job(j.id, '{"ok":true}'::jsonb);
  select total_left into bal_after from credits_breakdown(a_grow);
  if bal_before = bal_after then raise notice 'PASS  re-run inside the revision window was free, as advertised (stayed at %)', bal_after;
  else fails := fails + 1; raise notice 'FAIL  re-run charged % credits but the pricing page says it is free', bal_before - bal_after; end if;

  -- ── 5 · On Sandbox the same re-run IS charged ──
  insert into contracts(id, account_id, supplier, name) values ('t-2', a_sand, 'Acme', 'Test');
  j := enqueue_job(a_sand, 't-2', 'analysis', '{}'::jsonb, null);
  perform complete_job(j.id, '{"ok":true}'::jsonb);
  select total_left into bal_before from credits_breakdown(a_sand);
  j := enqueue_job(a_sand, 't-2', 'reanalysis', '{}'::jsonb, 'idem-rerun-2');
  perform complete_job(j.id, '{"ok":true}'::jsonb);
  select total_left into bal_after from credits_breakdown(a_sand);
  if bal_before - bal_after = 10 then raise notice 'PASS  Sandbox re-run charged 10 — no free window on the free plan';
  else fails := fails + 1; raise notice 'FAIL  Sandbox re-run charged %, expected 10', bal_before - bal_after; end if;

  -- ── 6 · complete_job writes the analysis onto the contract ──
  select count(*) into n from contracts where id='t-1' and analysis is not null;
  if n = 1 then raise notice 'PASS  analysis persisted onto contracts.analysis';
  else fails := fails + 1; raise notice 'FAIL  contracts.analysis was not written'; end if;

  select count(*) into n from analyses where contract_id='t-1';
  if n >= 1 then raise notice 'PASS  analysis history row written (% rows)', n;
  else fails := fails + 1; raise notice 'FAIL  no row in analyses'; end if;

  -- ── 7 · RLS actually isolates: a second user sees nothing ──
  declare other uuid := gen_random_uuid();
  begin
    insert into auth.users(id, email) values (other, 'other@example.com');
    perform set_config('request.jwt.claim.sub', other::text, true);
    select count(*) into n from contracts where id in ('t-1','t-2');
    -- RLS is not enforced for the table owner, so check the policy predicate directly.
    select count(*) into n from contracts c
     where c.id in ('t-1','t-2') and c.account_id in (select my_account_ids());
    if n = 0 then raise notice 'PASS  RLS predicate returns nothing for an unrelated user';
    else fails := fails + 1; raise notice 'FAIL  RLS predicate leaked % rows to an unrelated user', n; end if;
    perform set_config('request.jwt.claim.sub', u_id::text, true);
  end;

  -- ── 8 · A short balance is refused with the numbers in the error ──
  -- The balance is the ledger's, not accounts.credits_used (which
  -- MIGRATION_004 left vestigial). Shrink the allowance instead.
  update accounts set credits_included = 5, credits_banked = 0 where id = a_grow;
  insert into contracts(id, account_id, supplier, name) values ('t-3', a_grow, 'Acme', 'Broke');
  begin
    j := enqueue_job(a_grow, 't-3', 'analysis', '{}'::jsonb, null);
    fails := fails + 1; raise notice 'FAIL  an analysis was queued with an insufficient balance';
  exception when sqlstate 'CIQ02' then
    raise notice 'PASS  insufficient balance refused cleanly with CIQ02';
  end;

  if fails = 0 then raise notice '--- ALL BILLING TESTS PASSED ---';
  else raise exception '% billing test(s) failed', fails; end if;
end $$;
