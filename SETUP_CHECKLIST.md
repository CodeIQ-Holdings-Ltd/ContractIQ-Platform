# ContractIQ v13 — launch checklist

Tick in order. The guide (`ContractIQ_Go_Live_Guide.docx`) explains every line.

## A · Amazon Web Services (about an hour)
- [ ] Business AWS account for CodeIQ Holdings Ltd; card added
- [ ] Two-step sign-in (MFA) on the main login
- [ ] $50 monthly budget with email alerts
- [ ] Region set to Europe (London)
- [ ] Bedrock → Claude Sonnet 5 → Anthropic use-case form submitted
- [ ] One harmless playground test on the EU route
- [ ] Bedrock → Settings → model invocation logging OFF
- [ ] IAM user `contractiq-bedrock` with the EU-only policy; access key created

## B · Supabase (about an hour)
- [ ] Project region is London (eu-west-2) — if not, new project + `set_project.py`
- [ ] Extensions: pg_cron, pg_net, supabase_vault
- [ ] SQL: SETUP, 003, 004, 005, 006, 007, 008, 009 — in that order
- [ ] Functions: anthropic-proxy (JWT ON), job-worker (JWT OFF), create-checkout-session (OFF), stripe-webhook (OFF)
- [ ] Secrets: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, ALLOWED_ORIGIN, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
- [ ] Vault secrets + three cron jobs (dispatch, maintenance, holds)
- [ ] Auth: Site URL, Confirm email ON, 6-digit code template, own SMTP

## C · Stripe (30 minutes) — see `PAYMENTS_GUIDE.html` for the full walkthrough
- [ ] Test mode: secret key in Supabase; webhook endpoint with five events; signing secret in Supabase
- [ ] Test purchase with card 4242 4242 4242 4242 → plan applied
- [ ] Launch day: live key, live webhook, STRIPE_ALLOW_LIVE = true

## D · Your domain (30 minutes, plus waiting)
- [ ] GitHub repository with the contents of this folder, including `.nojekyll`
- [ ] Pages → custom domain contractiqplatform.co.uk; DNS at IONOS; Enforce HTTPS

## E · Launch test
- [ ] Sign up with a code → workspace → analysis completes with every tab filled
- [ ] Cedric answers; Supabase logs show `route:bedrock/eu fn:eu-west-2`
- [ ] Test purchase applies the plan
- [ ] ANTHROPIC_API_KEY deleted from Supabase and from the Anthropic console
- [ ] Legal Centre orange items filled (VAT, email provider, Supabase region)
