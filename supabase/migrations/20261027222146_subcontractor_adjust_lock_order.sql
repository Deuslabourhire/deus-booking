-- REVIEW DRAFT ONLY. Assign a real migration version in the repository before use.
-- Replaces both admin day-correction functions so linked invoices are locked before days.
-- No database changes have been applied by preparing this file.
begin;
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'sub_work_days' and column_name = 'sent_at'
  ) then
    raise exception 'lock_order_precondition_failed: public.sub_work_days.sent_at is missing';
  end if;
  if to_regprocedure('public.sub_admin_adjust_day(uuid,text,time without time zone,time without time zone,integer,integer,text)') is null then
    raise exception 'lock_order_precondition_failed: sub_admin_adjust_day is missing';
  end if;
  if to_regprocedure('public.sub_admin_adjust_day_rate(uuid,text,time without time zone,time without time zone,integer,integer,numeric,text)') is null then
    raise exception 'lock_order_precondition_failed: sub_admin_adjust_day_rate is missing';
  end if;
end;
$$;

create or replace function public.sub_admin_adjust_day(
  p_day_id uuid, p_role text, p_start time, p_finish time,
  p_break_minutes int, p_travel_minutes int, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := public.sub_require_admin(p_reason, true);
  d        public.sub_work_days%rowtype;
  n        public.sub_work_days%rowtype;
  v_stat   text;
  v_inv    uuid;
  v_role   text := btrim(coalesce(p_role, ''));
  v_break  int := coalesce(p_break_minutes, 0);
  v_travel int := coalesce(p_travel_minutes, 0);
  v_hours_changed boolean;
  v_total_before numeric;
  v_total_after  numeric;
  v_old jsonb := '{}'; v_new jsonb := '{}'; k text;
  c        record;
begin
  if v_role = '' or char_length(v_role) > 60 then raise exception 'role_required' using errcode = 'P0001'; end if;
  -- Read the link without locking, then acquire locks in invoice -> day order.
  select invoice_id into v_inv from public.sub_work_days where id = p_day_id;
  if not found then raise exception 'day_not_submitted' using errcode = 'P0001'; end if;
  if v_inv is not null then
    select status, total into v_stat, v_total_before
      from public.sub_invoices where id = v_inv for update;
    if not found then raise exception 'day_changed' using errcode = 'P0001'; end if;
  end if;
  select * into d from public.sub_work_days where id = p_day_id for update;
  if d.id is null then raise exception 'day_not_submitted' using errcode = 'P0001'; end if;
  if d.invoice_id is distinct from v_inv then raise exception 'day_changed' using errcode = 'P0001'; end if;
  if d.invoice_id is null then
    if d.sent_at is null then raise exception 'day_not_submitted' using errcode = 'P0001'; end if;
    v_stat := 'awaiting_invoice';   -- sent by the worker, not in an invoice yet: no totals to update
  elsif v_stat not in ('pending', 'approved') then
    raise exception 'invoice_closed' using errcode = 'P0001';
  end if;
  if not public.sub_duration_ok(v_break, 120, d.break_minutes) then
    raise exception 'break_invalid' using errcode = 'P0001';
  end if;
  if not public.sub_duration_ok(v_travel, 240, d.travel_minutes) then
    raise exception 'travel_invalid' using errcode = 'P0001';
  end if;

  v_hours_changed := (p_start, p_finish, v_break, v_travel) is distinct from (d.start_time, d.finish_time, d.break_minutes, d.travel_minutes);
  if not v_hours_changed and v_role = d.role then raise exception 'no_change' using errcode = 'P0001'; end if;

  if v_hours_changed then
    -- corrections keep the rate captured when the day was recorded
    select * into c from public.sub_calc_day(p_start, p_finish, v_break, v_travel, d.hourly_rate);
    update public.sub_work_days set
      role = v_role, start_time = p_start, finish_time = p_finish, break_minutes = v_break, travel_minutes = v_travel,
      travel_rate = c.travel_rate, work_hours = c.work_hours, travel_hours = c.travel_hours,
      labour_amount = c.labour_amount, travel_amount = c.travel_amount, admin_adjusted = true, updated_at = now()
    where id = p_day_id;
    if d.invoice_id is not null then perform public.sub_recalc_invoice(d.invoice_id); end if;
  else
    -- role/job only: no amount changes, totals untouched
    update public.sub_work_days set role = v_role, admin_adjusted = true, updated_at = now() where id = p_day_id;
  end if;

  select * into n from public.sub_work_days where id = p_day_id;
  if d.invoice_id is not null then
    select total into v_total_after from public.sub_invoices where id = d.invoice_id;
  end if;
  foreach k in array array['role', 'start_time', 'finish_time', 'break_minutes', 'travel_minutes',
                           'work_hours', 'labour_amount', 'travel_amount'] loop
    if (to_jsonb(d) -> k) is distinct from (to_jsonb(n) -> k) then
      v_old := v_old || jsonb_build_object(k, to_jsonb(d) -> k);
      v_new := v_new || jsonb_build_object(k, to_jsonb(n) -> k);
    end if;
  end loop;
  v_old := v_old || jsonb_build_object('work_date', d.work_date, 'record_total', v_total_before);
  v_new := v_new || jsonb_build_object('work_date', d.work_date, 'record_total', v_total_after);

  insert into public.sub_audit (actor, action, subcontractor_id, invoice_id, work_day_id, old_data, new_data, reason)
  values (v_actor, 'day_adjusted', d.subcontractor_id, d.invoice_id, d.id, v_old, v_new, btrim(p_reason));
  return jsonb_build_object('ok', true, 'status', v_stat, 'total_before', v_total_before, 'total_after', v_total_after,
                            'amounts_changed', v_hours_changed);
end;
$$;

create or replace function public.sub_admin_adjust_day_rate(
  p_day_id uuid, p_role text, p_start time, p_finish time,
  p_break_minutes int, p_travel_minutes int, p_hourly_rate numeric, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := public.sub_require_admin(p_reason, true);
  d public.sub_work_days%rowtype;
  n public.sub_work_days%rowtype;
  v_stat text;
  v_inv uuid;
  v_role text := btrim(coalesce(p_role, ''));
  v_break int := coalesce(p_break_minutes, 0);
  v_travel int := coalesce(p_travel_minutes, 0);
  v_rate numeric := round(p_hourly_rate, 2);
  v_hours_changed boolean;
  v_rate_changed boolean;
  v_amounts_changed boolean;
  v_total_before numeric;
  v_total_after numeric;
  v_old jsonb := '{}';
  v_new jsonb := '{}';
  k text;
  c record;
begin
  if v_role = '' or char_length(v_role) > 60 then raise exception 'role_required' using errcode = 'P0001'; end if;
  -- checked after rounding to cents (the stored value), same limits as the subcontractor's default rate
  if v_rate is null or v_rate <= 0 or v_rate >= 1000 then raise exception 'rate_invalid' using errcode = 'P0001'; end if;
  -- Read the link without locking, then acquire locks in invoice -> day order.
  select invoice_id into v_inv from public.sub_work_days where id = p_day_id;
  if not found then raise exception 'day_not_submitted' using errcode = 'P0001'; end if;
  if v_inv is not null then
    select status, total into v_stat, v_total_before
      from public.sub_invoices where id = v_inv for update;
    if not found then raise exception 'day_changed' using errcode = 'P0001'; end if;
  end if;
  select * into d from public.sub_work_days where id = p_day_id for update;
  if d.id is null or (d.invoice_id is null and d.sent_at is null) then
    raise exception 'day_not_submitted' using errcode = 'P0001';
  end if;
  if d.invoice_id is distinct from v_inv then raise exception 'day_changed' using errcode = 'P0001'; end if;
  if d.invoice_id is null then
    v_stat := 'awaiting_invoice';
  elsif v_stat not in ('pending', 'approved') then
    raise exception 'invoice_closed' using errcode = 'P0001';
  end if;
  if not public.sub_duration_ok(v_break, 120, d.break_minutes) then raise exception 'break_invalid' using errcode = 'P0001'; end if;
  if not public.sub_duration_ok(v_travel, 240, d.travel_minutes) then raise exception 'travel_invalid' using errcode = 'P0001'; end if;

  v_hours_changed := (p_start, p_finish, v_break, v_travel) is distinct from (d.start_time, d.finish_time, d.break_minutes, d.travel_minutes);
  v_rate_changed := v_rate is distinct from d.hourly_rate;
  v_amounts_changed := v_hours_changed or v_rate_changed;
  if not v_amounts_changed and v_role = d.role then raise exception 'no_change' using errcode = 'P0001'; end if;

  if v_amounts_changed then
    select * into c from public.sub_calc_day(p_start, p_finish, v_break, v_travel, v_rate);
    update public.sub_work_days set
      role = v_role, start_time = p_start, finish_time = p_finish,
      break_minutes = v_break, travel_minutes = v_travel, hourly_rate = v_rate,
      travel_rate = c.travel_rate, work_hours = c.work_hours, travel_hours = c.travel_hours,
      labour_amount = c.labour_amount, travel_amount = c.travel_amount,
      admin_adjusted = true, updated_at = now()
    where id = p_day_id;
    if d.invoice_id is not null then perform public.sub_recalc_invoice(d.invoice_id); end if;
  else
    update public.sub_work_days set role = v_role, admin_adjusted = true, updated_at = now() where id = p_day_id;
  end if;

  select * into n from public.sub_work_days where id = p_day_id;
  if d.invoice_id is not null then select total into v_total_after from public.sub_invoices where id = d.invoice_id; end if;
  foreach k in array array[
    'role', 'start_time', 'finish_time', 'break_minutes', 'travel_minutes',
    'hourly_rate', 'travel_rate', 'work_hours', 'travel_hours', 'labour_amount', 'travel_amount'
  ] loop
    if (to_jsonb(d) -> k) is distinct from (to_jsonb(n) -> k) then
      v_old := v_old || jsonb_build_object(k, to_jsonb(d) -> k);
      v_new := v_new || jsonb_build_object(k, to_jsonb(n) -> k);
    end if;
  end loop;
  v_old := v_old || jsonb_build_object('work_date', d.work_date, 'record_total', v_total_before);
  v_new := v_new || jsonb_build_object('work_date', n.work_date, 'record_total', v_total_after);
  insert into public.sub_audit (actor, action, subcontractor_id, invoice_id, work_day_id, old_data, new_data, reason)
  values (v_actor, 'day_adjusted', d.subcontractor_id, d.invoice_id, d.id, v_old, v_new, btrim(p_reason));
  return jsonb_build_object('ok', true, 'status', v_stat, 'total_before', v_total_before, 'total_after', v_total_after,
    'amounts_changed', v_amounts_changed, 'rate_changed', v_rate_changed);
end;
$$;
revoke execute on function public.sub_admin_adjust_day(uuid, text, time, time, int, int, text) from public, anon, authenticated;
grant execute on function public.sub_admin_adjust_day(uuid, text, time, time, int, int, text) to authenticated;

revoke execute on function public.sub_admin_adjust_day_rate(uuid, text, time, time, int, int, numeric, text) from public, anon, authenticated;
grant execute on function public.sub_admin_adjust_day_rate(uuid, text, time, time, int, int, numeric, text) to authenticated;

commit;
