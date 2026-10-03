-- ═══════════════════════════════════════════════════════════════════════
-- ContractIQ Platform · Migration 005
-- Credit roll-over, and two names made consistent
-- CodeIQ Holdings Ltd · September 2026
--
-- WHY THIS EXISTS
--
-- The pricing page has promised roll-over in six places since launch:
-- "Unused credits roll over, up to 500" on Growth, "up to 1,800" on Scale.
-- The column to hold it (accounts.credits_banked) was created in SETUP.sql
-- and is already counted in every balance the customer sees — but nothing
-- ever wrote to it. billing_apply_plan reset credits_used to zero at each
-- renewal and the remainder was silently destroyed.
--
-- That is a term of sale the product was not honouring. This migration
-- makes it true.
--
-- Run it AFTER MIGRATION_004. It is re-runnable: run it twice and the
-- second run changes nothing.
-- ═══════════════════════════════════════════════════════════════════════

begin;

-- ── 1 · How much each plan may bank ──────────────────────────────────
-- The cap is one period's allowance. You can carry a full month forward,
-- but you cannot hoard six months and then run the estate through in a
-- weekend — which is the cost exposure a cap exists to close.
alter table plan_catalogue add column if not exists bank_cap int not null default 0;

update plan_catalogue set bank_cap = 0,    updated_at = now() where plan = 'sandbox'    and bank_cap <> 0;
update plan_catalogue set bank_cap = 500,  updated_at = now() where plan = 'growth'     and bank_cap <> 500;
update plan_catalogue set bank_cap = 1800, updated_at = now() where plan = 'scale'      and bank_cap <> 1800;
update plan_catalogue set bank_cap = 5000, updated_at = now() where plan = 'enterprise' and bank_cap <> 5000;

-- ── 2 · The name on the receipt ──────────────────────────────────────
-- create-checkout-session puts plan_catalogue.name on the Stripe line item,
-- so a customer who bought "Enterprise Suite" was receipted for
-- "Enterprise". Same product, two names, one confused accounts payable.
update plan_catalogue set name = 'Enterprise Suite', updated_at = now()
 where plan = 'enterprise' and name = 'Enterprise';

-- ── 3 · Room in the ledger to say what happened ──────────────────────
-- A roll-over is not a spend and not a purchase, so it needs its own kind
-- and a line of plain English. Without this the balance would change with
-- nothing in the statement to explain it, which is exactly the thing
-- customers write in about.
alter table credit_ledger add column if not exists reason text;

alter table credit_ledger drop constraint if exists credit_ledger_kind_check;
alter table credit_ledger add  constraint credit_ledger_kind_check
  check (kind in ('analysis','cedric','revision','topup','bolton_purchase','adjustment','rollover'));

-- `create or replace view` cannot insert a column in the middle of an
-- existing view, so drop it first. Nothing depends on it but the app.
drop view if exists my_credit_history;
create view my_credit_history as
  select l.created_at,
         l.kind,
         l.source,
         case when l.credits < 0 then 'added' else 'spent' end as direction,
         abs(l.credits) as credits,
         l.reason,
         l.contract_id
    from credit_ledger l
   where l.account_id in (select my_account_ids())
   order by l.created_at desc;

grant select on my_credit_history to authenticated;

-- ── 4 · Bank the remainder at renewal ────────────────────────────────
-- Called by the Stripe webhook on every invoice.payment_succeeded with
-- p_reset_period = true, and on checkout completion.
--
-- Order matters: read what is left BEFORE the reset, bank it capped, then
-- reset. Bolt-on credits (credits_bolton) are bought outright and never
-- expire, so they are not touched here at all.
create or replace function billing_apply_plan(
  p_account_id   uuid,
  p_plan         text,
  p_customer     text default null,
  p_subscription text default null,
  p_reset_period boolean default true
) returns void
language plpgsql security definer set search_path = public
as $$
declare
  allowance int;
  cap       int;
  left_over int := 0;
  banked    int := 0;
  b         record;
begin
  select credits_included, coalesce(bank_cap, 0)
    into allowance, cap
    from plan_catalogue where plan = p_plan;
  if allowance is null then
    raise exception 'Unknown plan %', p_plan;
  end if;

  if p_reset_period then
    -- What the customer would have seen as "left" one second before the
    -- renewal: this period's allowance plus anything already banked, less
    -- what they spent and less anything still held against a running job.
    -- credits_breakdown is the same figure the app shows them, so the
    -- number that rolls over is the number they were looking at.
    select * into b from credits_breakdown(p_account_id);
    left_over := greatest(0, coalesce(b.plan_left, 0));
    banked    := least(cap, left_over);
  end if;

  update accounts
     set plan                   = p_plan,
         credits_included       = allowance,
         credits_banked         = case when p_reset_period then banked else coalesce(credits_banked, 0) end,
         credits_used           = case when p_reset_period then 0     else credits_used end,
         period_started_at      = case when p_reset_period then now() else period_started_at end,
         stripe_customer_id     = coalesce(p_customer,     stripe_customer_id),
         stripe_subscription_id = coalesce(p_subscription, stripe_subscription_id),
         billing_status         = 'active'
   where id = p_account_id;

  -- A statement line, so roll-over appears in the customer's own credit
  -- history rather than as a number that changed for no visible reason.
  if p_reset_period and banked > 0 then
    insert into credit_ledger (account_id, kind, credits, source, reason, created_at)
    values (p_account_id, 'rollover', 0, 'plan',
            'Rolled over ' || banked || ' unused credit' || case when banked = 1 then '' else 's' end ||
            ' into the new period (cap ' || cap || ')',
            now());
  end if;
end $$;

-- ── 5 · When a subscription ends, the banked balance goes with it ────
-- The pricing page says so: "Banked roll-over audits expire when the
-- subscription ends." Bought bolt-on credits are not affected — those were
-- paid for separately and are not part of the subscription.
-- Keep the EXACT signature from migration 004. `create or replace` with a
-- different parameter list does not replace anything — it quietly creates a
-- second function, and which one the webhook calls is then a coin toss.
create or replace function billing_subscription_ended(
  p_subscription text, p_status text default 'cancelled'
) returns void
language plpgsql security definer set search_path = public
as $$
begin
  update accounts
     set plan              = 'sandbox',
         credits_included  = (select credits_included from plan_catalogue where plan = 'sandbox'),
         credits_banked    = 0,
         billing_status    = p_status,
         period_started_at = now()
   where stripe_subscription_id = p_subscription;
end $$;

commit;

-- ── Proof it works ───────────────────────────────────────────────────
-- Paste this into the SQL editor against a test account to watch a
-- renewal carry the remainder forward and cap it.
--
--   select credits_banked, credits_used from accounts where id = '<acct>';
--   select * from credits_breakdown('<acct>');
--   select billing_apply_plan('<acct>', 'growth', null, null, true);
--   select credits_banked, credits_used from accounts where id = '<acct>';
--   select reason from my_credit_history order by created_at desc limit 1;
