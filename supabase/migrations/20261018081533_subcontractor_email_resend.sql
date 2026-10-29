-- =====================================================================
-- E-mail resend for subcontractor records and payments. Applied on deus-authtest (as 3 parts) on 17/10/2026; NOT on production.
-- Version 20261017150000: after 20261017140000 (admin corrections), same day.
-- Target when approved: deus-authtest (aaafpfkwpdpfamfuimki) first. Requires the four
-- earlier subcontractor migrations. Existing rows are not changed; delivery state for old
-- records is derived on first use from the columns they already have.
--
-- Why: the provider (Resend) keeps an Idempotency-Key for 24 hours only. A repeated request
-- with the same key inside that time is not delivered twice; after it, the same key no longer
-- protects anything. So every e-mail outcome is put in one of these classes:
--
--   done        sent, dry_run                              never sent again
--   not_sent    not_configured, no_worker_email,           known NOT delivered: safe to send
--               no_previous_email, failed_4xx (not 408/409)
--   unknown     sending (attempt started, no result),      may or may not have been delivered
--               failed_timeout (call aborted after 30 s),
--               failed_5xx, failed_network, failed_408,
--               failed_409, anything else
--   never       no attempt yet
--   in_progress an attempt started less than 10 minutes ago (lease)
--
-- Resend rules (sub_admin_email_claim):
--   * done -> refused (already_sent). in_progress -> refused (in_progress).
--   * never / not_sent -> allowed. Inside the 23 h window after the FIRST attempt the original
--     Idempotency-Key is reused; after it a new key (…-r<attempt>) is used. No duplicate risk:
--     nothing was delivered.
--   * unknown, inside the 23 h window -> allowed with the ORIGINAL key: if the earlier attempt
--     was delivered, the provider recognises the key and does not deliver again.
--   * unknown, after the window -> refused (unknown_needs_confirmation) unless the Admin
--     confirms they checked the provider log / recipient, with a reason (audited). A new key
--     is used: a duplicate is possible and the Admin accepted that.
-- 23 h = provider's 24 h minus a 1 h safety margin (same as the bank-alert retries).
--
-- Automatic retries:
--   * Bank alerts: not_configured is no longer final, so the scheduled job retries it — only
--     inside the 23 h window and up to 5 attempts (unchanged rules). After that the alert is
--     gave_up and stays visible in Admin for acknowledgement; no automatic send after 23 h.
--   * Record copies and payment notices: no automatic retries (a person decides).
--
-- Concurrency:
--   * First use of a delivery row by two calls at once: insert ... on conflict do nothing, then the
--     row is re-read locked; the state written by the other call is kept.
--   * Claim vs cancel / Undo: the claim locks the record or payment before checking it. Cancel or
--     Undo first -> the claim sees it and no e-mail is prepared. Claim first -> the cancel / Undo
--     waits, then is refused (email_in_progress) until the attempt has a result (or 10 minutes).
--     The same applies to the two copies sent right after a record is submitted (no result yet).
--
-- Why 10 minutes (sub_alert_lease): an attempt can only be "in flight" while the Edge Function that
-- started it is alive. Supabase stops a worker after at most 150 s (Free) / 400 s (paid plans), and
-- the function itself aborts the provider call after 30 s. The lease must be LONGER than the hard
-- limit (400 s) so that an attempt whose function was killed before recording a result is never
-- treated as finished while it could still be running. 600 s = 400 s + 200 s margin (clock
-- differences, slow database calls). A shorter lease would be safe only on the Free plan.
-- =====================================================================

begin;

create table public.sub_email_deliveries (
  kind              text not null check (kind in ('record_worker', 'record_admin', 'payment_notice')),
  ref_id            uuid not null,                       -- sub_invoices.id or sub_payments.id
  status            text,                                -- last outcome (see classes above)
  attempts          int  not null default 0,
  first_attempt_at  timestamptz,                         -- starts the 23 h idempotency window
  last_attempt_at   timestamptz,
  attempt_token     uuid,                                -- current attempt; stale results are ignored
  idem_key          text,                                -- key used by the current/last attempt
  primary key (kind, ref_id)
);
alter table public.sub_email_deliveries enable row level security;   -- no policies: RPCs only
revoke all on public.sub_email_deliveries from public, anon, authenticated;

create or replace function public.sub_email_outcome(p_status text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_status is null then 'never'
    when p_status in ('sent', 'dry_run') then 'done'
    when p_status in ('not_configured', 'no_worker_email', 'no_previous_email') then 'not_sent'
    when p_status ~ '^failed_4[0-9][0-9]$' and p_status not in ('failed_408', 'failed_409') then 'not_sent'
    else 'unknown' end;
$$;

-- Loads (and locks) the delivery row; creates it on first use from the existing columns.
-- Two first calls at the same time: both may build a row, but the insert ignores a conflict on
-- the primary key and the row is read again (locked). The row created by the other call — with
-- whatever state it already has, e.g. an attempt in progress — is kept, never overwritten.
create or replace function public.sub_email_row(p_kind text, p_id uuid)
returns public.sub_email_deliveries
language plpgsql
security definer
set search_path = ''
as $$
declare
  r   public.sub_email_deliveries%rowtype;
  inv public.sub_invoices%rowtype;
  p   public.sub_payments%rowtype;
begin
  if p_kind not in ('record_worker', 'record_admin', 'payment_notice') then
    raise exception 'kind_invalid' using errcode = 'P0001';
  end if;
  select * into r from public.sub_email_deliveries where kind = p_kind and ref_id = p_id for update;
  if found then return r; end if;
  r.kind := p_kind; r.ref_id := p_id; r.attempts := 0;
  if p_kind in ('record_worker', 'record_admin') then
    select * into inv from public.sub_invoices where id = p_id;
    if inv.id is null then raise exception 'not_found' using errcode = 'P0001'; end if;
    -- The copies were attempted at submit time. No status recorded = the function stopped
    -- between sending and recording: outcome unknown.
    r.status := coalesce(case when p_kind = 'record_worker' then inv.worker_email_status else inv.admin_email_status end, 'sending');
    r.attempts := 1; r.first_attempt_at := inv.submitted_at; r.last_attempt_at := inv.submitted_at;
    r.idem_key := 'sub-record-' || p_id || case when p_kind = 'record_worker' then '-worker' else '-admin' end;
  else
    select * into p from public.sub_payments where id = p_id;
    if p.id is null then raise exception 'not_found' using errcode = 'P0001'; end if;
    r.idem_key := 'sub-payment-' || p_id;
    if p.notice_attempts > 0 or p.notice_status is not null then
      -- the old flow did not store attempt times: the payment time is the earliest possible
      -- attempt, so the window is never assumed to be longer than it really is.
      r.status := coalesce(p.notice_status, 'sending');
      r.attempts := greatest(p.notice_attempts, 1); r.first_attempt_at := p.created_at; r.last_attempt_at := p.created_at;
    end if;
  end if;
  insert into public.sub_email_deliveries values (r.*) on conflict (kind, ref_id) do nothing;
  select * into r from public.sub_email_deliveries where kind = p_kind and ref_id = p_id for update;
  return r;
end;
$$;

create or replace function public.sub_email_class(r public.sub_email_deliveries)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when r.status = 'sending' and r.last_attempt_at > now() - public.sub_alert_lease() then 'in_progress'
    else public.sub_email_outcome(r.status) end;
$$;

-- Admin: state shown next to each e-mail in Admin (no address, no content).
create or replace function public.sub_admin_email_state(p_kind text, p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.sub_require_admin(null, false);
  r public.sub_email_deliveries%rowtype;
  v_class text;
  v_window boolean;
begin
  r := public.sub_email_row(p_kind, p_id);
  v_class := public.sub_email_class(r);
  v_window := r.first_attempt_at is null or r.first_attempt_at > now() - public.sub_alert_retry_window();
  return jsonb_build_object('kind', p_kind, 'status', r.status, 'class', v_class, 'attempts', r.attempts,
    'first_attempt_at', r.first_attempt_at, 'last_attempt_at', r.last_attempt_at, 'window_open', v_window,
    'can_resend', v_class in ('never', 'not_sent', 'unknown'),
    'needs_confirmation', v_class = 'unknown' and not v_window);
end;
$$;

-- Admin (called by the Edge Function WITH THE ADMIN'S SESSION): starts one attempt and returns
-- what the e-mail needs. Rules in the header.
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
      'days', public.sub_days_json(inv.subcontractor_id, inv.id));
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

-- Edge Function only (service_role): stores the result of the CURRENT attempt and keeps the
-- columns the Admin page already shows in step. A result for an older attempt is ignored.
create or replace function public.sub_record_email_result(p_kind text, p_id uuid, p_attempt_token uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.sub_email_deliveries%rowtype;
  v_status text := left(coalesce(p_status, 'unknown'), 40);
begin
  -- same lock order as the claim: record / payment first, then the delivery row
  if p_kind in ('record_worker', 'record_admin') then
    perform 1 from public.sub_invoices where id = p_id for update;
  else
    perform 1 from public.sub_payments where id = p_id for update;
  end if;
  select * into r from public.sub_email_deliveries where kind = p_kind and ref_id = p_id for update;
  if r.kind is null or r.attempt_token is distinct from p_attempt_token or r.status <> 'sending' then
    return jsonb_build_object('accepted', false);
  end if;
  update public.sub_email_deliveries set status = v_status, attempt_token = null where kind = p_kind and ref_id = p_id;
  if p_kind = 'record_worker' then
    update public.sub_invoices set worker_email_status = v_status, updated_at = now() where id = p_id;
  elsif p_kind = 'record_admin' then
    update public.sub_invoices set admin_email_status = v_status, updated_at = now() where id = p_id;
  else
    update public.sub_payments set notice_status = v_status where id = p_id;
  end if;
  insert into public.sub_audit (action, subcontractor_id, invoice_id, new_data)
  values ('email_result',
          coalesce((select subcontractor_id from public.sub_invoices where id = p_id), (select subcontractor_id from public.sub_payments where id = p_id)),
          (select id from public.sub_invoices where id = p_id),
          jsonb_build_object('kind', p_kind, 'attempt', r.attempts, 'status', v_status));
  return jsonb_build_object('accepted', true, 'status', v_status);
end;
$$;

-- Submit path (unchanged call): also keeps a delivery row created meanwhile in step, as long
-- as no resend has started (attempt 1, no current attempt).
create or replace function public.sub_record_email_status(p_invoice_id uuid, p_worker text, p_admin text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.sub_invoices
     set worker_email_status = left(p_worker, 40), admin_email_status = left(p_admin, 40), updated_at = now()
   where id = p_invoice_id;
  update public.sub_email_deliveries
     set status = left(case when kind = 'record_worker' then p_worker else p_admin end, 40)
   where ref_id = p_invoice_id and kind in ('record_worker', 'record_admin') and attempts = 1 and attempt_token is null;
$$;

-- Bank alerts: a missing setting is retried (window and attempt limits unchanged).
create or replace function public.sub_alert_channel_final(p_status text)
returns boolean
language sql
immutable
set search_path = ''
as $$ select p_status in ('sent', 'dry_run', 'no_previous_email'); $$;

-- Payment notice: only a real outcome is final; the Admin page shows the resend button otherwise.
create or replace function public.sub_payment_notice_final(p_status text)
returns boolean
language sql
immutable
set search_path = ''
as $$ select p_status in ('sent', 'dry_run'); $$;

-- While an e-mail attempt for a record / payment is in progress (started less than 10 minutes ago,
-- no result yet), cancelling that record or undoing that payment is refused: otherwise the e-mail
-- prepared a moment earlier could still leave after the cancel / Undo. Try again in a minute.
create or replace function public.sub_email_block_close()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- copies of a record that was just submitted: the submit call has not recorded their result yet
  -- (nested IF: a sub_payments row has no such columns, and PL/pgSQL does not short-circuit)
  if tg_table_name = 'sub_invoices' then
    if (old.worker_email_status is null or old.admin_email_status is null)
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
create trigger sub_invoices_email_block_cancel before update of status on public.sub_invoices
  for each row when (new.status = 'cancelled' and old.status is distinct from 'cancelled')
  execute function public.sub_email_block_close();
create trigger sub_payments_email_block_void before update of voided_at on public.sub_payments
  for each row when (new.voided_at is not null and old.voided_at is null)
  execute function public.sub_email_block_close();

revoke execute on function
  public.sub_email_block_close(),
  public.sub_email_row(text, uuid), public.sub_email_class(public.sub_email_deliveries),
  public.sub_admin_email_state(text, uuid), public.sub_admin_email_claim(text, uuid, boolean, text),
  public.sub_record_email_result(text, uuid, uuid, text)
from public, anon, authenticated;
grant execute on function public.sub_admin_email_state(text, uuid), public.sub_admin_email_claim(text, uuid, boolean, text)
to authenticated;
grant execute on function public.sub_record_email_result(text, uuid, uuid, text) to service_role;

commit;
