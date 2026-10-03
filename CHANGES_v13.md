# ContractIQ v13 — what changed, and how it was checked

19 September 2026 · built on v12 (14 September) · CodeIQ Holdings Ltd

## Start here
`ContractIQ_Go_Live_Guide.docx` (or the PDF) — Amazon Bedrock, Supabase, Stripe, your
domain, and the launch test, step by step.

## AI: Amazon Bedrock, EU route
- `anthropic-proxy` and `job-worker` call Claude Sonnet 5 through **Amazon Bedrock**
  (`eu.anthropic.claude-sonnet-5`, called from `eu-west-2`). Requests are SigV4-signed;
  the signature was cross-checked against an independent implementation of AWS's algorithm.
- The worldwide (`global.`) route is refused in code. A per-workspace `data_region`
  (`eu` default, `us` by arrangement) selects the route.
- Both functions and the app pin Supabase's server functions to London
  (`forceFunctionRegion=eu-west-2`).
- The documents travel once per analysis as a cacheable block; the five stages add only
  their task. Cedric's context is cacheable too.
- `AI_PROVIDER=anthropic` remains as an emergency switch only.

## Faults fixed that would have hit at launch
1. **Back-office database functions were callable by anyone** holding the public key —
   including `billing_apply_credits` and `billing_apply_plan` (free credits / free
   Enterprise), and the functions that settle or release charges. MIGRATION_007 revokes
   them from the public roles; only the server can call them.
2. **Background analysis ran one of five stages** while charging for five. The queue now
   carries all five and the worker runs them; the app applies a finished job exactly as
   the in-browser path does.
3. **The background worker could never be woken** on a 2026 Supabase project (gateway JWT
   check refuses `sb_secret_` keys). It now checks the key itself, answers at once and
   works in the background (`EdgeRuntime.waitUntil`).
4. **Re-run billing:** the in-browser path charged for re-runs advertised as free, and a
   modified app could claim any analysis was a free re-run. The price is now decided
   server-side, and browser-path analyses count towards the revision window.
5. **Queued contract text was kept for ever** in `jobs.payload`. It is deleted when the
   job finishes or dies.
6. **A job could write onto another workspace's contract** (guessable ids). Refused at
   queueing and at completion.
7. **Zero-Retention did nothing in production** and forgot itself on refresh. It is now
   a saved per-workspace setting (Enterprise), forces the in-browser path, and the
   database refuses to store document text while it is on.
8. `authorise_ai_call` accepted any account id. Members only now.

## Pricing
- Prices unchanged: Growth £79, Scale £270, Enterprise £700.
- Sandbox 150 → **100 credits** (catalogue, sign-up, app, pricing, checkout, success, Legal Centre).
- Every plan lists "AI runs in the UK and EU; the AI provider keeps nothing"; Enterprise
  adds "US data hosting available by arrangement".
- Profit model moved to Bedrock EU costs (£0.026 a credit typical, £0.046 worst case):
  breakeven **20 users** at full utilisation (was 12 on a figure four times too low).
- Pricing page founding counter wired to the live database.

## Legal Centre 1.1 (recorded at sign-up as 2026.2)
- MSA: AI Provider definition; 5.6 AI Provider terms (flow-down); 6.6 no training and no
  retention by the AI Provider; 6.7 where data is held and processed; 10.1 output-accuracy
  wording; 15.4 changing the AI Provider.
- AUP: restrictions required by the AWS Acceptable Use Policy, AWS Responsible AI Policy and
  Anthropic Usage Policy; qualified review before decisions with legal consequences.
- AI notice, Schedule 1 (new data-handling section), Privacy Policy, DPA (3.4, Annex B),
  Sub-processor list (AWS replaces Anthropic), Security Statement, change log.
- Still orange: VAT, email provider, confirmation of the Supabase region.
- Site pages corrected where they described things the code did not do.

## Checks run on this build
| Check | Result |
|---|---|
| esbuild — bundle matches source | current |
| Deno type-check, all four functions | pass |
| Proxy against fake Supabase + Bedrock (`tests/functions`) | 21 + 1 + 1 pass |
| Worker against fake Supabase + Bedrock | 14 pass |
| SQL: fresh build, every script re-run, on PostgreSQL 16 | pass |
| `TEST_billing.sql` / `TEST_data_safety.sql` | 9 / 16 pass |
| `test_live_paths.mjs` (queue, Zero-Retention, London pin) | 14 pass |
| `test_app.mjs` (demo) | 9 pass |
| `test_pseudonymise.mjs` | 13 pass |
| `verify_site.mjs` (layout, all pages, 5 widths) | 28 pass |
| `verify_consistency.mjs` (prices, allowances, data claims) | 48 pass |
| `verify_text_claims.mjs` | 39 pass |
| `model_profit.py --check` | pass |

Not testable from here: a real call to Amazon Bedrock (needs your AWS account), a real
Stripe payment, and real Supabase dashboard settings. Part E of the guide covers those.

The long-standing "Invalid or unexpected token" failure in `test_app.mjs` was the test's
own fault — its URL rewrite ran past a single-quoted address. Fixed; not a product bug.
