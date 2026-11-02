-- ROLLBACK of the scheduled retry of subcontractor alert e-mails (audit item P3, stage 2).
-- NOT a migration: do not move it to supabase/migrations. Run only after explicit approval.
-- Run only as many levels as needed.
--
-- Afterwards a pending alert is only sent if the same worker saves through the link again. If that
-- comes more than 23 h after its first attempt, it is closed without sending. So list them first and
-- contact those workers directly:
--   select id, kind, subcontractor_id, created_at from public.sub_notifications
--   where delivery_state in ('pending', 'claimed');
-- The limit of 92 attempts can stay: without the job, an alert is only tried when its worker saves.

-- LEVEL 1: stop the calls. Immediate, and enough for most problems.
select cron.unschedule(jobid) from cron.job where jobname = 'sub-alert-retry';

-- LEVEL 2: remove the secrets. Also delete ALERT_RETRY_SECRET in the Dashboard (Edge Functions ->
-- Secrets); retry_due then answers 403.
-- delete from vault.secrets where name in ('sub_alert_retry_secret', 'sub_alert_retry_url');

-- LEVEL 3: remove the extensions. This deletes the cron history and the pg_net responses, and any
-- other job or webhook using them. After Level 1, all four counts must be 0 before going on:
--   select count(*) from cron.job where jobname is distinct from 'cron-history-cleanup';
--   select count(*) from net.http_request_queue;
--   select count(*) from pg_trigger t join pg_proc p on p.oid = t.tgfoid join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'supabase_functions';
--   select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname not in ('net', 'extensions', 'supabase_functions', 'cron', 'pg_catalog') and p.prosrc ilike '%net.http_%';
-- select cron.unschedule(jobid) from cron.job where jobname = 'cron-history-cleanup';
-- drop extension pg_cron;
-- drop extension pg_net;
-- Vault stays: it was installed before this change.
