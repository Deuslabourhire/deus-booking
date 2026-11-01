-- What the scheduled retry may claim. Run ONLY on deus-authtest. Needs no extension.
-- Each scenario raises at its end, so everything it wrote is undone. The last statement lists PASS / FAIL.
create function pg_temp.check_that(ok boolean, what text) returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'not true: %', what; end if;
end $$;

create function pg_temp.new_alert(p_kind text, p_details jsonb) returns bigint language plpgsql as $$
declare v_sub uuid; v_id bigint;
begin
  insert into public.subcontractors (display_name, hourly_rate, full_name, address, email, abn)
  values ('P3 retry test', 30, 'P3 Test', '1 Test St', 'new@y.test', '51824753556') returning id into v_sub;
  insert into public.sub_notifications (kind, subcontractor_id, worker_notify_email, details)
  values (p_kind, v_sub, 'old@x.test', p_details) returning id into v_id;
  return v_id;
end $$;

create function pg_temp.email_alert() returns bigint language sql as $$
  select pg_temp.new_alert('email_changed_by_worker', '{"old_email":"o•••@x.test","new_email":"n•••@y.test"}'::jsonb)
$$;

create function pg_temp.claimed(p_id bigint) returns jsonb language sql as $$
  select x from jsonb_array_elements(public.sub_claim_due_bank_alerts(1000)) x where (x->>'id')::bigint = p_id
$$;

-- Nobody called the function: however old, the alert is sent. This closes the direct RPC gap.
create function pg_temp.t1_never_claimed_is_sent() returns void language plpgsql as $$
declare i bigint := pg_temp.email_alert(); a jsonb;
begin
  update public.sub_notifications set created_at = now() - interval '30 days' where id = i;
  a := pg_temp.claimed(i);
  perform pg_temp.check_that(a is not null, 'claimed');
  perform pg_temp.check_that((a->>'need_admin')::boolean and (a->>'need_worker')::boolean, 'both channels needed');
end $$;

create function pg_temp.t2_both_kinds_are_sent() returns void language plpgsql as $$
declare
  e bigint := pg_temp.email_alert();
  b bigint := pg_temp.new_alert('bank_changed_by_worker', '{"old":{},"new":{}}'::jsonb);
  c jsonb := public.sub_claim_due_bank_alerts(1000);
begin
  perform pg_temp.check_that((select count(*) from jsonb_array_elements(c) x where (x->>'id')::bigint in (e, b)) = 2, 'both claimed');
end $$;

create function pg_temp.t3_only_missing_channel() returns void language plpgsql as $$
declare i bigint := pg_temp.email_alert(); a jsonb;
begin
  update public.sub_notifications set email_status = 'sent', worker_email_status = 'failed_500',
    attempts = 1, first_claimed_at = now() - interval '20 minutes' where id = i;
  a := pg_temp.claimed(i);
  perform pg_temp.check_that(not (a->>'need_admin')::boolean, 'admin not sent again');
  perform pg_temp.check_that((a->>'need_worker')::boolean, 'worker sent again');
  perform pg_temp.check_that((a->>'attempt')::int = 2, 'second attempt');
end $$;

create function pg_temp.t4_max_attempts_stop() returns void language plpgsql as $$
declare i bigint := pg_temp.email_alert(); s text; r text;
begin
  update public.sub_notifications set attempts = 5, first_claimed_at = now() - interval '2 hours' where id = i;
  perform pg_temp.check_that(pg_temp.claimed(i) is null, 'not claimed');
  select delivery_state, gave_up_reason into s, r from public.sub_notifications where id = i;
  perform pg_temp.check_that(s = 'gave_up' and r = 'max_attempts', 'gave up: max attempts');
end $$;

create function pg_temp.t5_window_stops() returns void language plpgsql as $$
declare i bigint := pg_temp.email_alert(); s text; r text;
begin
  update public.sub_notifications set attempts = 1, first_claimed_at = now() - interval '24 hours' where id = i;
  perform pg_temp.check_that(pg_temp.claimed(i) is null, 'not claimed');
  select delivery_state, gave_up_reason into s, r from public.sub_notifications where id = i;
  perform pg_temp.check_that(s = 'gave_up' and r = 'retry_window_closed', 'gave up: window closed');
end $$;

create function pg_temp.t6_active_claim_is_left_alone() returns void language plpgsql as $$
declare i bigint := pg_temp.email_alert();
begin
  update public.sub_notifications set delivery_state = 'claimed', claim_token = gen_random_uuid(), claimed_at = now(),
    attempts = 1, first_claimed_at = now() where id = i;
  perform pg_temp.check_that(pg_temp.claimed(i) is null, 'active claim not taken');
  update public.sub_notifications set claimed_at = now() - interval '11 minutes' where id = i;
  perform pg_temp.check_that(pg_temp.claimed(i) is not null, 'expired claim taken');
end $$;

create function pg_temp.t7_done_is_not_sent() returns void language plpgsql as $$
declare i bigint := pg_temp.email_alert();
begin
  update public.sub_notifications set delivery_state = 'done', email_status = 'sent', worker_email_status = 'sent' where id = i;
  perform pg_temp.check_that(pg_temp.claimed(i) is null, 'not claimed');
end $$;

create function pg_temp.run_all() returns text language plpgsql as $$
declare
  name text;
  result text := '';
begin
  foreach name in array array['t1_never_claimed_is_sent', 't2_both_kinds_are_sent', 't3_only_missing_channel',
                              't4_max_attempts_stop', 't5_window_stops', 't6_active_claim_is_left_alone',
                              't7_done_is_not_sent'] loop
    begin
      execute format('select pg_temp.%I()', name);
      raise exception 'p3_undo';
    exception when others then
      result := result || case when sqlerrm = 'p3_undo' then 'PASS ' || name else 'FAIL ' || name || ': ' || sqlerrm end || E'\n';
    end;
  end loop;
  return result;
end $$;

select pg_temp.run_all() as results;
