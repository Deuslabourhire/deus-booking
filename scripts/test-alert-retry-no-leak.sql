-- Read-only check for the scheduled retry. Run on the project being checked, after a job has run.
-- It compares against the secret inside the database and returns only counts and lengths: it can
-- never print the value. Every *_with_secret count must be 0.
with s as (
  select decrypted_secret as v from vault.decrypted_secrets where name = 'sub_alert_retry_secret'
)
select
  (select length(v) from s) as secret_length,
  (select v = btrim(v) from s) as secret_has_no_spaces,
  (select count(*) from cron.job j, s where position(s.v in j.command) > 0) as jobs_with_secret,
  (select count(*) from cron.job_run_details d, s where position(s.v in d.command) > 0
                                                     or position(s.v in coalesce(d.return_message, '')) > 0) as runs_with_secret,
  (select count(*) from net._http_response r, s where position(s.v in coalesce(r.content, '')) > 0
                                                   or position(s.v in coalesce(r.headers::text, '')) > 0) as responses_with_secret,
  (select count(*) from supabase_migrations.schema_migrations m, s
    where position(s.v in array_to_string(m.statements, ' ')) > 0) as migrations_with_secret,
  (select count(*) from net.http_request_queue) as requests_waiting,
  (select count(*) from cron.job where jobname in ('sub-alert-retry', 'cron-history-cleanup') and active) as jobs_active;
