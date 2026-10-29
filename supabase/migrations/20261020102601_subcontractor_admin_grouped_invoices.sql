-- =====================================================================
-- Subcontractor invoices grouped by the Admin. TEST FIRST (deus-authtest); NOT on production.
-- Version 20261020120000: after 20261017150000 (e-mail resend). Requires the five earlier
-- subcontractor migrations.
--
-- New flow
--   1. The worker records days through the personal link (unchanged) and SENDS days
--      (sub_portal_send_days): each sent day is locked for the worker, carries the declaration
--      the worker accepted, and waits for the office. Sending no longer creates an invoice.
--   2. The Admin ticks sent days of ONE subcontractor (any weeks) and confirms
--      (sub_admin_create_invoice): ONE invoice with ONE number (same SUB-YYYY-NNNNN sequence),
--      one line per day, totals from those days, bank details and worker details taken at that
--      moment. Each day can belong to one invoice only (row locks + invoice_id), so it cannot be
--      invoiced or paid twice.
--   3. The invoice is the same row for Admin and worker (sub_portal_get / sub_portal_get_invoice).
--      Invoices made this way (flag "grouped") are shown with one line per day: date, work, and the
--      day's amount INCLUDING travel; then the totals. The worker never sees rates. Older records
--      keep their original layout (days + one travel-time line) in every view and e-mail.
--   4. Payments, Undo and corrections work on the invoice exactly as before.
--   5. Cancelling an invoice made by the Admin (reason required; refused while it is paid —
--      undo the payment first): the invoice is kept with its number, totals and a frozen copy of
--      its original lines (cancelled_lines), and its days go back to "waiting for an invoice" so
--      they can be put into a NEW invoice (new number; a cancelled number is never reused).
--      A day is therefore in at most ONE invoice that is not cancelled.
--
-- Existing data is not changed
--   * New columns are nullable and have no default: existing rows keep NULL ("sent with the old
--     flow"). No UPDATE of existing rows in this file.
--   * Old invoices keep their numbers, days, totals, payments, e-mail states and history.
--   * Changed functions behave exactly as before for rows created by the old flow
--     (save/delete day, the cancel guard, cancelling an old invoice keeps its days as before).
--     Day lists only gain an "amount" field (labour + travel of that day); invoice data gains a
--     "grouped" flag (false for every older record, which keeps its original layout).
--
-- The old "send all open days = new invoice" path (sub_portal_submit) is switched off: it now
-- refuses with flow_changed, so a page still open with the old version cannot create invoices.
--
-- E-mails (no new sending code)
--   * Sending days: no e-mail (the Admin sees the days in Admin → Subcontractors).
--   * Invoice created by the Admin: the copy to the subcontractor AND the copy to the office go
--     through the existing resend path (sub_admin_email_claim → Edge Function →
--     sub_record_email_result), so the duplicate rules, the 23 h window and the cancel guard
--     apply. Their delivery rows are created here as "never sent".
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- Columns (nullable, no default: existing rows are left as they are)
-- ---------------------------------------------------------------------
alter table public.sub_work_days add column sent_at timestamptz;
alter table public.sub_work_days add column declaration_version text;
alter table public.sub_work_days add column declaration_accepted_at timestamptz;
alter table public.sub_work_days add constraint sub_work_days_sent_declared
  check (sent_at is null or (declaration_accepted_at is not null and declaration_version is not null));
create index sub_work_days_awaiting_idx on public.sub_work_days (subcontractor_id)
  where invoice_id is null and sent_at is not null;

-- Admin who grouped the days. NULL = invoice sent by the worker with the old flow.
alter table public.sub_invoices add column grouped_by uuid;
-- Original lines of an invoice made by the Admin, frozen when it is cancelled (its days are then
-- free again). NULL for every other invoice.
alter table public.sub_invoices add column cancelled_lines jsonb;

-- ---------------------------------------------------------------------
-- Day lists
-- ---------------------------------------------------------------------
-- p_invoice_id null = days the worker can still change (not sent). Rows of the old flow never
-- have sent_at, so the result for them is the same as before.
create or replace function public.sub_days_json(p_sub_id uuid, p_invoice_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', d.id, 'work_date', d.work_date, 'role', d.role, 'job_type', d.role,
           'start_time', to_char(d.start_time, 'HH24:MI'), 'finish_time', to_char(d.finish_time, 'HH24:MI'),
           'break_minutes', d.break_minutes, 'travel_minutes', d.travel_minutes, 'notes', d.notes,
           'work_hours', d.work_hours, 'labour_amount', d.labour_amount, 'travel_amount', d.travel_amount,
           'amount', d.labour_amount + d.travel_amount, 'sent_at', d.sent_at)
         order by d.work_date, d.start_time), '[]'::jsonb)
  from public.sub_work_days d
  where d.subcontractor_id = p_sub_id
    and d.invoice_id is not distinct from p_invoice_id
    and (p_invoice_id is not null or d.sent_at is null);
$$;

-- Days sent by the worker and not yet in an invoice (worker view: hours and amounts, no rates).
create or replace function public.sub_sent_days_json(p_sub_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', d.id, 'work_date', d.work_date, 'role', d.role, 'job_type', d.role,
           'start_time', to_char(d.start_time, 'HH24:MI'), 'finish_time', to_char(d.finish_time, 'HH24:MI'),
           'break_minutes', d.break_minutes, 'travel_minutes', d.travel_minutes, 'notes', d.notes,
           'work_hours', d.work_hours, 'labour_amount', d.labour_amount, 'travel_amount', d.travel_amount,
           'amount', d.labour_amount + d.travel_amount, 'sent_at', d.sent_at)
         order by d.work_date, d.start_time), '[]'::jsonb)
  from public.sub_work_days d
  where d.subcontractor_id = p_sub_id and d.invoice_id is null and d.sent_at is not null;
$$;

-- Lines of one invoice as the worker sees them (no rates): the frozen original lines of a cancelled
-- invoice made by the Admin, otherwise its current days.
create or replace function public.sub_invoice_lines_json(p_invoice_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when i.cancelled_lines is not null then
           (select coalesce(jsonb_agg(l - 'hourly_rate' - 'travel_rate' - 'travel_hours' - 'admin_adjusted'
                                      order by l->>'work_date', l->>'start_time'), '[]'::jsonb)
              from jsonb_array_elements(i.cancelled_lines) l)
         else public.sub_days_json(i.subcontractor_id, i.id) end
  from public.sub_invoices i where i.id = p_invoice_id;
$$;

-- ---------------------------------------------------------------------
-- Worker: save / delete a day (only days not sent yet)
-- ---------------------------------------------------------------------
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
    select * into v_old from public.sub_work_days
     where id = p_day_id and subcontractor_id = v_sub_id and invoice_id is null and sent_at is null;
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
    where id = p_day_id and subcontractor_id = v_sub_id and invoice_id is null and sent_at is null;
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
  delete from public.sub_work_days
   where id = p_day_id and subcontractor_id = v_sub_id and invoice_id is null and sent_at is null;
  if not found then raise exception 'day_locked_or_missing' using errcode = 'P0001'; end if;
  return jsonb_build_object('ok', true, 'open_days', public.sub_days_json(v_sub_id, null));
end;
$$;

-- ---------------------------------------------------------------------
-- Worker: send days (p_day_ids null = all days not sent yet). No invoice is created.
-- ---------------------------------------------------------------------
create or replace function public.sub_portal_send_days(p_token text, p_day_ids uuid[], p_declaration_accepted boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub_id uuid;
  v_sub    public.subcontractors%rowtype;
  v_bank   public.sub_bank_details%rowtype;
  v_ids    uuid[];
  v_n      int;
  v_done   int;
begin
  v_sub_id := public.sub_link_check(p_token, true);
  -- same lock order as the Admin creating an invoice: subcontractor first, then the days
  select * into v_sub from public.subcontractors where id = v_sub_id for update;
  select * into v_bank from public.sub_bank_details where subcontractor_id = v_sub_id;
  if p_declaration_accepted is not true then
    raise exception 'declaration_required' using errcode = 'P0001';
  end if;
  if v_sub.full_name is null or v_sub.address is null or v_sub.email is null or v_sub.abn is null
     or v_bank.subcontractor_id is null then
    raise exception 'profile_incomplete' using errcode = 'P0001';
  end if;
  if p_day_ids is null then
    select coalesce(array_agg(id order by id), '{}') into v_ids from public.sub_work_days
     where subcontractor_id = v_sub_id and invoice_id is null and sent_at is null;
  else
    select coalesce(array_agg(distinct x), '{}') into v_ids from unnest(p_day_ids) x where x is not null;
  end if;
  v_n := coalesce(array_length(v_ids, 1), 0);
  if v_n = 0 then raise exception 'no_open_days' using errcode = 'P0001'; end if;
  if v_n > 100 then raise exception 'too_many_days' using errcode = 'P0001'; end if;

  perform 1 from public.sub_work_days where id = any(v_ids) order by id for update;
  update public.sub_work_days
     set sent_at = now(), declaration_version = public.sub_declaration_version(),
         declaration_accepted_at = now(), updated_at = now()
   where id = any(v_ids) and subcontractor_id = v_sub_id and invoice_id is null and sent_at is null;
  get diagnostics v_done = row_count;
  -- every requested day must be the worker's own and not sent yet; otherwise nothing is sent
  if v_done <> v_n then raise exception 'day_locked_or_missing' using errcode = 'P0001'; end if;

  insert into public.sub_audit (action, subcontractor_id, new_data)
  values ('days_sent', v_sub_id, jsonb_build_object('days', v_n, 'day_ids', to_jsonb(v_ids),
          'work_dates', (select jsonb_agg(work_date order by work_date) from public.sub_work_days where id = any(v_ids)),
          'declaration_version', public.sub_declaration_version()));
  return jsonb_build_object('ok', true, 'sent', v_n,
    'open_days', public.sub_days_json(v_sub_id, null), 'sent_days', public.sub_sent_days_json(v_sub_id));
end;
$$;

-- Old path ("send all open days" = new invoice made by the worker): switched off.
create or replace function public.sub_portal_submit(p_token text, p_declaration_accepted boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'flow_changed' using errcode = 'P0001';
end;
$$;

-- Worker page data: + days sent and waiting for an invoice.
create or replace function public.sub_portal_get(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub_id uuid;
  v_sub    public.subcontractors%rowtype;
  v_bank   public.sub_bank_details%rowtype;
begin
  v_sub_id := public.sub_resolve_token(p_token);
  select * into v_sub from public.subcontractors where id = v_sub_id;
  select * into v_bank from public.sub_bank_details where subcontractor_id = v_sub_id;
  return jsonb_build_object(
    'company', (select jsonb_build_object('name', company_name, 'abn', company_abn, 'address', company_address) from public.sub_settings),
    'profile', jsonb_build_object(
        'display_name', v_sub.display_name, 'full_name', v_sub.full_name, 'address', v_sub.address,
        'email', v_sub.email, 'phone', v_sub.phone, 'abn', v_sub.abn, 'gst_registered', v_sub.gst_registered,
        -- the worker's OWN bank details (only reachable with their own link)
        'bank_account_name', v_bank.account_name, 'bank_bsb', v_bank.bsb, 'bank_account_number', v_bank.account_number),
    -- suggestions for the "Role" field only (free text; the rate does not depend on it)
    'role_suggestions', jsonb_build_array('Removalist', 'Offsider', 'Driver', 'Cleaner'),
    'open_days', public.sub_days_json(v_sub_id, null),
    'sent_days', public.sub_sent_days_json(v_sub_id),
    'invoices', (select coalesce(jsonb_agg(x.o order by x.submitted_at desc), '[]'::jsonb) from (
                   select i.submitted_at, jsonb_build_object('invoice_number', i.invoice_number,
                          'submitted_at', i.submitted_at, 'status', i.status, 'total', i.total, 'paid_at', i.paid_at,
                          'days', coalesce(jsonb_array_length(i.cancelled_lines),
                                           (select count(*) from public.sub_work_days d where d.invoice_id = i.id)),
                          'payment_number', (select payment_number from public.sub_payments where id = i.payment_id)) as o
                   from public.sub_invoices i where i.subcontractor_id = v_sub_id
                   order by i.submitted_at desc limit 20) x),
    'declaration', jsonb_build_object('version', public.sub_declaration_version(), 'text', public.sub_declaration_text()),
    'today', public.sub_today());
end;
$$;

-- Worker view of one invoice: same as before; lines from sub_invoice_lines_json; + "grouped".
create or replace function public.sub_portal_get_invoice(p_token text, p_invoice_number text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub_id uuid;
  i public.sub_invoices%rowtype;
begin
  v_sub_id := public.sub_resolve_token(p_token);
  select * into i from public.sub_invoices where invoice_number = p_invoice_number and subcontractor_id = v_sub_id;
  if i.id is null then raise exception 'not_found' using errcode = 'P0001'; end if;
  return jsonb_build_object(
    'invoice_number', i.invoice_number, 'submitted_at', i.submitted_at, 'status', i.status, 'paid_at', i.paid_at,
    'payment_method', i.payment_method, 'payment_reference', i.payment_reference,
    'payment_number', (select payment_number from public.sub_payments where id = i.payment_id),
    'worker', i.worker_snapshot, 'company', i.company_snapshot,
    'declaration_text', i.declaration_text, 'declaration_accepted_at', i.declaration_accepted_at,
    'days', public.sub_invoice_lines_json(i.id),
    'labour_total', i.labour_total, 'travel_total', i.travel_total,
    'subtotal', i.subtotal, 'gst_amount', i.gst_amount, 'total', i.total,
    -- true = invoice made by the Admin from sent days: shown with one line per day (travel included);
    -- older records keep their original layout
    'grouped', i.grouped_by is not null);
end;
$$;

-- ---------------------------------------------------------------------
-- Admin: one invoice from selected sent days of ONE subcontractor
-- ---------------------------------------------------------------------
create or replace function public.sub_admin_create_invoice(p_day_ids uuid[], p_expected_total numeric)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := public.sub_require_admin(null, false);
  v_ids     uuid[];
  v_n       int;
  v_sub_id  uuid;
  v_sub     public.subcontractors%rowtype;
  v_bank    public.sub_bank_details%rowtype;
  v_amount  numeric;
  v_total   numeric;
  v_inv_id  uuid;
  v_number  text;
  v_inv     public.sub_invoices%rowtype;
begin
  select coalesce(array_agg(distinct x), '{}') into v_ids from unnest(coalesce(p_day_ids, '{}'::uuid[])) x where x is not null;
  v_n := coalesce(array_length(v_ids, 1), 0);
  if v_n = 0 then raise exception 'no_days_selected' using errcode = 'P0001'; end if;
  if v_n > 100 then raise exception 'too_many_days' using errcode = 'P0001'; end if;
  if (select count(*) from public.sub_work_days where id = any(v_ids)) <> v_n then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if (select count(distinct subcontractor_id) from public.sub_work_days where id = any(v_ids)) <> 1 then
    raise exception 'mixed_subcontractors' using errcode = 'P0001';
  end if;
  select subcontractor_id into v_sub_id from public.sub_work_days where id = v_ids[1];

  -- Lock order: subcontractor (same as the worker sending days and a bank change), then the days
  -- in a fixed order. A second Admin selecting the same days waits here and is then refused.
  select * into v_sub from public.subcontractors where id = v_sub_id for update;
  perform 1 from public.sub_work_days where id = any(v_ids) order by id for update;
  if exists (select 1 from public.sub_work_days
              where id = any(v_ids) and (invoice_id is not null or sent_at is null or subcontractor_id <> v_sub_id)) then
    raise exception 'day_not_available' using errcode = 'P0001';
  end if;

  -- Bank details are copied into the invoice now: not while a bank change is unreviewed.
  if exists (select 1 from public.sub_notifications
              where subcontractor_id = v_sub_id and kind = 'bank_changed_by_worker' and acknowledged_at is null) then
    raise exception 'bank_alert_pending' using errcode = 'P0001';
  end if;
  select * into v_bank from public.sub_bank_details where subcontractor_id = v_sub_id;
  if v_sub.full_name is null or v_sub.address is null or v_sub.email is null or v_sub.abn is null
     or v_bank.subcontractor_id is null then
    raise exception 'profile_incomplete' using errcode = 'P0001';
  end if;

  -- The Admin confirms the total they saw; any change since then (correction, GST flag) refuses.
  select sum(labour_amount + travel_amount) into v_amount from public.sub_work_days where id = any(v_ids);
  v_total := v_amount + case when v_sub.gst_registered then round(v_amount * 0.10, 2) else 0 end;
  if p_expected_total is null or round(p_expected_total, 2) <> v_total then
    raise exception 'total_changed' using errcode = 'P0001';
  end if;

  v_number := 'SUB-' || to_char(public.sub_today(), 'YYYY') || '-' || lpad(nextval('public.sub_invoice_seq')::text, 5, '0');
  insert into public.sub_invoices (invoice_number, subcontractor_id, worker_snapshot, company_snapshot, gst_registered,
                                   declaration_text, declaration_version, declaration_accepted_at, grouped_by)
  values (v_number, v_sub_id,
    jsonb_build_object('full_name', v_sub.full_name, 'address', v_sub.address, 'email', v_sub.email,
                       'phone', v_sub.phone, 'abn', v_sub.abn, 'gst_registered', v_sub.gst_registered),
    (select jsonb_build_object('name', company_name, 'abn', company_abn, 'address', company_address) from public.sub_settings),
    v_sub.gst_registered,
    -- each day carries its own acceptance; the invoice shows the latest one
    public.sub_declaration_text(),
    (select max(declaration_version) from public.sub_work_days where id = any(v_ids)),
    (select max(declaration_accepted_at) from public.sub_work_days where id = any(v_ids)),
    v_actor)
  returning id into v_inv_id;
  insert into public.sub_invoice_bank (invoice_id, account_name, bsb, account_number)
  values (v_inv_id, v_bank.account_name, v_bank.bsb, v_bank.account_number);

  update public.sub_work_days set invoice_id = v_inv_id, updated_at = now() where id = any(v_ids);
  perform public.sub_recalc_invoice(v_inv_id);

  -- E-mail state: neither copy has been sent yet (the Admin page sends both right after this).
  insert into public.sub_email_deliveries (kind, ref_id, status, attempts) values
    ('record_worker', v_inv_id, null, 0),
    ('record_admin', v_inv_id, null, 0);

  insert into public.sub_audit (actor, action, subcontractor_id, invoice_id, new_data)
  values (v_actor, 'invoice_created', v_sub_id, v_inv_id, jsonb_build_object(
    'invoice_number', v_number, 'days', v_n, 'day_ids', to_jsonb(v_ids), 'total', v_total,
    'work_dates', (select jsonb_agg(work_date order by work_date) from public.sub_work_days where id = any(v_ids))));

  select * into v_inv from public.sub_invoices where id = v_inv_id;
  return jsonb_build_object('ok', true, 'invoice_id', v_inv.id, 'invoice_number', v_inv.invoice_number,
                            'days', v_n, 'subtotal', v_inv.subtotal, 'gst_amount', v_inv.gst_amount, 'total', v_inv.total);
end;
$$;

-- ---------------------------------------------------------------------
-- Admin corrections: also allowed on sent days that are not in an invoice yet
-- ---------------------------------------------------------------------
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
  if d.id is null or (d.invoice_id is null and d.sent_at is null) then raise exception 'day_not_submitted' using errcode = 'P0001'; end if;
  if d.invoice_id is not null then
    select status, total into v_stat, v_total_before from public.sub_invoices where id = d.invoice_id for update;
    if v_stat not in ('pending', 'approved') then raise exception 'invoice_closed' using errcode = 'P0001'; end if;
  else
    v_stat := 'awaiting_invoice';   -- sent by the worker, not in an invoice yet: no totals to update
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

-- ---------------------------------------------------------------------
-- E-mail rules for invoices created by the Admin
-- ---------------------------------------------------------------------
-- Cancel / Undo guard. The "copies just after submit" rule only applies to invoices sent by the
-- worker with the old flow (their copies were sent by the submit call). Invoices made by the
-- Admin send the copy through the claim, which is covered by the second check.
create or replace function public.sub_email_block_close()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- (nested IF: a sub_payments row has no such columns, and PL/pgSQL does not short-circuit)
  if tg_table_name = 'sub_invoices' then
    if old.grouped_by is null
       and (old.worker_email_status is null or old.admin_email_status is null)
       and old.submitted_at > now() - public.sub_alert_lease() then
      raise exception 'email_in_progress' using errcode = 'P0001';
    end if;
  end if;
  if exists (select 1 from public.sub_email_deliveries d
              where d.ref_id = new.id and d.status = 'sending'
                and d.last_attempt_at > now() - public.sub_alert_lease()
                and d.kind = any (case when tg_table_name = 'sub_payments' then array['payment_notice']
                                       else array['record_worker', 'record_admin'] end)) then
    raise exception 'email_in_progress' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- Copies of a record (resend path): unchanged except the "grouped" flag in the data, so the e-mail
-- of an invoice made by the Admin uses one line per day and older records keep their original layout.
create or replace function public.sub_admin_email_claim(p_kind text, p_id uuid, p_confirm_unknown boolean, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := public.sub_require_admin(null, false);
  r        public.sub_email_deliveries%rowtype;
  v_class  text;
  v_window boolean;
  v_key    text;
  v_token  uuid := gen_random_uuid();
  v_base   text;
  inv      public.sub_invoices%rowtype;
  p        public.sub_payments%rowtype;
  v_data   jsonb;
  v_to     text;
begin
  -- Lock the record / payment FIRST (same order as the result recording below), and keep it locked
  -- while checking it and building the e-mail. A cancel or an Undo that commits first is seen here
  -- (no e-mail); one that comes later waits for this transaction and is then refused while the
  -- attempt is in progress (trigger sub_email_block_close).
  if p_kind in ('record_worker', 'record_admin') then
    select * into inv from public.sub_invoices where id = p_id for update;
    if inv.id is null then raise exception 'not_found' using errcode = 'P0001'; end if;
    if inv.status = 'cancelled' then raise exception 'invoice_closed' using errcode = 'P0001'; end if;
  elsif p_kind = 'payment_notice' then
    select * into p from public.sub_payments where id = p_id for update;
    if p.id is null then raise exception 'not_found' using errcode = 'P0001'; end if;
    if p.voided_at is not null then raise exception 'payment_voided' using errcode = 'P0001'; end if;
  else
    raise exception 'kind_invalid' using errcode = 'P0001';
  end if;
  r := public.sub_email_row(p_kind, p_id);
  v_class := public.sub_email_class(r);
  v_window := r.first_attempt_at is null or r.first_attempt_at > now() - public.sub_alert_retry_window();
  if v_class = 'done' then raise exception 'already_sent' using errcode = 'P0001'; end if;
  if v_class = 'in_progress' then raise exception 'in_progress' using errcode = 'P0001'; end if;
  if v_class = 'unknown' and not v_window then
    if p_confirm_unknown is not true then raise exception 'unknown_needs_confirmation' using errcode = 'P0001'; end if;
    if p_reason is null or char_length(btrim(p_reason)) < 3 then raise exception 'reason_required' using errcode = 'P0001'; end if;
  end if;

  if p_kind in ('record_worker', 'record_admin') then
    v_base := 'sub-record-' || p_id || case when p_kind = 'record_worker' then '-worker' else '-admin' end;
    v_to := case when p_kind = 'record_worker' then inv.worker_snapshot->>'email' end;   -- admin address: function setting
    v_data := jsonb_build_object(
      'invoice_id', inv.id, 'invoice_number', inv.invoice_number, 'submitted_at', inv.submitted_at,
      'worker', inv.worker_snapshot, 'company', inv.company_snapshot,
      'labour_total', inv.labour_total, 'travel_total', inv.travel_total, 'subtotal', inv.subtotal,
      'gst_amount', inv.gst_amount, 'total', inv.total,
      'declaration_text', inv.declaration_text, 'declaration_accepted_at', inv.declaration_accepted_at,
      'days', public.sub_days_json(inv.subcontractor_id, inv.id),
      'grouped', inv.grouped_by is not null);
  else
    v_base := 'sub-payment-' || p_id;
    -- the address recorded at payment time; if there was none, the current profile address
    v_to := coalesce(p.notice_email, (select email from public.subcontractors where id = p.subcontractor_id));
    v_data := jsonb_build_object(
      'payment_id', p.id, 'payment_number', p.payment_number, 'paid_at', p.paid_at,
      'payment_method', p.payment_method, 'payment_reference', p.payment_reference, 'total', p.total,
      'bank_masked', p.bank_masked, 'email', v_to,
      'worker', (select coalesce(full_name, display_name) from public.subcontractors where id = p.subcontractor_id),
      'company', (select company_name from public.sub_settings),
      'invoices', (select jsonb_agg(jsonb_build_object('invoice_number', invoice_number, 'amount', amount) order by invoice_number)
                   from public.sub_payment_items where payment_id = p.id));
  end if;

  -- Same key inside the window (provider de-duplicates); a new key after it.
  v_key := case when v_window then v_base else v_base || '-r' || (r.attempts + 1) end;
  update public.sub_email_deliveries
     set status = 'sending', attempts = attempts + 1, attempt_token = v_token, idem_key = v_key,
         first_attempt_at = coalesce(first_attempt_at, now()), last_attempt_at = now()
   where kind = p_kind and ref_id = p_id;
  if p_kind = 'payment_notice' then
    update public.sub_payments set notice_attempts = notice_attempts + 1 where id = p_id;
  end if;
  insert into public.sub_audit (actor, action, subcontractor_id, invoice_id, old_data, new_data, reason)
  values (v_actor, 'email_send_started',
          coalesce(inv.subcontractor_id, p.subcontractor_id), inv.id,
          jsonb_build_object('status', r.status, 'class', v_class),
          jsonb_build_object('kind', p_kind, 'attempt', r.attempts + 1, 'window_open', v_window,
                             'new_key', not v_window, 'confirmed_unknown', v_class = 'unknown' and not v_window),
          nullif(btrim(coalesce(p_reason, '')), ''));
  return jsonb_build_object('kind', p_kind, 'id', p_id, 'attempt_token', v_token, 'idem_key', v_key,
                            'to', v_to, 'data', v_data);
end;
$$;

-- ---------------------------------------------------------------------
-- Status changes. Same rules as before; NEW: cancelling an invoice made by the Admin freezes its
-- lines in cancelled_lines and frees its days for a new invoice. Old invoices keep their days.
-- ---------------------------------------------------------------------
create or replace function public.sub_admin_set_status(
  p_invoice_id uuid, p_status text, p_paid_at date default null,
  p_payment_method text default null, p_payment_reference text default null, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.sub_require_admin(null, false);
  v_old public.sub_invoices%rowtype;
  v_lines jsonb;
  v_ids   uuid[];
begin
  if p_status = 'paid' then raise exception 'use_record_payment' using errcode = 'P0001'; end if;
  select * into v_old from public.sub_invoices where id = p_invoice_id for update;
  if v_old.id is null then raise exception 'not_found' using errcode = 'P0001'; end if;
  if v_old.status = 'paid' or v_old.payment_id is not null then raise exception 'use_void_payment' using errcode = 'P0001'; end if;
  if not (
       (v_old.status = 'pending'  and p_status in ('approved', 'cancelled'))
    or (v_old.status = 'approved' and p_status in ('pending', 'cancelled'))
  ) then
    raise exception 'transition_not_allowed' using errcode = 'P0001';
  end if;
  if p_status = 'cancelled' then
    perform public.sub_require_admin(p_note, true);
  end if;

  -- (the cancel guard trigger runs here: refused while a copy of this invoice is being sent)
  update public.sub_invoices set
    status = p_status,
    approved_at = case when p_status = 'approved' and approved_at is null then now() else approved_at end,
    admin_notes = coalesce(nullif(btrim(p_note), ''), admin_notes),
    updated_at = now()
  where id = p_invoice_id;

  insert into public.sub_audit (actor, action, subcontractor_id, invoice_id, old_data, new_data, reason)
  values (v_actor, 'status_changed', v_old.subcontractor_id, p_invoice_id,
          jsonb_build_object('status', v_old.status), jsonb_build_object('status', p_status), nullif(btrim(p_note), ''));

  if p_status = 'cancelled' and v_old.grouped_by is not null then
    perform 1 from public.sub_work_days where invoice_id = p_invoice_id order by id for update;
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', d.id, 'work_date', d.work_date, 'role', d.role, 'job_type', d.role,
             'start_time', to_char(d.start_time, 'HH24:MI'), 'finish_time', to_char(d.finish_time, 'HH24:MI'),
             'break_minutes', d.break_minutes, 'travel_minutes', d.travel_minutes, 'notes', d.notes,
             'work_hours', d.work_hours, 'travel_hours', d.travel_hours, 'hourly_rate', d.hourly_rate, 'travel_rate', d.travel_rate,
             'labour_amount', d.labour_amount, 'travel_amount', d.travel_amount, 'amount', d.labour_amount + d.travel_amount,
             'admin_adjusted', d.admin_adjusted, 'sent_at', d.sent_at) order by d.work_date, d.start_time), '[]'::jsonb),
           coalesce(array_agg(d.id order by d.id), '{}')
      into v_lines, v_ids
      from public.sub_work_days d where d.invoice_id = p_invoice_id;
    update public.sub_invoices set cancelled_lines = v_lines where id = p_invoice_id;
    -- the days stay "sent" (declaration kept) and wait for a new invoice
    update public.sub_work_days set invoice_id = null, updated_at = now() where id = any(v_ids);
    insert into public.sub_audit (actor, action, subcontractor_id, invoice_id, old_data, new_data, reason)
    values (v_actor, 'days_released', v_old.subcontractor_id, p_invoice_id,
            jsonb_build_object('invoice_number', v_old.invoice_number),
            jsonb_build_object('days', coalesce(array_length(v_ids, 1), 0), 'day_ids', to_jsonb(v_ids),
                               'work_dates', (select jsonb_agg(l->>'work_date') from jsonb_array_elements(v_lines) l)),
            nullif(btrim(p_note), ''));
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------
-- Function privileges (replaced functions keep their grants; restated for the changed ones)
-- ---------------------------------------------------------------------
revoke execute on function
  public.sub_sent_days_json(uuid),
  public.sub_invoice_lines_json(uuid),
  public.sub_portal_send_days(text, uuid[], boolean),
  public.sub_admin_create_invoice(uuid[], numeric),
  public.sub_email_outcome(text)
from public, anon, authenticated;
grant execute on function public.sub_portal_send_days(text, uuid[], boolean) to anon, authenticated;
grant execute on function public.sub_admin_create_invoice(uuid[], numeric) to authenticated;

commit;

