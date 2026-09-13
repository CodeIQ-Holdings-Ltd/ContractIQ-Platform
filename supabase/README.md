# Supabase — everything in this folder, and the order to do it in

CodeIQ Holdings Ltd · ContractIQ Platform · 13 September 2026

You have a new Supabase Pro project and an empty database. This folder is
everything that goes into it. Work top to bottom; each step assumes the one
before it is done.

Nothing here needs the command line. Every step is a page in the Supabase
dashboard.

---

## What is in this folder

| File | What it is | Where it goes |
|---|---|---|
| `SETUP.sql` | The whole schema — 17 tables, the security rules, the job queue | SQL Editor, run once |
| `MIGRATION_003_founding.sql` | The ten free founding places | SQL Editor, run after SETUP |
| `MIGRATION_004_credits_and_billing.sql` | Credits that actually deduct, and Stripe | SQL Editor, run after 003 |
| `functions/anthropic-proxy/index.ts` | The AI call. Holds your Anthropic key | Edge Functions |
| `functions/job-worker/index.ts` | Runs queued analyses in the background | Edge Functions |
| `functions/create-checkout-session/index.ts` | Starts a Stripe payment | Edge Functions |
| `functions/stripe-webhook/index.ts` | Hears back from Stripe and updates the account | Edge Functions |

All three SQL scripts can be run again safely. If you are unsure whether one
finished, run it again — that is cheaper than guessing.

---

## Step 1 · Run the three SQL files, in order

**Supabase → SQL Editor → New query.** Paste the whole file, press Run.
Wait for it to finish before starting the next one.

1. `SETUP.sql`
2. `MIGRATION_003_founding.sql`
3. `MIGRATION_004_credits_and_billing.sql`

Three things worth knowing:

- The SQL Editor runs a script as **one transaction**. If it fails, nothing
  is applied — there is no half-finished state to clean up. Read the error,
  fix it, run the whole file again.
- `SETUP.sql` prints a lot of `NOTICE: ... does not exist, skipping` lines.
  That is the script tidying up before it creates things. It is not an error.
- Run them in order. 004 alters tables that 003 and SETUP create.

**Check it worked.** New query, run this:

```sql
select
  (select count(*) from plan_catalogue)                    as plans,        -- expect 4
  (select count(*) from credit_packs)                      as packs,        -- expect 1
  (select count(*) from ai_limits)                         as limits,       -- expect 3
  (select count(*) from information_schema.tables
    where table_schema='public' and table_name='credit_holds') as holds_table;  -- expect 1
```

Four numbers: 4, 1, 3, 1. Anything else means a script did not finish.

---

## Step 2 · Deploy the four Edge Functions

**Supabase → Edge Functions → Deploy a new function → Via Editor.**
Name each one **exactly** as below — the app builds its URL from the name,
so a typo produces a 404 that looks like a broken app.

| Function name | Enforce JWT verification |
|---|---|
| `anthropic-proxy` | **ON** |
| `job-worker` | **ON** |
| `create-checkout-session` | **OFF** |
| `stripe-webhook` | **OFF** |

That JWT column is the most important thing on this page, so here is why
each one is set that way:

- **`anthropic-proxy` — ON.** This is the change that closes the hole. With
  it off, anyone who found the URL — and it is visible in every user's
  browser network tab — could spend your Anthropic balance. With it on, the
  function knows who is calling, which workspace they belong to, and whether
  that workspace has the credits.
- **`create-checkout-session` — OFF.** Someone buying a plan has not signed
  up yet. There is no login to verify. Buying *credits* does require a login,
  and that is checked inside the function rather than at the gateway.
- **`stripe-webhook` — OFF.** Stripe is a server calling you. It has no
  Supabase login and never will. It is authenticated by a cryptographic
  signature instead, which the function checks on every request and rejects
  if it does not match.

---

## Step 3 · Secrets

**Supabase → Edge Functions → Secrets.** These are shared by all four
functions, so you set each one once.

| Secret | Value | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-…` | From console.anthropic.com |
| `ALLOWED_ORIGIN` | `https://contractiqplatform.co.uk` | **No path, no trailing slash.** A trailing slash causes a 403 that looks like a broken app |
| `STRIPE_SECRET_KEY` | `sk_test_…` | Stripe → Developers → API keys, in the sandbox |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` | Stripe → Developers → Webhooks → your endpoint → Signing secret. You get this in Step 4 |
| `ANTHROPIC_MODEL` | `claude-sonnet-5` | Optional. This is the default |
| `STRIPE_ALLOW_LIVE` | *leave unset* | Set to `true` only when you are ready to take real money. Until then a live key is refused outright |

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are
injected automatically. Do not add them yourself.

> **The secret key never goes anywhere else.** Not in the app, not in the
> repo, not in a screenshot. It belongs on this page and nowhere else.

---

## Step 4 · Point Stripe at the webhook

Without this step a customer can pay you and nothing changes in the product.
They stay on the sandbox plan with 150 credits, having just been charged £79.

**Stripe → Developers → Webhooks → Add endpoint.**

- **URL:** `https://<your-project-ref>.supabase.co/functions/v1/stripe-webhook`
- **Events to send:**
  - `checkout.session.completed`
  - `invoice.payment_succeeded`
  - `invoice.payment_failed`
  - `customer.subscription.deleted`
  - `customer.subscription.updated`

Then copy the **Signing secret** (`whsec_…`) into the `STRIPE_WEBHOOK_SECRET`
secret from Step 3.

**Check it worked.** On the endpoint page press *Send test webhook*. You want
a **200** from Supabase, and a row here:

```sql
select id, type, received_at from stripe_events order by received_at desc limit 5;
```

If you get a 400 with "Signature verification failed", the signing secret does
not match. Copy it again — it is easy to grab the API key by mistake.

---

## Step 5 · Prices live in the database, not in the code

You do not need to redeploy anything to change a price.

```sql
-- What you are charging today
select plan, name, credits_included, price_pence, self_serve from plan_catalogue order by sort_order;
select code, name, credits, price_pence from credit_packs;

-- Change one (example: putting Scale back to £199)
update plan_catalogue set price_pence = 19900 where plan = 'scale';
```

If you create the products and prices in Stripe yourself, put their price ids
here and those are used instead of prices created on the fly:

```sql
update plan_catalogue set stripe_price_id = 'price_…' where plan = 'growth';
update credit_packs    set stripe_price_id = 'price_…' where code = 'credits100';
```

Current prices, after the September repricing: **Growth £79, Scale £270,
Enterprise £700 flat.** They appear in `plan_catalogue`, on `pricing.html`,
on `checkout.html` and in the app's plan table, and they agree.

⚠️ **If you reprice again, change the database row and the pages together** —
or the page says one thing and the card is charged another, which is the one
billing mistake customers never forgive. Enterprise carries a price but stays
`self_serve = false`: the checkout page shows £700 and routes the buyer to
email rather than taking a card.

---

## Step 6 · Two settings that are easy to miss

**Authentication → URL Configuration.** The Site URL and redirect URLs must
include the folder path if your app lives in one. If they do not, verification
links appear to do nothing at all — no error, just a dead link.

**Authentication → Email.** Supabase's built-in mail is rate-limited on every
plan, including Pro. Ten founding members signing up in one evening is exactly
the pattern that trips it, and the ones it drops will assume the product is
broken. Connect your own SMTP before you invite anybody:

> **Recommended: Resend.** Free tier covers 3,000 emails a month, setup is
> about ten minutes, and deliverability from a new domain is better than most.
> Brevo is the equally reasonable alternative. Either way you will need to add
> the DNS records they give you (SPF and DKIM) to your domain at IONOS, or
> your mail lands in spam — which for a verification email is the same as not
> sending it.

---

## Step 7 · One scheduled job (optional, two minutes)

If an Edge Function times out mid-analysis, the credits it reserved stay
reserved. They are released automatically after thirty minutes; this job does
it every fifteen instead.

**Database → Cron → Create job**, schedule `*/15 * * * *`, command:

```sql
select reap_stale_holds();
```

Nothing breaks without it. Balances just take a little longer to tidy
themselves up.

---

## How the money actually flows

Worth reading once, because it explains why the pages say what they say.

1. Someone chooses a plan on `pricing.html` and fills in `checkout.html`.
2. `create-checkout-session` starts a Stripe Checkout session and the browser
   goes to Stripe's own payment page. **Your site never sees a card number.**
3. They pay. Stripe sends `checkout.session.completed` to `stripe-webhook`.
4. They have no login yet, so the webhook **parks** the subscription against
   their email address in `pending_subscriptions`.
5. They land on `success.html`, which tells them to create their sign-in
   **with the same email address**.
6. They sign up. `claim_pending_subscription()` finds the parked payment,
   applies the plan and the credit allowance, and the workspace opens on the
   plan they paid for.

If they sign up with a *different* email, the payment stays parked and they
land on the sandbox plan. You can fix that by hand:

```sql
-- See what is waiting to be claimed
select email, plan, created_at from pending_subscriptions where claimed_at is null;

-- Point it at the right address
update pending_subscriptions set email = 'the@address.they.used' where email = 'the@address.they.paid.with';
```

---

## When something is wrong

| What you see | What it usually is |
|---|---|
| Analysis fails instantly, 500 | `ANTHROPIC_API_KEY` is not set, or is spelled differently |
| Analysis fails, 403, "Origin not allowed" | `ALLOWED_ORIGIN` has a trailing slash or a folder path on the end |
| Analysis fails, 401 | The user's session expired — sign out and back in. Do **not** turn off Verify JWT to fix this |
| "Not enough credits" on a new account | Correct behaviour. Sandbox is 150 credits, and an analysis costs 10 |
| Paid, but still on sandbox | The webhook. Check `stripe_events` for the event, and `pending_subscriptions` for a parked payment |
| Verification emails never arrive | Built-in mail rate limit, or URL Configuration missing the folder path |
| Everything worked yesterday, nothing works today | Free projects pause after 7 days idle. Pro projects do not — if you are on Pro, this is not it |

**Where to look:** Edge Functions → *(the function)* → Logs. Every function
here logs what it decided and why. The proxy logs the account, the token
counts and the cost of each call.
