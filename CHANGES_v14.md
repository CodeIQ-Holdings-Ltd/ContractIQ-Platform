# ContractIQ v14.6 — what changed

5 October 2026 · built on v13 (19 September) · CodeIQ Holdings Ltd

## What v14 is
v13 plus the new homepage and updated legals, then (v14.1, same day) corrected AI-retention and
region wording. The database, `aws/` and the server functions' behaviour are v13's; the app's
text (`contractiq.jsx`, rebuilt into `app/` and `demo/`) changed only in the wording described
below; a comment in the proxy and one in MIGRATION_007 changed.

1. **New homepage "How it works"** (`index.html`, `assets/ciq-motion.js`, `assets/shots/`).
   The four-slide carousel is replaced by four large stacked bands, each with a heading and a
   screenshot of the real application. The carousel's auto-advance script is removed.
   `tools/` holds the script that applied it and the screenshot tooling (see `tools/README.md`).
2. **Legal Centre** (`legal.html`, still version 1.1, still recorded at sign-up as 2026.2):
   - VAT: not registered; prices are what is payable; 30 days' written notice before VAT is
     ever added (clause 8.3 and the key-facts panel).
   - Email provider: IONOS SE (business email) added to its existing Sub-processor row.
   - Footer said "version 1.0"; now 1.1.
   - Change log and the launch notice updated. One orange placeholder remains: Supabase region.
3. `GO_LIVE_TESTS.html`: placeholder step reworded to match.

## v14.6 (10 October 2026): the hero mesh, and the CodeIQ gallery screenshots
- **A mesh in the hero, on every page.** Points drift across the hero photograph and join up where
  they are close; the cursor pushes the nearby ones aside — the effect from codeiqholdings.co.uk, in
  ContractIQ's colours (pale blue threads, teal on about one point in six). It is drawn into a canvas
  that `assets/ciq-motion.js` injects, so no page markup changed, and it is skipped entirely under
  prefers-reduced-motion, stops when the hero scrolls out of view, thins out below 760px, and never
  takes a click.
  - Worth recording: the first attempt threw the hero photograph about 25,000 pixels off screen. The
    mesh's `mx`/`my` were declared in the one long function this file already was, where the hero
    parallax has variables of the same name; it reads them as a −1..1 fraction and multiplies. The
    mesh now lives in its own scope. Nothing in the test suites would have caught it — they check for
    clipped text and invisible elements, not for a background that has silently left the building — so
    it was found by putting the before and after side by side.
- **The four screenshots in the CodeIQ Holdings gallery are real.** Portfolio, renewal runway, the
  Verify tab (confidence scores with the source quoted back) and supplier risk, at 1600×1000, from the
  demo build's sample portfolio. `tools/shoot_codeiq_gallery.mjs` takes them again whenever the app's
  layout moves; the alt text on that site describes each screen.

## v14.5 (10 October 2026): the free trial is ten days, and Start free creates an account
**Run `supabase/MIGRATION_009_sandbox_10_days.sql` after 008, and upload the changed site files.**
- **The Evaluation Sandbox window is 90 days → 10 days.** Still a one-off 100 credits, still ends the
  moment they are spent, still read-only afterwards. The number lives in one place —
  `plan_catalogue.period_days` — and the balance, the banner, the "ends in N days" count and the
  server's refusal all read it, so this migration is the whole change on the database side.
- **The warning banner now appears with 3 days left** rather than 14, which would have been the whole
  trial. The credit trigger (20 credits or fewer) is unchanged.
- **"Start free" goes straight to the create-account form** (`app/?signup=1`) from every page, instead
  of the sign-in box or, on the pricing page, the checkout summary. The pricing card's button now reads
  "Create your free account". The app reads `?signup=1` and opens on sign-up; without it, nothing
  changes. The demo build ignores it.
- Wording updated on the pricing, checkout and success pages, in the app, and in Product Schedule 1 of
  both Legal Centres (ContractIQ and CodeIQ), with the change log entries amended.
- Two harnesses were reading stale numbers and are now honest: `verify_consistency` read the period
  from the original MIGRATION_004 insert and so could never have noticed this change (it now follows
  later migrations for both credits and period), and `verify_text_claims` matched a lower-case
  "sandbox" that only existed in a URL.
- Tests updated for the shorter window: `TEST_sandbox.sql` (14) and `test_live_paths.mjs`, which gains
  two checks that `app/?signup=1` opens the sign-up form and that the plain URL still opens sign-in (23).

## v14.4 (6 October 2026): two faults in the payment path, and a payments guide
**Redeploy `stripe-webhook` and run MIGRATION_008 — both faults need both.**

1. **Renewals and failed payments were silently ignored.** Stripe's Basil API version (2025-03-31)
   removed `invoice.subscription`; the id moved to `invoice.parent.subscription_details.subscription`.
   The webhook read only the old field, so on any account defaulting to Basil or later every
   `invoice.payment_succeeded` was answered 200 and did nothing: the customer was charged in month two
   and got no credits. `invoice.payment_failed` was equally silent, so nothing was ever marked
   `past_due`. `invoiceSubscriptionId()` now reads the old field, the new one, and the invoice lines.
2. **A subscription bought before sign-up was never handed over.** `claim_pending_subscription()` has
   existed since MIGRATION_004 and nothing called it — not the app, not the sign-up trigger. The normal
   self-serve journey (pay on the pricing page, then create a login) therefore left the customer on the
   free Sandbox having been charged £79. `handle_new_user()` now calls it, wrapped so a failure cannot
   block a sign-up, and MIGRATION_008 back-fills anyone already stranded.

New: `PAYMENTS_GUIDE.html` — the whole customer journey, the Stripe dashboard settings (including why
Stripe Tax must be switched on even though CodeIQ is not VAT registered), a test-mode dress rehearsal,
going live, the real fee arithmetic, and a fault-finding table.

Also: `PROFIT_SCENARIOS.md` was missing Stripe Billing's 0.7% on recurring volume. Added — breakeven
stays at 20 users. Tests: new `tests/functions/test_webhook.ts` (19 checks, four of which fail against
the old webhook), and four more in `TEST_sandbox.sql` (14) for the pay-then-sign-up path.

## v14.3 (6 October 2026): a one-off Sandbox, and no founding offer
**Run `supabase/MIGRATION_008_one_off_sandbox.sql` after 007, and upload the changed site files.**
- **Evaluation Sandbox = 100 credits, once.** It ends when the credits are used or 90 days after
  sign-up, whichever is first; unused credits lapse. Before this, nothing refilled it and nothing
  expired it, while the pricing page said "every 90 days" and "permanently free" — both wrong.
- **After it ends the workspace is read-only.** Contracts and analyses can still be opened and
  exported; new analyses and Cedric questions are refused (by the database, not just the screen).
  Bought bolt-on credits still work. A red banner with a "Choose a plan" button explains it; an
  amber banner appears in the last 14 days or when 20 credits or fewer are left.
- **A cancelled subscription no longer drops to a fresh 100 credits.** It drops to the Sandbox plan
  with none (read-only). Previously, cancelling gave a free 100 credits and a new 90-day window.
- **Founding offer withdrawn.** Removed from the homepage, pricing page and every menu; sign-up no
  longer claims a founding seat; the pricing page no longer calls the database for a counter.
  The founding tables and functions stay in the database as an audit trail, unused.
- Wording changed everywhere it appeared: pricing page, checkout, success page, the app's own
  edition cards, Legal Centre Product Schedule 1 (and the CodeIQ site's copy), profit model.
- New tests: `TEST_sandbox.sql` (10 checks) and 7 new browser checks in `test_live_paths.mjs`.
- `PROFIT_SCENARIOS.md` now shows what free Sandboxes cost: £2.60 typical / £4.60 worst per
  sign-up; the exposure is unlimited sign-ups, not ten.
- `set_project.py` no longer touches pricing.html (it has no database call now).

### Check before you upload
The app, checkout page and `contractiq.jsx` in this folder still point at Supabase project
`aremuhzsgmqginhmpfno`. Your live project is `zfgfjjzvwhuurhndqeph`. Run, once, from this folder:
`python3 set_project.py https://zfgfjjzvwhuurhndqeph.supabase.co sb_publishable_YOUR_KEY`
(publishable key only, never the secret one). It rewrites the three places and rebuilds the app.

### Open decisions (not built)
- What happens to the data of a Sandbox that never upgrades (kept for how long, then deleted?). The
  Beta terms say sandbox data may be deleted at any time; there is no deletion job yet.
- Work-email-only sign-up and one Sandbox per company, to cap throwaway accounts.

## v14.2 (6 October 2026): legal fixes found on a second read
- DPA clause 3.4 still promised an AI Provider that "does not keep Customer Data after processing
  it". Now: no training, no sharing with the model developer, and zero data retention switched on in
  every region where it is available, with exceptions named in the Sub-processor list.
- Privacy Policy retention table said text is "not kept by the AI Provider once it has answered".
  Now states the five-of-seven position.
- Tenant-isolation paragraph in the DPA (Annex B) promised that "no fault in the application code can
  widen" access and that "the blast radius is limited". Rewritten as a design intent, without a
  guarantee. (v13's own MIGRATION_007 fixed back-office functions that were callable by anyone, so an
  absolute claim was not safe.)
- "AWS does not..." and "Anthropic has no access" now say "under the AWS terms that apply to our
  account", because they are AWS's commitments, not ours.
- The Sub-processor list said "current as at the date shown below" with no date. It now says 6 Oct 2026.
- The public "Before this goes live" box (solicitor-review and placeholder notes) is removed from the
  page: it was a build-time note to you, not something customers should read. The solicitor review
  is still outstanding; it is now listed in README/CHANGES instead.
- ICO reference written as ICO:00015500673 everywhere, matching the CodeIQ site.
The CodeIQ site's Legal Centre (separate zip) carries the same documents and is in step with this.

## v14.1 (5 October 2026, later the same day): wording made true to the AWS settings
Amazon Bedrock Zero Data Retention was set to `none` on 5 Oct 2026 in eu-west-1, eu-west-2,
eu-west-3, eu-north-1 and eu-central-1. The EU route can also run in eu-south-1 (Milan) and
eu-south-2 (Spain). Those regions are not enabled on the AWS account, so the setting could not be
applied there, and AWS applies the *destination* region's setting. So "the AI provider keeps
nothing" was no longer provable. Changed everywhere it appeared (legal.html, pricing.html,
security.html, about.html, contractiq.jsx and the app/demo builds, proxy comment):
- "keeps nothing / does not store" -> "never trains on your content, never passes it to
  Anthropic, zero data retention switched on in five of the seven regions the EU route can use".
  The Sub-processor list names all seven regions and which five have it on.
- Switzerland removed from every processing-location statement: it is not one of the seven.
- Supabase region confirmed as London (eu-west-2): the last orange placeholder removed.
To go back to the stronger promise: enable Europe (Milan) and Europe (Spain) under AWS Account ->
AWS Regions, set `none` in both, then restore the "keeps nothing" wording.

## How it was checked
verify_consistency 48/48 · verify_text_claims 39/39 · verify_site 28/28 · test_app 9/9 ·
test_live_paths 23/23 · test_pseudonymise 13/13 · model_profit --check (breakeven 20 users) ·
TEST_billing (9), TEST_data_safety (16) and TEST_sandbox (14) on PostgreSQL 16 after the full migration chain ·
Deno: proxy 23 (main 21, global 1, nocreds 1), worker 14 and webhook 19. Homepage section viewed at 1440px.
Not done: a real Bedrock call, a real Stripe checkout, and a solicitor's review.
