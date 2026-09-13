> **Superseded in places by `supabase/README.md` (13 Sept 2026).**
> Where the two disagree, the Supabase README is right: it covers the new
> Stripe functions and the credit system, and it is the one that was tested.

# ContractIQ Platform — going live

Roughly 30 minutes. Tick these off in order; nothing later depends on
you having done the earlier ones in one sitting.

---

## 1 · Put it online (10 min, free)

- [ ] Create a GitHub repository. Public is fine — nothing here is secret.
- [ ] Upload **the contents** of this folder (not the folder itself).
- [ ] Check `.nojekyll` is in the file list. Browsers hide dotfiles and
      drag-and-drop often skips it. If missing: **Add file → Create new
      file**, name it `.nojekyll`, leave it empty, commit.
      With Git use `git add -A`, not `git add .`
- [ ] Settings → Pages → Deploy from a branch, `main`, `/ (root)`.
- [ ] Open `https://YOURNAME.github.io/YOURREPO/demo/` — it should work
      immediately, with no setup at all.

## 2 · Database (5 min, free)

- [ ] supabase.com → New project. Pick a region near you.
- [ ] SQL Editor → paste **all** of `supabase/SETUP.sql` → Run.
- [ ] Table Editor should now show contracts, documents, data_points,
      profiles, jobs and the rest.

## 3 · Your API key (5 min — this is the only thing that costs money)

- [ ] console.anthropic.com → API keys → Create Key. Copy it now; it is
      shown once.
- [ ] Billing → add credit. **Limits → set a monthly spend cap.** Do this
      now, not later. With $20 to test, set the cap at $20.
- [ ] Supabase → Edge Functions → **Secrets** → add three:

| Key | Value |
|---|---|
| `ANTHROPIC_API_KEY` | your `sk-ant-…` key |
| `ALLOWED_ORIGIN` | `https://YOURNAME.github.io` |
| `STRIPE_SECRET_KEY` | `sk_test_…` |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` |

> `ALLOWED_ORIGIN` is the origin the **app** is served from — `https://`
> only, **no folder path, no trailing slash**. Wrong value = every
> analysis fails with 403, and it is the first thing to check if it does.

## 4 · The two functions (10 min)

Edge Functions → **Deploy a new function → Via Editor**. No terminal needed.

- [ ] Name it exactly `anthropic-proxy`, paste
      `supabase/functions/anthropic-proxy/index.ts`, Deploy.
      Leave **Verify JWT ON**. The proxy identifies the caller and checks their
      credits; with it off, anyone who finds the URL can spend your Anthropic balance.
- [ ] Name it exactly `job-worker`, paste
      `supabase/functions/job-worker/index.ts`, Deploy.
      Leave **Verify JWT ON** — the database calls this one.

Names must match exactly. The app builds its URL from them.

## 5 · Connect and test (2 min)

- [ ] Supabase → Project Settings → API Keys. Copy the **Project URL** and
      the **anon** key. (Leave `service_role` alone — it bypasses every
      security rule you just installed.)
- [ ] Open `.../app/`, sign in with `admin` / `ContractIQ2026!`
- [ ] Settings → paste both values. No Save button; it applies as you type.
- [ ] Load a sample portfolio, open a contract, **Run AI analysis**.

If the tabs fill with analysis, you are live.

---

## Optional: background processing

Analysis works without this — it just runs in the browser tab and stops
if you close it. Turn it on and a 40-contract run survives anything.

- [ ] Integrations → enable **Cron**.
- [ ] Project Settings → API Keys → copy the **service_role** key. Safe
      here because it never leaves the database.
- [ ] SQL Editor:

```sql
select vault.create_secret(
  'https://YOUR-PROJECT.supabase.co/functions/v1/job-worker', 'job_worker_url');
select vault.create_secret('YOUR_SERVICE_ROLE_KEY', 'service_role_key');

select cron.schedule('contractiq-dispatch', '10 seconds',
                     $$select dispatch_jobs()$$);
select cron.schedule('contractiq-maintenance', '* * * * *',
                     $$select maintenance_tick()$$);
```

- [ ] Check it: `select * from cron.job_run_details order by start_time desc limit 20;`

## Optional: real user accounts

Sign-in currently uses the built-in demo account. For real accounts:

- [ ] Authentication → **URL Configuration** → Site URL and Redirect URLs
      must include the **full app address with the folder**, e.g.
      `https://you.github.io/repo/app/`. Skip this and verification links
      bounce silently with no error anywhere.
- [ ] Authentication → Providers → Email → **Confirm email ON**.
- [ ] Email Templates → Confirm signup → replace `{{ .ConfirmationURL }}`
      with `{{ .Token }}` to send a 6-digit code instead of a link.
      Corporate mail scanners pre-fetch links and consume them before the
      user clicks — codes avoid that entirely.
- [ ] Google / Microsoft: Providers → switch on, paste Client ID + Secret.
      Callback URL is `https://YOUR-PROJECT.supabase.co/auth/v1/callback`

---

## What $20 buys you

| | Cost |
|---|---|
| One contract analysis | ~£0.05 |
| One question to Cedric | ~£0.01 |
| The whole 38-document stress pack | under £2 |
| Hosting, database, functions | £0 |

So roughly **300 analyses** before you run out. Plenty to answer the
question that matters: does it read *your* contracts well?

---

## If it doesn't work

| What the app says | Fix |
|---|---|
| No AI endpoint configured | Step 5 — check the URL starts `https://` and ends `.supabase.co` |
| AI endpoint rejected the request, 403 | `ALLOWED_ORIGIN` mismatch — no trailing slash, no folder path |
| AI endpoint rejected the request, 401 | The signed-in session expired. Sign out and back in. Do **not** turn Verify JWT off |
| Rate limit reached | The per-workspace hourly limit. Change it in the `ai_limits` table, not in Secrets |
| Analysis failed — 500 | The function can't find the key. Check the spelling in Secrets |
| Analysis failed — 529 | Anthropic is busy. Wait and retry |
| Jobs stay "Queued" forever | Cron not running, or Vault secrets missing |

Deeper: Edge Functions → click the function → **Logs**. Every call is
recorded with its token count and approximate cost. If a call never
appears there at all, the request isn't reaching the function — which
points at `ALLOWED_ORIGIN` or the function name.
