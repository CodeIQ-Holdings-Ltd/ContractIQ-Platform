# ContractIQ v14.1 — what changed

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
test_live_paths 14/14 · test_pseudonymise 13/13 · model_profit --check (breakeven 20 users) ·
TEST_billing (9) and TEST_data_safety (16) on PostgreSQL 16 after the full migration chain ·
Deno: proxy 23 (main 21, global 1, nocreds 1) and worker 14. Homepage section viewed at 1440px.
Not done: a real Bedrock call, a real Stripe checkout, and a solicitor's review.
