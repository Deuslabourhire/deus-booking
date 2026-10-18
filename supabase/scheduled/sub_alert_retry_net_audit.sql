-- =====================================================================
-- pg_net exposure audit for the scheduled retry — PREPARED, NOT APPLIED.
-- READ-ONLY: changes nothing (runs in a read-only transaction that is rolled
-- back) and never selects request headers or bodies, so it cannot print the
-- secret. Run as `postgres` (SQL editor) after enabling pg_net and before
-- scheduling sub_alert_retry_cron.sql; keep the output with the change record.
--
-- Why an audit and not REVOKE
--   On Supabase the pg_net objects (schema net, net.http_request_queue,
--   net._http_response, net.http_post, ...) are owned by supabase_admin, which
--   also grants their privileges. The `postgres` role is not the owner and did
--   not grant them, so it cannot revoke them: REVOKE only emits a warning and
--   the privileges stay. This file therefore only REPORTS who can reach the
--   queue; it does not try to change it.
--
-- What it reports
--   1. owner of the pg_net objects;
--   2. privileges of the API roles (anon, authenticated, service_role) on them —
--      expected to be present on Supabase; reaching them through the Data API is
--      prevented only by keeping `net` out of "Exposed schemas" (step 4);
--   3. LOGIN roles that can read net.http_request_queue directly or by switching
--      to a role that can (these are the roles that can see the secret while a
--      request waits in the queue);
--   4. reminder of the manual Data API check (cannot be read from SQL);
--   5. number of requests currently waiting (count only, no contents).
-- =====================================================================

begin;
set transaction read only;

do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'net') then
    raise exception 'pg_net is not installed (schema net missing): enable the extension first';
  end if;
end $$;

-- 1. Owners
select 'owner' as check, c.relname as object, pg_get_userbyid(c.relowner) as owner
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'net' and c.relkind in ('r', 'p', 'v')
union all
select 'owner', 'schema net', pg_get_userbyid(nspowner) from pg_namespace where nspname = 'net'
order by 2;

-- 2. API roles' privileges on the queue, responses and http_post
select 'api_role_privileges' as check, r.rolname as role,
       has_schema_privilege(r.rolname, 'net', 'usage')                          as schema_usage,
       has_table_privilege(r.rolname, 'net.http_request_queue', 'select')       as can_read_queue,
       has_table_privilege(r.rolname, 'net._http_response', 'select')           as can_read_responses,
       exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'net' and p.proname = 'http_post'
                 and has_function_privilege(r.rolname, p.oid, 'execute'))       as can_call_http_post
from pg_roles r
where r.rolname in ('anon', 'authenticated', 'service_role')
order by r.rolname;

-- 3. LOGIN roles that can read the queue (directly, or by SET ROLE to a role that can)
select 'login_roles_that_can_read_queue' as check, l.rolname as login_role,
       l.rolsuper as superuser,
       coalesce(string_agg(distinct m.rolname, ', ') filter (where m.rolname <> l.rolname), '') as via_roles
from pg_roles l
-- MEMBER = any membership (works on PostgreSQL 15 and 17); a member can SET ROLE to it
join pg_roles m on (m.oid = l.oid or pg_has_role(l.oid, m.oid, 'MEMBER'))
where l.rolcanlogin
  and (l.rolsuper or has_table_privilege(m.oid, 'net.http_request_queue', 'select'))
group by l.rolname, l.rolsuper
order by l.rolname;

-- 4. Data API exposure: not visible from SQL — check by hand.
select 'manual_check' as check,
       'Dashboard -> Project Settings -> API -> Exposed schemas must NOT include net (default: public, graphql_public)' as detail;

-- 5. Requests waiting right now (count only; contents are never selected)
select 'queue_waiting' as check, count(*) as requests from net.http_request_queue;

rollback;
