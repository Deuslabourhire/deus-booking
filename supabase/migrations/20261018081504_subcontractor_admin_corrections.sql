-- =====================================================================
-- Admin corrections of sent records and readable history.
-- Applied on production as version 20261018081504.
-- Requires the three earlier subcontractor migrations. No table or data change:
-- one function is replaced and one read-only function is added.
--
-- Corrections (sub_admin_adjust_day)
--   * Hours (start, finish, unpaid break, travel) and the role/job of a day in a sent
--     record that is Pending or Approved. A reason (3+ characters) is required.
--   * The record keeps its status. Amounts and the record total are recalculated only
--     when the hours change; a role-only correction changes no amount.
--   * Saving with nothing changed is refused (no_change), so the history only holds
--     real corrections.
--   * History row: only the fields that changed, before -> after, plus the record total
--     before -> after; who (actor) and when come from sub_audit, with the reason.
--
-- History (sub_admin_invoice_history)
--   * Admin only. All history rows of one record, oldest first, with the e-mail of the
--     Admin who made each change (subcontractor/system changes have no Admin).
-- =====================================================================

begin;

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
  select * into d from public.sub_work_days where id = p_day_id for update;
  if d.id is null or d.invoice_id is null then raise exception 'day_not_submitted' using errcode = 'P0001'; end if;
  select status, total into v_stat, v_total_before from public.sub_invoices where id = d.invoice_id for update;
  if v_stat not in ('pending', 'approved') then raise exception 'invoice_closed' using errcode = 'P0001'; end if;
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
    perform public.sub_recalc_invoice(d.invoice_id);
  else
    -- role/job only: no amount changes, totals untouched
    update public.sub_work_days set role = v_role, admin_adjusted = true, updated_at = now() where id = p_day_id;
  end if;

  select * into n from public.sub_work_days where id = p_day_id;
  select total into v_total_after from public.sub_invoices where id = d.invoice_id;
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

create or replace function public.sub_admin_invoice_history(p_invoice_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.sub_require_admin(null, false);
begin
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'at', a.at, 'action', a.action, 'by', u.email, 'by_admin', a.actor is not null,
            'reason', a.reason, 'old', a.old_data, 'new', a.new_data) order by a.at, a.id), '[]'::jsonb)
          from public.sub_audit a
          left join auth.users u on u.id = a.actor
          where a.invoice_id = p_invoice_id);
end;
$$;

revoke execute on function
  public.sub_admin_adjust_day(uuid, text, time, time, int, int, text),
  public.sub_admin_invoice_history(uuid)
from public, anon, authenticated;
grant execute on function
  public.sub_admin_adjust_day(uuid, text, time, time, int, int, text),
  public.sub_admin_invoice_history(uuid)
to authenticated;

commit;
