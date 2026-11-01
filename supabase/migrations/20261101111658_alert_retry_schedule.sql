-- Audit item P3, stage 2: send subcontractor alert e-mails without depending on the worker's page.
-- The secret is only looked up in Vault when the job runs: its value is never written here.
-- Setup and exposure notes: supabase/scheduled/sub_alert_retry_cron.sql
begin;

do $$
begin
  if (select count(*) from vault.secrets where name in ('sub_alert_retry_secret', 'sub_alert_retry_url')) <> 2 then
    raise exception 'alert_retry_precondition_failed: create both Vault secrets first';
  end if;
end;
$$;

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
