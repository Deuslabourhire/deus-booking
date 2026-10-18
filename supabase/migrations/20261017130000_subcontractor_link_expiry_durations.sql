-- =====================================================================
-- Subcontractor links expire after 7 days without activity; durations in
-- 10-minute steps — TEST FIRST.
-- Target: deus-authtest (aaafpfkwpdpfamfuimki). NOT for production yet.
-- Requires 20261016130000_subcontractor_invoices.sql and 20261017120000_subcontractor_payments.sql.
--
-- Link expiry
--   * sub_links.last_activity_at = last VALID activity through the link: saving the
--     profile/bank details, saving or removing a day, or sending a record. Opening the
--     page (reading) does not renew it.
--   * A link stops working when now() > last_activity_at + sub_link_idle_limit() (7 days).
--     Checked in the database on EVERY call made with the link (reading included), so the
--     browser cannot bypass it. The error is 'link_expired' (the page asks for a new link).
--   * A link in regular use (e.g. two weeks of daily days) never expires.
--   * The Admin creates a new link for the SAME subcontractor (sub_admin_create_link
--     already revokes the old one): profile, days and records stay with the subcontractor.
--   * Records already sent are not touched: they stay pending/approved for payment and
--     the worker could not change them anyway (sent days are locked).
--   * Existing links: last_activity_at starts at their last use (or creation), so no
--     link in use is cut off by this migration.
--
-- Durations
--   * Unpaid break: 0–120 min, travel time: 0–240 min, in 10-minute steps (0, 10, 20 …),
--     validated in the database (sub_portal_save_day, sub_admin_adjust_day).
--   * Existing days are not changed. A day saved earlier with another value (e.g. 15 or
--     1 minute) keeps it; it may be saved again with that SAME value, but any new value
--     must follow the 10-minute rule.
-- =====================================================================

begin;

alter table public.sub_links add column last_activity_at timestamptz;
update public.sub_links set last_activity_at = greatest(created_at, coalesce(last_used_at, created_at));
alter table public.sub_links alter column last_activity_at set default now();
alter table public.sub_links alter column last_activity_at set not null;

create or replace function public.sub_link_idle_limit()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '7 days'; $$;

-- Resolve a raw link token to its subcontractor. p_activity = true for calls that save
-- something (renews the 7-day period); reading never renews it.
create or replace function public.sub_link_check(p_token text, p_activity boolean)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  l public.sub_links%rowtype;
  v_active boolean;
begin
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception 'invalid_link' using errcode = 'P0001';
  end if;
  select * into l from public.sub_links
  where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex') and revoked_at is null;
  select s.active into v_active from public.subcontractors s where s.id = l.subcontractor_id;
  if l.id is null or not coalesce(v_active, false) or (l.expires_at is not null and l.expires_at <= now()) then
    raise exception 'invalid_link' using errcode = 'P0001';
  end if;
  if l.last_activity_at <= now() - public.sub_link_idle_limit() then
    raise exception 'link_expired' using errcode = 'P0001';
  end if;
  update public.sub_links
     set last_used_at = now(),
         last_activity_at = case when p_activity then now() else last_activity_at end
   where id = l.id;
  return l.subcontractor_id;
end;
$$;

-- Read-only calls (opening the page, viewing a record, alert claims): checks expiry, no renewal.
create or replace function public.sub_resolve_token(p_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  return public.sub_link_check(p_token, false);
end;
$$;

-- 0..p_max minutes in 10-minute steps; p_keep = value already stored (allowed unchanged).
create or replace function public.sub_duration_ok(p_minutes int, p_max int, p_keep int)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_minutes is not null
     and (coalesce(p_minutes = p_keep, false) or (p_minutes between 0 and p_max and p_minutes % 10 = 0));
$$;

create or replace function public.sub_portal_save_profile(
  p_token text, p_full_name text, p_address text, p_email text, p_phone text, p_abn text,
  p_gst_registered boolean, p_bank_account_name text, p_bank_bsb text, p_bank_account_number text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub_id uuid;
  v_had_bank boolean;
  v_bank_changed boolean;
  v_email_before text;
begin
  v_sub_id := public.sub_link_check(p_token, true);
  v_had_bank := exists (select 1 from public.sub_bank_details where subcontractor_id = v_sub_id);
  -- the worker's warning goes to the address on file BEFORE this save
  select email into v_email_before from public.subcontractors where id = v_sub_id for update;
  perform public.sub_apply_profile(v_sub_id, p_full_name, p_address, p_email, p_phone, p_abn, p_gst_registered,
                                   null, 'profile_updated_by_worker', null);
  v_bank_changed := public.sub_apply_bank(v_sub_id, p_bank_account_name, p_bank_bsb, p_bank_account_number,
                                          null, 'bank_updated_by_worker', null, v_email_before);
  return jsonb_build_object('ok', true, 'bank_alert', v_had_bank and v_bank_changed);
end;
$$;

create or replace function public.sub_portal_save_day(
  p_token text, p_day_id uuid, p_work_date date, p_role text,
  p_start time, p_finish time, p_break_minutes int, p_travel_minutes int, p_notes text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub_id uuid;
  v_role   text := btrim(coalesce(p_role, ''));
  v_rate   numeric;
  v_old    public.sub_work_days%rowtype;
  c        record;
begin
  v_sub_id := public.sub_link_check(p_token, true);
  if p_work_date is null or p_work_date > public.sub_today() then raise exception 'date_invalid' using errcode = 'P0001'; end if;
  if p_work_date < public.sub_today() - 120 then raise exception 'date_too_old' using errcode = 'P0001'; end if;
  if v_role = '' or char_length(v_role) > 60 then raise exception 'role_required' using errcode = 'P0001'; end if;
  if p_day_id is not null then
    select * into v_old from public.sub_work_days where id = p_day_id and subcontractor_id = v_sub_id and invoice_id is null;
    if v_old.id is null then raise exception 'day_locked_or_missing' using errcode = 'P0001'; end if;
  end if;
  if not public.sub_duration_ok(coalesce(p_break_minutes, 0), 120, v_old.break_minutes) then
    raise exception 'break_invalid' using errcode = 'P0001';
  end if;
  if not public.sub_duration_ok(coalesce(p_travel_minutes, 0), 240, v_old.travel_minutes) then
    raise exception 'travel_invalid' using errcode = 'P0001';
  end if;
  -- rate set by the Admin for this subcontractor (captured on the day; later rate changes do not alter it)
  select hourly_rate into v_rate from public.subcontractors where id = v_sub_id;
  select * into c from public.sub_calc_day(p_start, p_finish, coalesce(p_break_minutes, 0), coalesce(p_travel_minutes, 0), v_rate);

  if p_day_id is null then
    insert into public.sub_work_days (subcontractor_id, work_date, role, start_time, finish_time,
      break_minutes, travel_minutes, notes, hourly_rate, travel_rate, work_hours, travel_hours, labour_amount, travel_amount)
    values (v_sub_id, p_work_date, v_role, p_start, p_finish, coalesce(p_break_minutes, 0), coalesce(p_travel_minutes, 0),
      nullif(btrim(p_notes), ''), v_rate, c.travel_rate, c.work_hours, c.travel_hours, c.labour_amount, c.travel_amount);
  else
    update public.sub_work_days set
      work_date = p_work_date, role = v_role, start_time = p_start, finish_time = p_finish,
      break_minutes = coalesce(p_break_minutes, 0), travel_minutes = coalesce(p_travel_minutes, 0),
      notes = nullif(btrim(p_notes), ''), hourly_rate = v_rate, travel_rate = c.travel_rate,
      work_hours = c.work_hours, travel_hours = c.travel_hours, labour_amount = c.labour_amount,
      travel_amount = c.travel_amount, updated_at = now()
    where id = p_day_id and subcontractor_id = v_sub_id and invoice_id is null;
    if not found then raise exception 'day_locked_or_missing' using errcode = 'P0001'; end if;
  end if;
  return jsonb_build_object('ok', true, 'open_days', public.sub_days_json(v_sub_id, null));
exception
  when unique_violation then raise exception 'day_duplicate' using errcode = 'P0001';
end;
$$;

create or replace function public.sub_portal_delete_day(p_token text, p_day_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub_id uuid;
begin
  v_sub_id := public.sub_link_check(p_token, true);
  delete from public.sub_work_days where id = p_day_id and subcontractor_id = v_sub_id and invoice_id is null;
  if not found then raise exception 'day_locked_or_missing' using errcode = 'P0001'; end if;
  return jsonb_build_object('ok', true, 'open_days', public.sub_days_json(v_sub_id, null));
end;
$$;

-- Same as before; sending counts as activity.
create or replace function public.sub_portal_submit(p_token text, p_declaration_accepted boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub_id  uuid;
  v_sub     public.subcontractors%rowtype;
  v_bank    public.sub_bank_details%rowtype;
  v_inv_id  uuid;
  v_number  text;
  v_count   int;
  v_inv     public.sub_invoices%rowtype;
begin
  v_sub_id := public.sub_link_check(p_token, true);
  -- serialise concurrent submits for the same subcontractor
  select * into v_sub from public.subcontractors where id = v_sub_id for update;
  select * into v_bank from public.sub_bank_details where subcontractor_id = v_sub_id;
  if p_declaration_accepted is not true then
    raise exception 'declaration_required' using errcode = 'P0001';
  end if;
  if v_sub.full_name is null or v_sub.address is null or v_sub.email is null or v_sub.abn is null
     or v_bank.subcontractor_id is null then
    raise exception 'profile_incomplete' using errcode = 'P0001';
  end if;
  select count(*) into v_count from public.sub_work_days where subcontractor_id = v_sub_id and invoice_id is null;
  if v_count = 0 then raise exception 'no_open_days' using errcode = 'P0001'; end if;

  v_number := 'SUB-' || to_char(public.sub_today(), 'YYYY') || '-' || lpad(nextval('public.sub_invoice_seq')::text, 5, '0');
  insert into public.sub_invoices (invoice_number, subcontractor_id, worker_snapshot, company_snapshot, gst_registered,
                                   declaration_text, declaration_version, declaration_accepted_at)
  values (v_number, v_sub_id,
    jsonb_build_object('full_name', v_sub.full_name, 'address', v_sub.address, 'email', v_sub.email,
                       'phone', v_sub.phone, 'abn', v_sub.abn, 'gst_registered', v_sub.gst_registered),
    (select jsonb_build_object('name', company_name, 'abn', company_abn, 'address', company_address) from public.sub_settings),
    v_sub.gst_registered,
    public.sub_declaration_text(), public.sub_declaration_version(), now())
  returning id into v_inv_id;
  insert into public.sub_invoice_bank (invoice_id, account_name, bsb, account_number)
  values (v_inv_id, v_bank.account_name, v_bank.bsb, v_bank.account_number);

  update public.sub_work_days set invoice_id = v_inv_id, updated_at = now()
  where subcontractor_id = v_sub_id and invoice_id is null;
  perform public.sub_recalc_invoice(v_inv_id);
  insert into public.sub_audit (action, subcontractor_id, invoice_id, new_data)
  values ('submitted', v_sub_id, v_inv_id, jsonb_build_object('days', v_count));

  select * into v_inv from public.sub_invoices where id = v_inv_id;
  return jsonb_build_object(
    'invoice_id', v_inv.id, 'invoice_number', v_inv.invoice_number, 'submitted_at', v_inv.submitted_at,
    'worker', v_inv.worker_snapshot, 'company', v_inv.company_snapshot,
    'labour_total', v_inv.labour_total, 'travel_total', v_inv.travel_total, 'subtotal', v_inv.subtotal,
    'gst_amount', v_inv.gst_amount, 'total', v_inv.total,
    'declaration_text', v_inv.declaration_text, 'declaration_accepted_at', v_inv.declaration_accepted_at,
    -- worker-safe day lines (no rates); the admin e-mail only says "review in Admin"
    'days', public.sub_days_json(v_sub_id, v_inv_id));
end;
$$;

-- Admin corrections follow the same duration rule (an existing value may be kept).
create or replace function public.sub_admin_adjust_day(
  p_day_id uuid, p_role text, p_start time, p_finish time,
  p_break_minutes int, p_travel_minutes int, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.sub_require_admin(p_reason, true);
  d      public.sub_work_days%rowtype;
  v_stat text;
  v_role text := btrim(coalesce(p_role, ''));
  c      record;
begin
  if v_role = '' or char_length(v_role) > 60 then raise exception 'role_required' using errcode = 'P0001'; end if;
  select * into d from public.sub_work_days where id = p_day_id for update;
  if d.id is null or d.invoice_id is null then raise exception 'day_not_submitted' using errcode = 'P0001'; end if;
  select status into v_stat from public.sub_invoices where id = d.invoice_id for update;
  if v_stat not in ('pending', 'approved') then raise exception 'invoice_closed' using errcode = 'P0001'; end if;
  if not public.sub_duration_ok(coalesce(p_break_minutes, 0), 120, d.break_minutes) then
    raise exception 'break_invalid' using errcode = 'P0001';
  end if;
  if not public.sub_duration_ok(coalesce(p_travel_minutes, 0), 240, d.travel_minutes) then
    raise exception 'travel_invalid' using errcode = 'P0001';
  end if;

  -- corrections keep the rate captured when the day was recorded
  select * into c from public.sub_calc_day(p_start, p_finish, coalesce(p_break_minutes, 0), coalesce(p_travel_minutes, 0), d.hourly_rate);

  update public.sub_work_days set
    role = v_role, start_time = p_start, finish_time = p_finish,
    break_minutes = coalesce(p_break_minutes, 0), travel_minutes = coalesce(p_travel_minutes, 0),
    travel_rate = c.travel_rate, work_hours = c.work_hours, travel_hours = c.travel_hours,
    labour_amount = c.labour_amount, travel_amount = c.travel_amount, admin_adjusted = true, updated_at = now()
  where id = p_day_id;
  perform public.sub_recalc_invoice(d.invoice_id);

  insert into public.sub_audit (actor, action, subcontractor_id, invoice_id, work_day_id, old_data, new_data, reason)
  values (v_actor, 'day_adjusted', d.subcontractor_id, d.invoice_id, d.id, to_jsonb(d),
          (select to_jsonb(x) from public.sub_work_days x where x.id = p_day_id), btrim(p_reason));
  return jsonb_build_object('ok', true);
end;
$$;

-- Function privileges: the new helpers are internal; replaced functions keep their grants,
-- restated here so this file is complete on its own.
revoke execute on function
  public.sub_link_idle_limit(), public.sub_link_check(text, boolean), public.sub_resolve_token(text),
  public.sub_duration_ok(int, int, int),
  public.sub_portal_save_profile(text, text, text, text, text, text, boolean, text, text, text),
  public.sub_portal_save_day(text, uuid, date, text, time, time, int, int, text),
  public.sub_portal_delete_day(text, uuid),
  public.sub_portal_submit(text, boolean),
  public.sub_admin_adjust_day(uuid, text, time, time, int, int, text)
from public, anon, authenticated;
grant execute on function
  public.sub_portal_save_profile(text, text, text, text, text, text, boolean, text, text, text),
  public.sub_portal_save_day(text, uuid, date, text, time, time, int, int, text),
  public.sub_portal_delete_day(text, uuid)
to anon, authenticated;
grant execute on function public.sub_portal_submit(text, boolean) to service_role;
grant execute on function public.sub_admin_adjust_day(uuid, text, time, time, int, int, text) to authenticated;

commit;
