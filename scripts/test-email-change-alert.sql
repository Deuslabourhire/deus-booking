-- Database scenarios of the contact e-mail alert. Run ONLY on deus-authtest.
-- Each scenario raises at its end, so everything it wrote is undone. The last statement lists PASS / FAIL.
create function pg_temp.check_that(ok boolean, what text) returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'not true: %', what; end if;
end $$;

create function pg_temp.new_sub(p_email text, p_with_bank boolean) returns text language plpgsql as $$
declare
  v_id uuid;
  v_token text := left(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 43);
begin
  insert into public.subcontractors (display_name, hourly_rate, full_name, address, email, abn)
  values ('P3 test', 30, 'P3 Test', '1 Test St', p_email, '51824753556') returning id into v_id;
  if p_with_bank then
    insert into public.sub_bank_details (subcontractor_id, account_name, bsb, account_number)
    values (v_id, 'First Account', '111111', '22222222');
  end if;
  insert into public.sub_links (subcontractor_id, token_hash)
  values (v_id, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'));
  return v_token;
end $$;

create function pg_temp.sub_of(p_token text) returns uuid language sql as $$
  select subcontractor_id from public.sub_links where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
$$;

create function pg_temp.save(p_token text, p_email text, p_account text) returns jsonb language sql as $$
  select public.sub_portal_save_profile(p_token, 'P3 Test', '1 Test St', p_email, null, '51824753556', false,
                                        'First Account', '111111', p_account)
$$;

create function pg_temp.alerts(p_token text, p_kind text) returns bigint language sql as $$
  select count(*) from public.sub_notifications where subcontractor_id = pg_temp.sub_of(p_token) and kind = p_kind
$$;

create function pg_temp.notify_to(p_token text, p_kind text) returns text language sql as $$
  select worker_notify_email from public.sub_notifications where subcontractor_id = pg_temp.sub_of(p_token) and kind = p_kind
$$;

create function pg_temp.t1_email_only() returns void language plpgsql as $$
declare
  t text := pg_temp.new_sub('old@x.test', true);
  r jsonb := pg_temp.save(t, 'new@y.test', '22222222');
  n public.sub_notifications%rowtype;
begin
  perform pg_temp.check_that((r->>'email_alert')::boolean, 'email_alert is true');
  perform pg_temp.check_that(not (r->>'bank_alert')::boolean, 'bank_alert is false');
  perform pg_temp.check_that(pg_temp.alerts(t, 'email_changed_by_worker') = 1, 'one e-mail alert');
  perform pg_temp.check_that(pg_temp.alerts(t, 'bank_changed_by_worker') = 0, 'no bank alert');
  select * into n from public.sub_notifications where subcontractor_id = pg_temp.sub_of(t);
  perform pg_temp.check_that(n.worker_notify_email = 'old@x.test', 'goes to the old address');
  perform pg_temp.check_that(n.delivery_state = 'pending', 'pending');
  perform pg_temp.check_that(n.details->>'old_email' = 'o•••@x.test', 'old address masked');
  perform pg_temp.check_that(n.details->>'new_email' = 'n•••@y.test', 'new address masked');
end $$;

create function pg_temp.t2_email_then_bank() returns void language plpgsql as $$
declare t text := pg_temp.new_sub('old@x.test', true); r jsonb;
begin
  perform pg_temp.save(t, 'new@y.test', '22222222');
  r := pg_temp.save(t, 'new@y.test', '99999999');
  perform pg_temp.check_that((r->>'bank_alert')::boolean, 'bank_alert is true');
  perform pg_temp.check_that(not (r->>'email_alert')::boolean, 'email_alert is false on the second save');
  perform pg_temp.check_that(pg_temp.notify_to(t, 'email_changed_by_worker') = 'old@x.test', 'the old address was warned');
  perform pg_temp.check_that(pg_temp.notify_to(t, 'bank_changed_by_worker') = 'new@y.test', 'bank warning goes to the address on file');
end $$;

create function pg_temp.t3_both_in_one_save() returns void language plpgsql as $$
declare t text := pg_temp.new_sub('old@x.test', true); r jsonb := pg_temp.save(t, 'new@y.test', '99999999');
begin
  perform pg_temp.check_that((r->>'bank_alert')::boolean, 'bank_alert is true');
  perform pg_temp.check_that(not (r->>'email_alert')::boolean, 'email_alert is false');
  perform pg_temp.check_that(pg_temp.alerts(t, 'email_changed_by_worker') = 0, 'no second alert');
  perform pg_temp.check_that(pg_temp.alerts(t, 'bank_changed_by_worker') = 1, 'one bank alert');
  perform pg_temp.check_that(pg_temp.notify_to(t, 'bank_changed_by_worker') = 'old@x.test', 'goes to the old address');
  perform pg_temp.check_that((select (details->>'email_changed_in_same_save')::boolean from public.sub_notifications
                               where subcontractor_id = pg_temp.sub_of(t)), 'says the e-mail changed too');
end $$;

create function pg_temp.t4_no_alert() returns void language plpgsql as $$
declare t text; r jsonb;
begin
  -- first fill: no previous address
  t := pg_temp.new_sub(null, false);
  r := pg_temp.save(t, 'first@x.test', '22222222');
  perform pg_temp.check_that(r->>'email_alert' = 'false', 'first fill: email_alert is false');
  perform pg_temp.check_that(pg_temp.alerts(t, 'email_changed_by_worker') = 0, 'first fill: no alert');
  -- same address written differently
  t := pg_temp.new_sub('old@x.test', true);
  r := pg_temp.save(t, '  OLD@X.test ', '22222222');
  perform pg_temp.check_that(r->>'email_alert' = 'false', 'same address: email_alert is false');
  perform pg_temp.check_that(pg_temp.alerts(t, 'email_changed_by_worker') = 0, 'same address: no alert');
end $$;

create function pg_temp.t5_rpc_without_page() returns void language plpgsql as $$
declare t text := pg_temp.new_sub('old@x.test', true); c jsonb; a jsonb; v_id bigint; s text;
begin
  perform pg_temp.save(t, 'new@y.test', '22222222');
  -- nobody called the function: the alert waits, and the scheduled claim finds it
  perform pg_temp.check_that((select delivery_state from public.sub_notifications where subcontractor_id = pg_temp.sub_of(t)) = 'pending', 'still pending');
  c := public.sub_claim_due_bank_alerts(1000);
  select x into a from jsonb_array_elements(c) x
   where (x->>'id')::bigint = (select id from public.sub_notifications where subcontractor_id = pg_temp.sub_of(t));
  perform pg_temp.check_that(a is not null, 'the scheduled claim returns it');
  perform pg_temp.check_that(a->>'kind' = 'email_changed_by_worker', 'the claim says its kind');
  perform pg_temp.check_that(a->>'worker_notify_email' = 'old@x.test', 'the claim gives the old address');
  perform pg_temp.check_that(a->'details'->>'new_email' = 'n•••@y.test', 'the claim gives the masked address');
  v_id := (a->>'id')::bigint;
  perform public.sub_record_alert_channel(v_id, (a->>'claim_token')::uuid, 'admin', 'dry_run');
  perform public.sub_record_alert_channel(v_id, (a->>'claim_token')::uuid, 'worker', 'dry_run');
  s := public.sub_finish_alert_claim(v_id, (a->>'claim_token')::uuid)->>'delivery_state';
  perform pg_temp.check_that(s = 'done', 'finished as done');
end $$;

create function pg_temp.t6_only_bank_blocks() returns void language plpgsql as $$
declare
  t text := pg_temp.new_sub('old@x.test', true);
  v_sub uuid := pg_temp.sub_of(t);
  v_admin uuid := (select user_id from public.user_roles where role = 'admin' limit 1);
  v_day uuid; v_total numeric; v_err text := null; v_ack bigint; r jsonb;
begin
  perform pg_temp.check_that(v_admin is not null, 'an admin exists');
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform public.sub_portal_save_day(t, null, public.sub_today() - 1, 'Labourer', '08:00'::time, '12:00'::time, 0, 0, null);
  select id, labour_amount + travel_amount into v_day, v_total from public.sub_work_days where subcontractor_id = v_sub;
  perform public.sub_portal_send_days(t, array[v_day], true);

  -- a bank alert blocks the invoice
  perform pg_temp.save(t, 'old@x.test', '99999999');
  begin
    perform public.sub_admin_create_invoice(array[v_day], v_total);
  exception when others then v_err := sqlerrm;
  end;
  perform pg_temp.check_that(v_err = 'bank_alert_pending', 'bank alert blocks the invoice, got: ' || coalesce(v_err, 'no error'));
  select id into v_ack from public.sub_notifications where subcontractor_id = v_sub and kind = 'bank_changed_by_worker';
  perform public.sub_admin_ack_notification(v_ack);

  -- an e-mail alert does not, and it can be acknowledged
  perform pg_temp.save(t, 'new@y.test', '99999999');
  perform pg_temp.check_that(pg_temp.alerts(t, 'email_changed_by_worker') = 1, 'one e-mail alert');
  r := public.sub_admin_create_invoice(array[v_day], v_total);
  perform pg_temp.check_that((r->>'ok')::boolean, 'invoice created with an e-mail alert open');
  select id into v_ack from public.sub_notifications where subcontractor_id = v_sub and kind = 'email_changed_by_worker';
  perform public.sub_admin_ack_notification(v_ack);
  perform pg_temp.check_that((select acknowledged_at is not null from public.sub_notifications where id = v_ack), 'acknowledged');
end $$;

create function pg_temp.run_all() returns text language plpgsql as $$
declare
  name text;
  result text := '';
begin
  foreach name in array array['t1_email_only', 't2_email_then_bank', 't3_both_in_one_save', 't4_no_alert',
                              't5_rpc_without_page', 't6_only_bank_blocks'] loop
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
