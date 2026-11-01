-- =====================================================================
-- Subcontractor payments (one payment for several records).
-- Applied on production as version 20261018081342.
-- Requires 20261016130000_subcontractor_invoices.sql.
--
-- Model
--   * A payment (sub_payments, number PAY-YYYY-NNNNN) pays one or more records
--     (sub_invoices) of the SAME subcontractor. Each record keeps its own number,
--     days, totals and history; it points to its current payment (payment_id).
--   * sub_payment_items is the permanent list of records in each payment: the amount
--     of each one at the time of payment AND its state just before it was paid
--     (pending or approved, and its approval time). It is never changed, so a voided
--     payment still shows what it contained.
--   * Recording a payment is all-or-nothing, in one transaction:
--       - every selected record must be pending or approved and belong to the same
--         subcontractor;
--       - all must have been submitted with the SAME bank details (one transfer can
--         only go to one account) — otherwise pay them separately;
--       - the total the Admin saw must equal the current sum (a record corrected in
--         the meantime makes the payment fail instead of paying a different amount);
--       - an unacknowledged bank-change alert blocks the payment (as before).
--     Then every selected record becomes paid with the same date, method and
--     reference, and one audit row per record plus one for the payment is written.
--   * Undo = void the whole payment (reason required): each record goes back to the
--     state it had before the payment (pending stays pending, approved stays approved,
--     with its original approval time); the payment row is kept with voided_at /
--     voided_by / void_reason.
--   * Payment confirmation e-mail: ONE e-mail per payment, to the subcontractor's
--     e-mail at the time of payment, listing the record numbers, each amount and the
--     combined total (no rates, bank account masked). Sent by the Edge Function
--     (dry-run by default); its outcome is stored on the payment.
--   * sub_admin_set_status no longer marks records as paid or undoes payments; it
--     only handles approve / back to pending / cancel.
-- =====================================================================

begin;

create sequence public.sub_payment_seq;

create table public.sub_payments (
  id                uuid primary key default gen_random_uuid(),
  payment_number    text not null unique,
  subcontractor_id  uuid not null references public.subcontractors(id) on delete restrict,
  paid_at           date not null,
  payment_method    text not null check (payment_method in ('Bank transfer', 'Cash', 'Other')),
  payment_reference text check (char_length(payment_reference) <= 120),
  invoice_count     int not null check (invoice_count > 0),
  total             numeric(10,2) not null,
  bank_masked       jsonb not null,            -- account the records were submitted with, MASKED
  created_by        uuid,
  created_at        timestamptz not null default now(),
  notice_email      text,                       -- subcontractor e-mail at the time of payment
  notice_status     text,                       -- dry_run / sent / failed_* / no_worker_email / not_configured
  notice_attempts   int not null default 0,
  voided_at         timestamptz,
  voided_by         uuid,
  void_reason       text,
  check ((voided_at is null) = (void_reason is null))
);
create index sub_payments_sub_idx on public.sub_payments (subcontractor_id, created_at desc);

create table public.sub_payment_items (
  payment_id     uuid not null references public.sub_payments(id) on delete restrict,
  invoice_id     uuid not null references public.sub_invoices(id) on delete restrict,
  invoice_number text not null,
  amount         numeric(10,2) not null,
  previous_status      text not null check (previous_status in ('pending', 'approved')),  -- restored on undo
  previous_approved_at timestamptz,                                                     -- restored on undo
  primary key (payment_id, invoice_id)
);
create index sub_payment_items_invoice_idx on public.sub_payment_items (invoice_id);

alter table public.sub_invoices add column payment_id uuid references public.sub_payments(id) on delete restrict;
create index sub_invoices_payment_idx on public.sub_invoices (payment_id);
-- a paid record always belongs to a payment
alter table public.sub_invoices add constraint sub_invoices_paid_has_payment check (status <> 'paid' or payment_id is not null);

alter table public.sub_payments      enable row level security;
alter table public.sub_payment_items enable row level security;
revoke all on public.sub_payments, public.sub_payment_items from anon, authenticated;
revoke all on sequence public.sub_payment_seq from anon, authenticated;
grant select on public.sub_payments, public.sub_payment_items to authenticated;
create policy sub_payments_admin_read      on public.sub_payments      for select to authenticated using (public.sub_is_admin());
create policy sub_payment_items_admin_read on public.sub_payment_items for select to authenticated using (public.sub_is_admin());

-- ---------------------------------------------------------------------
-- Record one payment for one or more records of the same subcontractor.
-- ---------------------------------------------------------------------
create or replace function public.sub_admin_record_payment(
  p_invoice_ids uuid[], p_paid_at date, p_payment_method text, p_payment_reference text, p_expected_total numeric)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := public.sub_require_admin(null, false);
  v_ids     uuid[];
  v_n       int;
  v_sub     uuid;
  v_total   numeric;
  v_pending jsonb;
  v_pay     uuid;
  v_number  text;
  v_method  text := btrim(coalesce(p_payment_method, ''));
  v_ref     text := nullif(btrim(coalesce(p_payment_reference, '')), '');
  b         public.sub_invoice_bank%rowtype;
begin
  select coalesce(array_agg(distinct x), '{}') into v_ids from unnest(coalesce(p_invoice_ids, '{}'::uuid[])) x where x is not null;
  v_n := coalesce(array_length(v_ids, 1), 0);
  if v_n = 0 then raise exception 'no_invoices_selected' using errcode = 'P0001'; end if;
  if v_n > 50 then raise exception 'too_many_invoices' using errcode = 'P0001'; end if;
  if p_paid_at is null then raise exception 'paid_date_required' using errcode = 'P0001'; end if;
  if p_paid_at > public.sub_today() then raise exception 'paid_date_future' using errcode = 'P0001'; end if;
  if v_method = '' then raise exception 'payment_method_required' using errcode = 'P0001'; end if;
  if v_method not in ('Bank transfer', 'Cash', 'Other') then raise exception 'payment_method_invalid' using errcode = 'P0001'; end if;
  if char_length(coalesce(v_ref, '')) > 120 then raise exception 'reference_too_long' using errcode = 'P0001'; end if;

  -- lock the records in a fixed order (no deadlock between two admins)
  perform 1 from public.sub_invoices where id = any(v_ids) order by id for update;
  if (select count(*) from public.sub_invoices where id = any(v_ids)) <> v_n then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if (select count(distinct subcontractor_id) from public.sub_invoices where id = any(v_ids)) <> 1 then
    raise exception 'mixed_subcontractors' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.sub_invoices where id = any(v_ids) and status not in ('pending', 'approved')) then
    raise exception 'invoice_not_payable' using errcode = 'P0001';
  end if;
  select subcontractor_id into v_sub from public.sub_invoices where id = v_ids[1];

  -- Bank-change alerts block payment until acknowledged (same rule as before; the
  -- subcontractor row is locked so a concurrent bank change is seen or comes after).
  perform 1 from public.subcontractors where id = v_sub for update;
  select coalesce(jsonb_agg(n.id order by n.id), '[]'::jsonb) into v_pending
  from public.sub_notifications n
  where n.subcontractor_id = v_sub and n.kind = 'bank_changed_by_worker' and n.acknowledged_at is null;
  if jsonb_array_length(v_pending) > 0 then
    insert into public.sub_audit (actor, action, subcontractor_id, new_data, reason)
    values (v_actor, 'payment_blocked', v_sub,
            jsonb_build_object('requested_status', 'paid', 'invoice_ids', to_jsonb(v_ids), 'pending_alert_ids', v_pending),
            'Unacknowledged bank-change alert');
    return jsonb_build_object('ok', false, 'error', 'bank_alert_pending', 'pending_alert_ids', v_pending,
      'message', 'Payment blocked: the subcontractor changed their bank details through the personal link. '
              || 'Review and acknowledge the bank-change alert in Admin before paying.');
  end if;

  -- One transfer = one account: all records must carry the same bank snapshot.
  if (select count(*) from public.sub_invoice_bank where invoice_id = any(v_ids)) <> v_n
     or (select count(distinct (account_name, bsb, account_number)) from public.sub_invoice_bank where invoice_id = any(v_ids)) <> 1 then
    raise exception 'bank_details_differ' using errcode = 'P0001';
  end if;

  select sum(total) into v_total from public.sub_invoices where id = any(v_ids);
  if p_expected_total is null or round(p_expected_total, 2) <> v_total then
    raise exception 'total_changed' using errcode = 'P0001';
  end if;

  select * into b from public.sub_invoice_bank where invoice_id = v_ids[1];
  v_number := 'PAY-' || to_char(public.sub_today(), 'YYYY') || '-' || lpad(nextval('public.sub_payment_seq')::text, 5, '0');
  insert into public.sub_payments (payment_number, subcontractor_id, paid_at, payment_method, payment_reference,
                                   invoice_count, total, bank_masked, created_by, notice_email)
  values (v_number, v_sub, p_paid_at, v_method, v_ref, v_n, v_total,
          jsonb_build_object('account_name', public.sub_mask_name(b.account_name), 'bsb', public.sub_mask(b.bsb),
                             'account_number', public.sub_mask(b.account_number)),
          v_actor, (select email from public.subcontractors where id = v_sub))
  returning id into v_pay;
  insert into public.sub_payment_items (payment_id, invoice_id, invoice_number, amount, previous_status, previous_approved_at)
  select v_pay, id, invoice_number, total, status, approved_at from public.sub_invoices where id = any(v_ids);

  -- one history row per record (old values captured before the update)
  insert into public.sub_audit (actor, action, subcontractor_id, invoice_id, old_data, new_data)
  select v_actor, 'status_changed', i.subcontractor_id, i.id,
         jsonb_build_object('status', i.status, 'paid_at', i.paid_at, 'payment_method', i.payment_method,
                            'payment_reference', i.payment_reference),
         jsonb_build_object('status', 'paid', 'paid_at', p_paid_at, 'payment_method', v_method, 'payment_reference', v_ref,
                            'payment_id', v_pay, 'payment_number', v_number, 'bank_alert_check', 'clear')
  from public.sub_invoices i where i.id = any(v_ids);

  update public.sub_invoices set
    status = 'paid', approved_at = coalesce(approved_at, now()), paid_at = p_paid_at,
    payment_method = v_method, payment_reference = v_ref, payment_id = v_pay, updated_at = now()
  where id = any(v_ids);

  insert into public.sub_audit (actor, action, subcontractor_id, new_data)
  values (v_actor, 'payment_recorded', v_sub, jsonb_build_object(
    'payment_id', v_pay, 'payment_number', v_number, 'paid_at', p_paid_at, 'payment_method', v_method,
    'payment_reference', v_ref, 'total', v_total,
    'invoice_numbers', (select jsonb_agg(invoice_number order by invoice_number) from public.sub_invoices where id = any(v_ids))));

  return jsonb_build_object('ok', true, 'payment_id', v_pay, 'payment_number', v_number,
                            'invoice_count', v_n, 'total', v_total);
end;
$$;

-- ---------------------------------------------------------------------
-- Undo a payment: the WHOLE payment is voided (reason required); each record goes
-- back to the state it had before the payment (pending or approved, original
-- approval time). The payment and its item list are kept.
-- ---------------------------------------------------------------------
create or replace function public.sub_admin_void_payment(p_payment_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.sub_require_admin(p_reason, true);
  p public.sub_payments%rowtype;
begin
  select * into p from public.sub_payments where id = p_payment_id for update;
  if p.id is null then raise exception 'not_found' using errcode = 'P0001'; end if;
  if p.voided_at is not null then raise exception 'already_voided' using errcode = 'P0001'; end if;
  perform 1 from public.sub_invoices where payment_id = p.id order by id for update;

  insert into public.sub_audit (actor, action, subcontractor_id, invoice_id, old_data, new_data, reason)
  select v_actor, 'status_changed', i.subcontractor_id, i.id,
         jsonb_build_object('status', i.status, 'paid_at', i.paid_at, 'payment_method', i.payment_method,
                            'payment_reference', i.payment_reference, 'payment_number', p.payment_number),
         jsonb_build_object('status', it.previous_status, 'payment_voided', p.payment_number),
         btrim(p_reason)
  from public.sub_invoices i
  join public.sub_payment_items it on it.payment_id = p.id and it.invoice_id = i.id
  where i.payment_id = p.id;

  update public.sub_invoices i set status = it.previous_status, approved_at = it.previous_approved_at,
         paid_at = null, payment_method = null, payment_reference = null, payment_id = null, updated_at = now()
  from public.sub_payment_items it
  where i.payment_id = p.id and it.payment_id = p.id and it.invoice_id = i.id;
  update public.sub_payments set voided_at = now(), voided_by = v_actor, void_reason = btrim(p_reason) where id = p.id;

  insert into public.sub_audit (actor, action, subcontractor_id, new_data, reason)
  values (v_actor, 'payment_voided', p.subcontractor_id,
          jsonb_build_object('payment_id', p.id, 'payment_number', p.payment_number, 'total', p.total), btrim(p_reason));
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------
-- Payment confirmation e-mail
-- ---------------------------------------------------------------------
create or replace function public.sub_payment_notice_final(p_status text)
returns boolean
language sql
immutable
set search_path = ''
as $$ select p_status in ('sent', 'dry_run', 'not_configured', 'no_worker_email'); $$;

-- Called by the Edge Function WITH THE ADMIN'S OWN SESSION (the database checks admin).
-- Returns what the e-mail needs: numbers, amounts, combined total. No rates; bank masked.
create or replace function public.sub_admin_payment_notice(p_payment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.sub_require_admin(null, false);
  p public.sub_payments%rowtype;
begin
  select * into p from public.sub_payments where id = p_payment_id for update;
  if p.id is null then raise exception 'not_found' using errcode = 'P0001'; end if;
  if p.voided_at is not null then raise exception 'payment_voided' using errcode = 'P0001'; end if;
  if coalesce(public.sub_payment_notice_final(p.notice_status), false) then
    return jsonb_build_object('need_send', false, 'notice_status', p.notice_status);
  end if;
  update public.sub_payments set notice_attempts = notice_attempts + 1 where id = p.id;
  return jsonb_build_object(
    'need_send', true, 'payment_id', p.id, 'payment_number', p.payment_number, 'paid_at', p.paid_at,
    'payment_method', p.payment_method, 'payment_reference', p.payment_reference, 'total', p.total,
    'bank_masked', p.bank_masked, 'email', p.notice_email,
    'worker', (select coalesce(full_name, display_name) from public.subcontractors where id = p.subcontractor_id),
    'company', (select company_name from public.sub_settings),
    'invoices', (select jsonb_agg(jsonb_build_object('invoice_number', invoice_number, 'amount', amount) order by invoice_number)
                 from public.sub_payment_items where payment_id = p.id));
end;
$$;

-- Edge Function only (service_role): store the e-mail outcome; a final outcome is never overwritten.
create or replace function public.sub_record_payment_notice(p_payment_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.sub_payments%rowtype;
  v_status text := left(coalesce(p_status, 'unknown'), 40);
begin
  select * into p from public.sub_payments where id = p_payment_id for update;
  if p.id is null then raise exception 'not_found' using errcode = 'P0001'; end if;
  if coalesce(public.sub_payment_notice_final(p.notice_status), false) then
    return jsonb_build_object('accepted', false, 'notice_status', p.notice_status);
  end if;
  update public.sub_payments set notice_status = v_status where id = p.id;
  insert into public.sub_audit (action, subcontractor_id, new_data)
  values ('payment_notice', p.subcontractor_id, jsonb_build_object('payment_number', p.payment_number, 'status', v_status));
  return jsonb_build_object('accepted', true, 'notice_status', v_status);
end;
$$;

-- ---------------------------------------------------------------------
-- Status changes other than payment (approve / back to pending / cancel).
-- Paying goes through sub_admin_record_payment; undoing through sub_admin_void_payment.
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
begin
  if p_status = 'paid' then raise exception 'use_record_payment' using errcode = 'P0001'; end if;
  select * into v_old from public.sub_invoices where id = p_invoice_id for update;
  if v_old.id is null then raise exception 'not_found' using errcode = 'P0001'; end if;
  if v_old.status = 'paid' then raise exception 'use_void_payment' using errcode = 'P0001'; end if;
  if not (
       (v_old.status = 'pending'  and p_status in ('approved', 'cancelled'))
    or (v_old.status = 'approved' and p_status in ('pending', 'cancelled'))
  ) then
    raise exception 'transition_not_allowed' using errcode = 'P0001';
  end if;
  if p_status = 'cancelled' then
    perform public.sub_require_admin(p_note, true);
  end if;

  update public.sub_invoices set
    status = p_status,
    approved_at = case when p_status = 'approved' and approved_at is null then now() else approved_at end,
    admin_notes = coalesce(nullif(btrim(p_note), ''), admin_notes),
    updated_at = now()
  where id = p_invoice_id;

  insert into public.sub_audit (actor, action, subcontractor_id, invoice_id, old_data, new_data, reason)
  values (v_actor, 'status_changed', v_old.subcontractor_id, p_invoice_id,
          jsonb_build_object('status', v_old.status), jsonb_build_object('status', p_status), nullif(btrim(p_note), ''));
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------
-- Worker views: same as before plus the payment number / date / reference.
-- ---------------------------------------------------------------------
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
    'days', public.sub_days_json(v_sub_id, i.id),
    'labour_total', i.labour_total, 'travel_total', i.travel_total,
    'subtotal', i.subtotal, 'gst_amount', i.gst_amount, 'total', i.total);
end;
$$;

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
    'invoices', (select coalesce(jsonb_agg(x.o order by x.submitted_at desc), '[]'::jsonb) from (
                   select i.submitted_at, jsonb_build_object('invoice_number', i.invoice_number,
                          'submitted_at', i.submitted_at, 'status', i.status, 'total', i.total, 'paid_at', i.paid_at,
                          'payment_number', (select payment_number from public.sub_payments where id = i.payment_id)) as o
                   from public.sub_invoices i where i.subcontractor_id = v_sub_id
                   order by i.submitted_at desc limit 20) x),
    'declaration', jsonb_build_object('version', public.sub_declaration_version(), 'text', public.sub_declaration_text()),
    'today', public.sub_today());
end;
$$;

-- ---------------------------------------------------------------------
-- Function privileges for the new/changed functions.
-- ---------------------------------------------------------------------
revoke execute on function
  public.sub_admin_record_payment(uuid[], date, text, text, numeric),
  public.sub_admin_void_payment(uuid, text),
  public.sub_payment_notice_final(text),
  public.sub_admin_payment_notice(uuid),
  public.sub_record_payment_notice(uuid, text),
  public.sub_admin_set_status(uuid, text, date, text, text, text),
  public.sub_portal_get_invoice(text, text),
  public.sub_portal_get(text)
from public, anon, authenticated;

grant execute on function public.sub_portal_get(text), public.sub_portal_get_invoice(text, text) to anon, authenticated;
grant execute on function
  public.sub_admin_record_payment(uuid[], date, text, text, numeric),
  public.sub_admin_void_payment(uuid, text),
  public.sub_admin_payment_notice(uuid),
  public.sub_admin_set_status(uuid, text, date, text, text, text)
to authenticated;
grant execute on function public.sub_record_payment_notice(uuid, text) to service_role;

commit;
