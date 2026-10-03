-- Go-live guide, step B6: turn on the background worker.
-- Change the TWO capitalised parts, then Run.
--   YOUR-PROJECT            → from your Project URL (https://YOUR-PROJECT.supabase.co)
--   sb_secret_YOUR_SECRET_KEY → Project Settings → API Keys → Secret keys (sb_secret_…)
-- The secret key is stored encrypted in your own database's Vault and never leaves it.

select vault.create_secret(
  'https://YOUR-PROJECT.supabase.co/functions/v1/job-worker',
  'job_worker_url');

select vault.create_secret(
  'sb_secret_YOUR_SECRET_KEY',
  'service_role_key');

select cron.schedule('contractiq-dispatch',    '10 seconds',   $$select dispatch_jobs()$$);
select cron.schedule('contractiq-maintenance', '* * * * *',    $$select maintenance_tick()$$);
select cron.schedule('contractiq-holds',       '*/15 * * * *', $$select reap_stale_holds()$$);

-- A minute later, check it (expect rows with status "succeeded"):
-- select jobname, status, start_time from cron.job_run_details order by start_time desc limit 10;
