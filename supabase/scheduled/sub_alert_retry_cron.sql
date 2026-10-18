-- =====================================================================
-- Scheduled retry of bank-change alert e-mails — PREPARED, NOT APPLIED.
-- Target: deus-authtest first. Run only after explicit approval, and only
-- after:
--   1. migration 20261016130000_subcontractor_invoices.sql is applied;
--   2. Edge Function sub-invoice-submit is deployed with verify_jwt = false
--      (supabase/config.toml) and the secret ALERT_RETRY_SECRET is set;
--   3. pg_net and pg_cron are enabled, `net` is NOT in the Data API "Exposed
--      schemas", and sub_alert_retry_net_audit.sql (read-only) has been run and
--      its output reviewed (who can read the pg_net request queue).
--
-- What it does
--   Every 15 minutes pg_cron calls the Edge Function with
--   {"action":"retry_due"} and the header x-retry-secret. The function then
--   calls sub_claim_due_bank_alerts(20), which only returns alerts that are
--   pending (failed send) or whose 10-minute claim lease expired
--   (interrupted attempt), and only within 23 h of their first attempt
--   (sub_alert_retry_window), i.e. inside the provider's 24 h idempotency
--   window. With 15-minute runs and at most 5 attempts, retries normally
--   finish within about 75 minutes of the first attempt.
--
-- Authentication of this request
--   The request carries NO apikey and NO Authorization header. It is accepted
--   because the function is deployed with verify_jwt = false (the gateway does
--   not check a JWT) and the function itself requires x-retry-secret to equal
--   ALERT_RETRY_SECRET (>= 32 chars, constant-time comparison; 403 otherwise,
--   and the endpoint is disabled while the secret is unset).
--
-- Why every 15 minutes (and what it does NOT guarantee)
--   * 5 attempts fit in about 75 minutes, far inside the 23 h window, leaving
--     room for an outage of almost a day before automatic retries stop;
--   * light load: one small HTTP call, at most 20 alerts per run.
--   The interval does NOT prevent overlapping calls: pg_net sends requests
--   asynchronously (the cron job only queues the request and returns), the
--   function may be slow, and a worker save or a manual call can run at the
--   same time. Overlap is made safe by the database, not by the schedule:
--     - claims use FOR UPDATE SKIP LOCKED: an alert is claimed by one caller;
--     - a claim has a token and a 10-minute lease: while it is active no other
--       call can claim the alert; after it expires, results from the old claim
--       are rejected (stale_result_ignored);
--     - each channel's final status is stored and never re-sent or overwritten;
--     - every e-mail carries a fixed Idempotency-Key (alert id + channel), so a
--       re-send after an expired lease is de-duplicated by the provider (24 h).
--
-- Secret handling (never in this file, the repository, logs or chat)
--   1. Generate on your own computer, e.g. Windows PowerShell 5.1:
--        $b = New-Object byte[] 48; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)
--      (64 characters; the function refuses secrets shorter than 32). Copy it
--      straight into the two places below; do not save it in a file.
--   2. Edge Function secret (Dashboard → Edge Functions → Secrets, or
--        supabase secrets set ALERT_RETRY_SECRET=... --project-ref <ref>).
--   3. The SAME value in Supabase Vault (SQL editor, run once by hand —
--      do not save the statement with the real value anywhere):
--        select vault.create_secret('<generated value>', 'sub_alert_retry_secret',
--                                   'x-retry-secret header for sub-invoice-submit retry_due');
--        select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/sub-invoice-submit',
--                                   'sub_alert_retry_url', 'retry_due endpoint');
--
-- Where the secret exists while the job runs (be precise)
--   * cron.job / cron.job_run_details: only the Vault LOOKUP text below — the
--     secret is NOT stored there.
--   * pg_net request queue: net.http_post() writes the request, INCLUDING its
--     headers (so the decrypted secret), into net.http_request_queue. The row
--     stays there until the pg_net background worker sends the request
--     (normally within a second; longer if the worker is busy or stopped) and
--     is then deleted. While it waits, the secret is readable by any role with
--     direct database access that can SELECT that table. Response rows
--     (net._http_response) do not contain the request headers but may contain
--     the function's JSON reply (no secrets in it).
--   * This CANNOT be prevented with REVOKE: on Supabase the pg_net objects are
--     owned and granted by supabase_admin, and `postgres` cannot revoke those
--     grants (REVOKE only warns; the privileges stay). Nothing in this project
--     claims to block access to the queue.
--
-- Who can read the queue (confirm with sub_alert_retry_net_audit.sql — the
-- exact list depends on the project):
--   * postgres — the role used by the Dashboard SQL/Table editor and by direct
--     or pooled connections with the database password. Anyone with Dashboard
--     access to the project or the database password can read the queue.
--   * supabase_admin — Supabase's own platform superuser.
--   * authenticator — the login role PostgREST uses; it switches to anon /
--     authenticated / service_role, which hold pg_net grants on Supabase. Its
--     credentials are held by the platform, and through the Data API it can
--     only reach schemas listed in "Exposed schemas".
--   * any other LOGIN role created in the project that is granted the access.
--   Note: anyone in this list can already read every table directly (including
--   bank details), so the queued secret adds little extra exposure. With the
--   secret alone a person can only trigger retry_due, which re-sends nothing
--   that is already delivered (claims + Idempotency-Key). Rotate it if misuse
--   is suspected.
--
-- What we DO control
--   * Keep `net` out of the Data API (Dashboard → Project Settings → API →
--     Exposed schemas; default public, graphql_public). Then anon /
--     authenticated / service_role cannot reach the queue over HTTP, even
--     though they hold grants on it. Optional probe with the PUBLIC
--     publishable key only (no secret involved):
--       GET https://<ref>.supabase.co/rest/v1/http_request_queue
--           apikey: <publishable key>, Accept-Profile: net
--     expected: an error saying the schema must be one of the exposed schemas.
--   * Limit who has Dashboard access and the database password; do not create
--     extra LOGIN roles with access to `net`.
--   * Possible later improvement (not implemented): replace the static secret
--     with a single-use token minted per run and expiring in minutes, so a
--     value read from the queue is useless after the request is processed.
--
-- Rotation: generate a new value, update the Edge Function secret, then
--   select vault.update_secret((select id from vault.secrets where name = 'sub_alert_retry_secret'), '<new value>');
-- (a run in between gets 403 and the next run retries; nothing is lost).
--
-- Turning it off: select cron.unschedule('sub-alert-retry');
--   or remove ALERT_RETRY_SECRET from the function (retry_due then returns 403).
-- =====================================================================

-- Re-runnable: remove a previous version of the job first.
select cron.unschedule(jobid) from cron.job where jobname = 'sub-alert-retry';

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
