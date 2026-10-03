\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

-- ═══ Test harness: MIGRATION_007 — data safety and locked back office ═══
-- Run on a database that has SETUP + 003..007 applied (see TEST_local_shim.sql).

-- ── Part A · the public API roles cannot reach the back office ──────
do $$
declare
  fails int := 0;
  f text;
begin
  foreach f in array array[
    'billing_apply_credits(uuid,integer,text)',
    'settle_credit_hold(uuid)', 'release_credit_hold(uuid)',
    'complete_job(uuid,jsonb)', 'fail_job(uuid,text,boolean)', 'claim_job(text,text[])',
    'dispatch_jobs()', 'refresh_founding_credits()', 'convert_expired_founding()'
  ] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
      fails := fails + 1; raise notice 'FAIL  % is still callable by the public API', f;
    end if;
    if not has_function_privilege('service_role', f, 'execute') then
      fails := fails + 1; raise notice 'FAIL  % is no longer callable by the server', f;
    end if;
  end loop;
  -- billing_apply_plan's signature has changed across migrations; check every overload.
  if exists (select 1 from pg_proc p where p.proname = 'billing_apply_plan'
               and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))) then
    fails := fails + 1; raise notice 'FAIL  billing_apply_plan is still callable by the public API';
  end if;
  -- What customers legitimately call must still work.
  foreach f in array array['enqueue_job(uuid,text,text,jsonb,text)', 'my_entitlement()', 'authorise_ai_call(uuid,text,integer,text,text)',
                           'reanalysis_is_free(uuid,text)', 'my_workspace_settings()', 'set_zero_retention(uuid,boolean)',
                           'record_terms_acceptance(text)'] loop
    begin
      if not has_function_privilege('authenticated', f, 'execute') then
        fails := fails + 1; raise notice 'FAIL  % was locked, but the app needs it', f;
      end if;
    exception when undefined_function then
      raise notice 'note  % not present with that signature — skipped', f;
    end;
  end loop;
  if not has_function_privilege('anon', 'founding_places_remaining()', 'execute') then
    fails := fails + 1; raise notice 'FAIL  the public founding-places counter was locked';
  end if;
  if fails = 0 then raise notice 'PASS  back-office functions answer to the server only; customer functions still open'; end if;
end $$;

-- A real attempt, as the public role, to hand out free credits.
set role authenticated;
do $$
begin
  perform billing_apply_credits(gen_random_uuid(), 100000, 'free money');
  raise notice 'FAIL  a signed-in user could call billing_apply_credits';
exception when insufficient_privilege then
  raise notice 'PASS  a signed-in user calling billing_apply_credits is refused (permission denied)';
end $$;
reset role;

-- ── Part B · behaviour ─────────────────────────────────────────────
do $$
declare
  fails  int := 0;
  u_a    uuid := gen_random_uuid();
  u_b    uuid := gen_random_uuid();
  a_a    uuid; a_b uuid; a_ent uuid;
  j      jobs;
  n      int;
  t      text;
  r      jsonb;
  ok     boolean;
  bal_before int; bal_after int;
begin
  -- New sign-ups get the catalogue's Sandbox allowance: 100. (With the
  -- founding offer closed — while it is open, the first ten get 200.)
  update founding_offer set offer_open = false where id = 1;
  insert into auth.users(id, email, raw_user_meta_data) values (u_a, 'alice@alpha.test', '{"company":"Alpha"}');
  insert into auth.users(id, email, raw_user_meta_data) values (u_b, 'bob@beta.test',   '{"company":"Beta"}');
  select account_id into a_a from account_members where user_id = u_a;
  select account_id into a_b from account_members where user_id = u_b;
  select credits_included into n from accounts where id = a_a;
  if n = 100 then raise notice 'PASS  a new sign-up receives 100 Sandbox credits';
  else fails := fails + 1; raise notice 'FAIL  new sign-up received % credits, expected 100', n; end if;

  -- Move Alpha to Growth so it has room to work; Beta stays as it is.
  update accounts set plan = 'growth', credits_included = 500, credits_used = 0, period_started_at = now() where id = a_a;

  -- Data region defaults to EU and refuses anything else.
  select data_region into t from accounts where id = a_a;
  if t = 'eu' then raise notice 'PASS  a workspace defaults to the EU data region';
  else fails := fails + 1; raise notice 'FAIL  default data region is %', t; end if;
  begin
    update accounts set data_region = 'global' where id = a_a;
    fails := fails + 1; raise notice 'FAIL  data_region accepted "global"';
  exception when check_violation then
    raise notice 'PASS  data_region refuses "global"';
  end;

  insert into contracts(id, account_id, supplier, name) values ('c-alpha', a_a, 'Acme', 'Alpha contract');
  insert into contracts(id, account_id, supplier, name, analysis) values ('c-beta', a_b, 'Beta Ltd', 'Beta contract', '{"beta":"original"}');

  -- Act as Alice from here on.
  perform set_config('request.jwt.claim.sub', u_a::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  -- 1 · The queued contract text is deleted when the job finishes.
  j := enqueue_job(a_a, 'c-alpha', 'analysis', '{"context":"CONFIDENTIAL CONTRACT TEXT","stages":[]}'::jsonb, 'idem-a1');
  perform complete_job(j.id, '{"extracted":{"name":"x"}}'::jsonb);
  select payload::text into t from jobs where id = j.id;
  if t = '{}' then raise notice 'PASS  finished job no longer holds the contract text';
  else fails := fails + 1; raise notice 'FAIL  finished job still holds: %', left(t, 60); end if;

  -- 2 · A job that dies lets go of the text AND the credits.
  select total_left into bal_before from credits_breakdown(a_a);
  j := enqueue_job(a_a, 'c-alpha', 'analysis', '{"context":"MORE CONFIDENTIAL TEXT","stages":[]}'::jsonb, 'idem-a2');
  perform fail_job(j.id, '400 bad request', false);
  select payload::text into t from jobs where id = j.id;
  select total_left into bal_after from credits_breakdown(a_a);
  if t = '{}' and bal_after = bal_before then raise notice 'PASS  a dead job is emptied and its credits released';
  else fails := fails + 1; raise notice 'FAIL  dead job payload=% balance % -> %', left(t, 40), bal_before, bal_after; end if;

  -- 3 · Alice cannot queue work against Beta's contract.
  begin
    j := enqueue_job(a_a, 'c-beta', 'analysis', '{}'::jsonb, 'idem-a3');
    fails := fails + 1; raise notice 'FAIL  Alice queued work on Beta''s contract';
  exception when sqlstate 'CIQ04' then
    raise notice 'PASS  queueing against another workspace''s contract is refused (CIQ04)';
  end;

  -- 4 · Even a job that names Beta's contract cannot overwrite it.
  insert into jobs(account_id, contract_id, kind, payload, status) values (a_a, 'c-beta', 'analysis', '{}', 'running') returning * into j;
  perform complete_job(j.id, '{"hijacked":true}'::jsonb);
  select analysis::text into t from contracts where id = 'c-beta';
  if t = '{"beta": "original"}' then raise notice 'PASS  a job cannot write onto another workspace''s contract';
  else fails := fails + 1; raise notice 'FAIL  Beta''s contract now reads %', t; end if;

  -- 5 · A contract not saved yet cannot be queued at all (the app then
  --     runs it in the browser instead), so nothing can be orphaned.
  begin
    j := enqueue_job(a_a, 'c-unsaved', 'analysis', '{"context":"x","stages":[]}'::jsonb, 'idem-a5');
    fails := fails + 1; raise notice 'FAIL  a job was queued for a contract that does not exist';
  exception when foreign_key_violation then
    raise notice 'PASS  a contract that is not saved yet cannot be queued';
  end;

  -- 6 · Browser-path charge counts towards the free re-run window.
  insert into contracts(id, account_id, supplier) values ('c-browser', a_a, 'Browser Co');
  r := authorise_ai_call(a_a, 'analysis', 10, 'c-browser', 'run-browser-1');
  perform settle_credit_hold((r->>'hold_id')::uuid);
  select reanalysis_is_free(a_a, 'c-browser') into ok;
  if ok then raise notice 'PASS  an analysis run in the browser makes its re-run free';
  else fails := fails + 1; raise notice 'FAIL  browser-path analysis did not open the revision window'; end if;

  -- 7 · authorise_ai_call refuses a workspace you are not in.
  r := authorise_ai_call(a_b, 'analysis', 10, 'c-beta', 'run-x');
  if r->>'reason' = 'forbidden' then raise notice 'PASS  cannot reserve another workspace''s credits';
  else fails := fails + 1; raise notice 'FAIL  authorise_ai_call on a foreign account returned %', r; end if;

  -- 8 · Zero-Retention: Enterprise only, admin only, enforced by the database.
  begin
    perform set_zero_retention(a_a, true);
    fails := fails + 1; raise notice 'FAIL  Growth workspace switched on Zero-Retention';
  exception when sqlstate 'CIQ05' then
    raise notice 'PASS  Zero-Retention refused on Growth (Enterprise feature)';
  end;
  update accounts set plan = 'enterprise' where id = a_a;
  insert into documents(id, account_id, contract_id, name, extracted_text) values ('d-before', a_a, 'c-alpha', 'before.pdf', 'TEXT STORED BEFORE');
  perform set_zero_retention(a_a, true);
  select zero_retention into ok from accounts where id = a_a;
  r := my_workspace_settings();
  if ok and (r->>'zero_retention')::boolean and r->>'data_region' = 'eu' then raise notice 'PASS  Zero-Retention saved per workspace and read back';
  else fails := fails + 1; raise notice 'FAIL  settings read back as %', r; end if;

  insert into documents(id, account_id, contract_id, name, extracted_text) values ('d-after', a_a, 'c-alpha', 'after.pdf', 'SHOULD NEVER BE STORED');
  select extracted_text into t from documents where id = 'd-after';
  if t is null then raise notice 'PASS  with Zero-Retention on, the database refuses to store document text';
  else fails := fails + 1; raise notice 'FAIL  document text stored: %', t; end if;

  j := enqueue_job(a_a, 'c-alpha', 'analysis', '{"context":"x","stages":[]}'::jsonb, 'idem-a8');
  perform complete_job(j.id, '{"done":true}'::jsonb);
  select extracted_text into t from documents where id = 'd-before';
  if t is null then raise notice 'PASS  text stored before Zero-Retention is removed once the contract is analysed';
  else fails := fails + 1; raise notice 'FAIL  old text survived the analysis: %', t; end if;

  if fails = 0 then raise notice '--- ALL DATA-SAFETY TESTS PASSED ---';
  else raise exception '% DATA-SAFETY TEST(S) FAILED', fails; end if;
end $$;
