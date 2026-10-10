# Tests for the Edge Functions

Run each function for real (Deno.serve on a local port) against fake Supabase and
fake Amazon Bedrock endpoints, and check every outbound request.

    deno run -A --config deno.json test_proxy.ts     # needs env vars, see below
    deno run -A --config deno.json test_worker.ts
    deno run -A --config deno.json test_webhook.ts   # STRIPE_WEBHOOK_SECRET + PORT

Environment (fake values — never real keys):
    SUPABASE_URL=https://sb.test SUPABASE_ANON_KEY=sb_publishable_testtesttesttest
    SUPABASE_SERVICE_ROLE_KEY=sb_secret_testtesttesttesttest
    AWS_ACCESS_KEY_ID=AKIATESTKEY AWS_SECRET_ACCESS_KEY=secretsecretsecret
    ALLOWED_ORIGIN=https://contractiqplatform.co.uk PORT=8801 SCEN=main   (proxy only)

import_map.json maps the CDN imports to npm so the tests run where esm.sh is blocked.
