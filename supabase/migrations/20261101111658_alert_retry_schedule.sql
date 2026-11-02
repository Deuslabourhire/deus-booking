-- Audit item P3, stage 2: send subcontractor alert e-mails without depending on the worker's page.
-- The secret is only looked up in Vault when the job runs: its value is never written here.
-- Setup and exposure notes: supabase/scheduled/sub_alert_retry_cron.sql
begin;

do $$
begin
  if coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'sub_alert_retry_secret'), '') !~ '^\S{32,}$' then
    raise exception 'alert_retry_precondition_failed: Vault secret sub_alert_retry_secret is missing or invalid';
  end if;
  if coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'sub_alert_retry_url'), '')
     !~ '^https://[a-z0-9]+\.supabase\.co/functions/v1/sub-invoice-submit$' then
    raise exception 'alert_retry_precondition_failed: Vault secret sub_alert_retry_url is missing or invalid';
  end if;
end;
$$;

-- shortcut: a full batch of 20 alerts can outlast the 30 s timeout and the 150 s request limit, leaving
-- the alerts it did not reach to wait for their lease; fine with about 3 subcontractors, lower p_limit
-- in the function if alerts ever pile up.
select cron.schedule(
  'sub-alert-retry',
  '*/15 * * * *',
  $job$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'sub_alert_retry_url'),
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-retry-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'sub_alert_retry_secret')),
    body    := '{"action":"retry_due"}'::jsonb,
    timeout_milliseconds := 30000
  );
  $job$
);

-- pg_cron keeps every run forever: about 96 rows a day from the job above, one more from this one.
select cron.schedule(
  'cron-history-cleanup',
  '17 3 * * *',
  $job$
  delete from cron.job_run_details where coalesce(end_time, start_time) < now() - interval '30 days';
  $job$
);

commit;
