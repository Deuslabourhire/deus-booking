-- Audit item P3, stage 2: with a run every 15 minutes, 5 attempts ended the retries after about an hour,
-- so a longer provider outage lost the alert. 92 runs take about 23 h: sub_alert_retry_window is the real limit.
create or replace function public.sub_alert_max_attempts()
returns integer
language sql
immutable
set search_path = ''
as $$ select 92; $$;
