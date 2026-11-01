-- Audit item P3: when a worker changes the contact e-mail through the link, warn the OLD address and the Admin.
-- Before this, changing the e-mail in one save and the bank details in the next sent the bank warning
-- to the new address only. An e-mail alert does not block invoices or payments; a bank alert still does.
-- Deploy sub-invoice-submit and the pages BEFORE this migration: the deployed v6 fails on the new kind.
begin;

alter table public.sub_notifications drop constraint sub_notifications_kind_check;
alter table public.sub_notifications add constraint sub_notifications_kind_check
  check (kind in ('bank_changed_by_worker', 'email_changed_by_worker'));

create function public.sub_mask_email(p text)
returns text
language sql
immutable
set search_path = ''
as $$ select case when p is null or p = '' then null else left(p, 1) || '•••@' || split_part(p, '@', 2) end; $$;
revoke execute on function public.sub_mask_email(text) from public, anon, authenticated;

create or replace function public.sub_portal_save_profile(
  p_token text, p_full_name text, p_address text, p_email text, p_phone text, p_abn text, p_gst_registered boolean,
  p_bank_account_name text, p_bank_bsb text, p_bank_account_number text)
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
  v_email_after text;
  v_email_alert boolean;
begin
  v_sub_id := public.sub_link_check(p_token, true);
  v_had_bank := exists (select 1 from public.sub_bank_details where subcontractor_id = v_sub_id);
  -- the worker's warning goes to the address on file BEFORE this save
  select email into v_email_before from public.subcontractors where id = v_sub_id for update;
  perform public.sub_apply_profile(v_sub_id, p_full_name, p_address, p_email, p_phone, p_abn, p_gst_registered,
                                   null, 'profile_updated_by_worker', null);
  v_bank_changed := public.sub_apply_bank(v_sub_id, p_bank_account_name, p_bank_bsb, p_bank_account_number,
                                          null, 'bank_updated_by_worker', null, v_email_before);
  select email into v_email_after from public.subcontractors where id = v_sub_id;
  -- A bank alert from this same save already goes to the old address and says the e-mail changed.
  v_email_alert := v_email_before is not null and lower(btrim(v_email_before)) <> v_email_after
                   and not (v_had_bank and v_bank_changed);
  if v_email_alert then
    insert into public.sub_notifications (kind, subcontractor_id, worker_notify_email, details)
    values ('email_changed_by_worker', v_sub_id, v_email_before,
            jsonb_build_object('old_email', public.sub_mask_email(v_email_before),
                               'new_email', public.sub_mask_email(v_email_after)));
  end if;
  return jsonb_build_object('ok', true, 'bank_alert', v_had_bank and v_bank_changed, 'email_alert', v_email_alert);
end;
$$;

create or replace function public.sub_claim_alerts_internal(p_sub_id uuid, p_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  n       public.sub_notifications%rowtype;
  v_token uuid;
  v_res   jsonb := '[]'::jsonb;
begin
  for n in
    select * from public.sub_notifications x
    where x.kind in ('bank_changed_by_worker', 'email_changed_by_worker')
      and (p_sub_id is null or x.subcontractor_id = p_sub_id)
      and (x.delivery_state = 'pending'
           or (x.delivery_state = 'claimed' and x.claimed_at < now() - public.sub_alert_lease()))
    order by x.id
    limit greatest(coalesce(p_limit, 20), 1)
    for update skip locked
  loop
    if n.delivery_state = 'claimed' then
      insert into public.sub_alert_attempts (notification_id, attempt, claim_token, event)
      values (n.id, n.attempts, n.claim_token, 'claim_expired');
    end if;
    -- Outside the idempotency window: never re-send automatically (possible duplicate).
    if n.first_claimed_at is not null and n.first_claimed_at <= now() - public.sub_alert_retry_window() then
      update public.sub_notifications
         set delivery_state = 'gave_up', gave_up_reason = 'retry_window_closed', claim_token = null, claimed_at = null
       where id = n.id;
      insert into public.sub_alert_attempts (notification_id, attempt, event, status)
      values (n.id, n.attempts, 'retry_window_closed', 'first claim ' || to_char(n.first_claimed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"'));
      continue;
    end if;
    if n.attempts >= public.sub_alert_max_attempts() then
      update public.sub_notifications
         set delivery_state = 'gave_up', gave_up_reason = 'max_attempts', claim_token = null, claimed_at = null
       where id = n.id;
      insert into public.sub_alert_attempts (notification_id, attempt, event) values (n.id, n.attempts, 'gave_up');
      continue;
    end if;
    v_token := gen_random_uuid();
    update public.sub_notifications
       set delivery_state = 'claimed', claim_token = v_token, claimed_at = now(), attempts = attempts + 1,
           first_claimed_at = coalesce(first_claimed_at, now())
     where id = n.id;
    insert into public.sub_alert_attempts (notification_id, attempt, claim_token, event)
    values (n.id, n.attempts + 1, v_token, 'claimed');
    v_res := v_res || jsonb_build_array(jsonb_build_object(
      'id', n.id, 'kind', n.kind, 'claim_token', v_token, 'attempt', n.attempts + 1, 'created_at', n.created_at, 'details', n.details,
      'worker_notify_email', n.worker_notify_email,
      'need_admin', not coalesce(public.sub_alert_channel_final(n.email_status), false),
      'need_worker', not coalesce(public.sub_alert_channel_final(n.worker_email_status), false),
      'worker', (select full_name from public.subcontractors where id = n.subcontractor_id),
      'display_name', (select display_name from public.subcontractors where id = n.subcontractor_id)));
  end loop;
  return v_res;
end;
$$;

commit;
