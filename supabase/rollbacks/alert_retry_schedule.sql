-- ROLLBACK of the scheduled retry of subcontractor alert e-mails (audit item P3, stage 2).
-- NOT a migration: do not move it to supabase/migrations. Run only after explicit approval.
-- Run only as many levels as needed. Afterwards alerts wait as pending again: nothing is lost, but
-- they are only sent when the worker's page asks for it.

-- LEVEL 1: stop the calls. Immediate, and enough for most problems.
select cron.unschedule(jobid) from cron.job where jobname = 'sub-alert-retry';

-- LEVEL 2: remove the secrets. Also delete ALERT_RETRY_SECRET in the Dashboard (Edge Functions ->
-- Secrets); retry_due then answers 403.
-- delete from vault.secrets where name in ('sub_alert_retry_secret', 'sub_alert_retry_url');

-- LEVEL 3: remove the extensions. This deletes the cron history and the pg_net responses.
-- First confirm both counts are 0: no other job, and nothing waiting to be sent.
--   select count(*) from cron.job where jobname <> 'cron-history-cleanup';
--   select count(*) from net.http_request_queue;
-- select cron.unschedule(jobid) from cron.job where jobname = 'cron-history-cleanup';
-- drop extension pg_cron;
-- drop extension pg_net;
-- Vault stays: it was installed before this change.
