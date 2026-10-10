# Supabase — everything in this folder, and the order to do it in

CodeIQ Holdings Ltd · ContractIQ Platform · v13 · 19 September 2026

**The full, plain-English walk-through is `ContractIQ_Go_Live_Guide.docx` (and
the PDF beside it).** This page is the short technical reference for the same
steps. Where they seem to disagree, the guide explains why.

Nothing here needs the command line. Every step is a page in the Supabase
dashboard, the AWS console or the Stripe dashboard.

---

## What is in this folder

| File | What it is | Where it goes |
|---|---|---|
| `SETUP.sql` | The whole schema — tables, security rules, the job queue | SQL Editor, run once |
| `MIGRATION_003_founding.sql` | Founding-offer tables. The offer is withdrawn (008 stops it); kept so the order stays unbroken | SQL Editor, after SETUP |
| `MIGRATION_004_credits_and_billing.sql` | Credits that deduct, and Stripe | SQL Editor, after 003 |
| `MIGRATION_005_rollover_and_naming.sql` | Roll-over caps, plan names | SQL Editor, after 004 |
| `MIGRATION_006_revision_window.sql` | Free re-runs inside the revision window | SQL Editor, after 005 |
| `MIGRATION_007_bedrock_and_data_safety.sql` | **v13.** Locks back-office functions, deletes queued text after use, Zero-Retention per workspace, data region, Sandbox 100 | SQL Editor, after 006 |
| `MIGRATION_008_one_off_sandbox.sql` | **v14.4.** Sandbox is a one-off 100 credits (used up or 90 days, then read-only); lapsed subscriptions get no free credits; no founding seat at sign-up; **a subscription bought before sign-up is now actually claimed**, and anyone already stranded is rescued | SQL Editor, after 007 |
| `MIGRATION_009_sandbox_10_days.sql` | **v14.5.** The free Sandbox window: 90 days → **10 days**. One row; the rest of the product reads it | SQL Editor, after 008 |
| `functions/anthropic-proxy/index.ts` | The AI call — now through **Amazon Bedrock (EU)** | Edge Functions |
| `functions/job-worker/index.ts` | Runs queued analyses — all five stages | Edge Functions |
| `functions/create-checkout-session/index.ts` | Starts a Stripe payment | Edge Functions |
| `functions/stripe-webhook/index.ts` | Hears back from Stripe | Edge Functions |
| `TEST_*.sql` | Tests for a local Postgres. **Never run these on your real project** | — |

Every SQL file can be run again safely. If you are unsure whether one
finished, run it again.

**If you ever re-run an earlier file (SETUP, 003–007), run MIGRATION_008 and then
009 again straight afterwards (and 007 before them for 003–006).** The earlier files redefine some of the same functions, and
would otherwise quietly undo 007's protections.

---

## 0 · The project must be in London

Project Settings → General → **Region** must read *West EU (London)* /
`eu-west-2`. The Legal Centre promises customers their data is held in the
UK. If your project is anywhere else, create a new project in London now
(nobody has real data yet) and run `python3 ../set_project.py <URL> <publishable key>`
— or send Claude the two values — so the website points at it.

## 1 · Turn on three extensions

Database → Extensions: **pg_cron**, **pg_net**, and check **supabase_vault**
is on (it usually is).

## 2 · Run the SQL files, in order

SQL Editor → New query → paste the whole file → Run. Wait for each to finish.

1. `SETUP.sql` 2. `MIGRATION_003_founding.sql` 3. `MIGRATION_004_credits_and_billing.sql`
4. `MIGRATION_005_rollover_and_naming.sql` 5. `MIGRATION_006_revision_window.sql`
6. `MIGRATION_007_bedrock_and_data_safety.sql` 7. `MIGRATION_008_one_off_sandbox.sql`
8. `MIGRATION_009_sandbox_10_days.sql`

`NOTICE: … does not exist, skipping` lines are normal.

**Check it worked:**

```sql
select
  (select credits_included from plan_catalogue where plan = 'sandbox')          as sandbox_credits,  -- 100
  (select count(*) from information_schema.columns
    where table_name = 'accounts' and column_name in ('data_region','zero_retention')) as new_columns, -- 2
  has_function_privilege('anon', 'billing_apply_credits(uuid,int,text)', 'execute')  as anon_can_add_credits; -- false
```

## 3 · Deploy the four Edge Functions

Edge Functions → Deploy a new function → Via Editor. Names must be exact.

| Function name | Enforce JWT verification | Why |
|---|---|---|
| `anthropic-proxy` | **ON** | Every caller is a signed-in person |
| `job-worker` | **OFF** (changed in v13) | Called by the database with the secret key, which is not a JWT. The function checks the key itself |
| `create-checkout-session` | **OFF** | Buyers have no login yet; checked inside |
| `stripe-webhook` | **OFF** | Stripe signs its requests; checked inside |

## 4 · Secrets

Edge Functions → Secrets.

| Secret | Value |
|---|---|
| `AWS_ACCESS_KEY_ID` | From the `contractiq-bedrock` IAM user (guide, Part A) |
| `AWS_SECRET_ACCESS_KEY` | Its secret — shown once by AWS |
| `ALLOWED_ORIGIN` | `https://contractiqplatform.co.uk` — no path, no trailing slash |
| `STRIPE_SECRET_KEY` | `sk_test_…` while testing; `sk_live_…` at launch |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` from the Stripe webhook endpoint |
| `STRIPE_ALLOW_LIVE` | Leave unset until launch day, then `true` |

Optional, with safe defaults you should not need to change:
`BEDROCK_REGION_EU` (`eu-west-2`), `BEDROCK_MODEL_EU` (`eu.anthropic.claude-sonnet-5`),
`BEDROCK_REGION_US`, `BEDROCK_MODEL_US`, `MAX_JOBS_PER_RUN` (`1`).

**Delete `ANTHROPIC_API_KEY`** once Bedrock works. `AI_PROVIDER=anthropic` is an
emergency switch back to Anthropic's own API; using it breaks the promises in
the Legal Centre, so it is for minutes, not days.

The functions read the project's own keys automatically (`SUPABASE_URL`,
`SUPABASE_SECRET_KEYS`, `SUPABASE_PUBLISHABLE_KEYS`). Do not add them.

## 5 · Background processing (required in v13)

Analyses run in the background once someone is signed in. Without this step
they sit on "Queued" for ever.

```sql
-- Where the worker lives, and the key it checks. Use your SECRET key (sb_secret_…),
-- from Project Settings → API Keys. It stays inside the database.
select vault.create_secret('https://YOUR-PROJECT.supabase.co/functions/v1/job-worker', 'job_worker_url');
select vault.create_secret('sb_secret_YOUR_SECRET_KEY', 'service_role_key');

select cron.schedule('contractiq-dispatch',    '10 seconds',   $$select dispatch_jobs()$$);
select cron.schedule('contractiq-maintenance', '* * * * *',    $$select maintenance_tick()$$);
select cron.schedule('contractiq-holds',       '*/15 * * * *', $$select reap_stale_holds()$$);
```

Check: `select jobname, status, start_time from cron.job_run_details order by start_time desc limit 10;`

## 6 · Stripe webhook

Stripe → Developers → Webhooks → Add endpoint:
`https://YOUR-PROJECT.supabase.co/functions/v1/stripe-webhook`, events
`checkout.session.completed`, `invoice.payment_succeeded`,
`invoice.payment_failed`, `customer.subscription.deleted`,
`customer.subscription.updated`. Copy the signing secret into
`STRIPE_WEBHOOK_SECRET`. Test: `select id, type, received_at from stripe_events order by received_at desc limit 5;`

## 7 · Authentication

- URL Configuration → Site URL `https://contractiqplatform.co.uk/app/`; add the
  same to Redirect URLs.
- Providers → Email → Confirm email **ON**.
- Email Templates → Confirm signup → use `{{ .Token }}` (a 6-digit code).
- Emails → SMTP: connect your own sender (Resend or Brevo) before inviting anyone.

---

## How the money flows

1. A buyer picks a plan on `pricing.html` and fills in `checkout.html`.
2. `create-checkout-session` starts Stripe Checkout; the card is entered on Stripe's page.
3. Stripe sends `checkout.session.completed` to `stripe-webhook`, which parks the
   subscription against the buyer's email in `pending_subscriptions`.
4. The buyer signs up with the same email; the plan is applied automatically.

Prices live in `plan_catalogue`. Change the row and the pages together — the
consistency check (`node verify_consistency.mjs`) fails if they disagree.

## When something is wrong

| What you see | What it usually is |
|---|---|
| Analysis fails, 500, "missing AWS_ACCESS_KEY_ID" | Secret missing or misspelt |
| Analysis fails, 403, "Bedrock refused" | IAM policy wrong, use-case form not submitted, or old keys |
| Analysis fails, 403, "Origin not allowed" | `ALLOWED_ORIGIN` has a trailing slash or a folder |
| Analysis fails, 401 | Session expired. Sign out and in. Do not turn off JWT |
| Jobs stay "Queued" | Step 5 not done, pg_net off, or `job-worker` JWT left ON |
| Paid but still on Sandbox | Webhook — check `stripe_events` and `pending_subscriptions` |
| Verification emails never arrive | Built-in mail limit — connect SMTP |

**Where to look:** Edge Functions → the function → Logs. The proxy writes one
line per AI call: `route:bedrock/eu fn:eu-west-2 in:… out:… ~$…` — never the text.
