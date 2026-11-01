-- Audit item P3, stage 2: extensions for the scheduled retry of subcontractor alert e-mails.
-- After applying, run supabase/scheduled/sub_alert_retry_net_audit.sql before the schedule migration.
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;
