-- ═══════════════════════════════════════
--  ContractIQ · MIGRATION 009 · The Sandbox runs for 10 days
--  CodeIQ Holdings Ltd · 10 October 2026
--
--  Run AFTER MIGRATION 008. Safe to run more than once.
--
--  WHAT THIS DOES, IN PLAIN ENGLISH
--
--  The free Evaluation Sandbox was 100 credits or 90 days, whichever came
--  first. The window is now TEN days. Nothing else changes: it is still a
--  one-off 100 credits, it still ends the moment they are spent, and the
--  workspace is still read-only afterwards until a plan is bought.
--
--  This is the only place the number lives. credits_breakdown() and
--  my_entitlement(), written in 008, both read plan_catalogue.period_days,
--  so changing this row changes the product, the credit balance, the
--  "ends in N days" banner and the server's refusal together.
--
--  WHO THIS AFFECTS IMMEDIATELY
--  Any existing Sandbox workspace created more than ten days ago becomes
--  read-only the moment this runs. On a pre-launch project that is nobody
--  or almost nobody — check before you run it if you are not sure:
--
--    select count(*) from accounts
--     where plan = 'sandbox' and period_started_at < now() - interval '10 days';
-- ═══════════════════════════════════════

begin;

update plan_catalogue
   set period_days = 10,
       updated_at  = now()
 where plan = 'sandbox'
   and period_days <> 10;

commit;

-- ── How to check it worked ───────────────────────────────────────
-- 1. select plan, credits_included, period_days from plan_catalogue where plan = 'sandbox';
--      → sandbox | 100 | 10
--
-- 2. As a signed-in Sandbox user:  select (my_entitlement()) -> 'sandbox';
--      → ends_at is ten days after that workspace was created
