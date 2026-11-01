-- ROLLBACK of migration 20261101105932_subcontractor_email_change_alert (audit item P3).
-- NOT a migration: do not move it to supabase/migrations. Run it only after explicit approval.
-- Run this first, then redeploy sub-invoice-submit v6 from supabase/deployed/sub-invoice-submit/v6/
-- with verify_jwt false. The pages can stay: they work with v6 and without the migration.
-- It deletes queued e-mail-change alerts: read them first if there are any. sub_audit keeps the changes.
-- The row in supabase_migrations.schema_migrations stays as history; remove the migration file from
-- the repository, or the folder will no longer match what production runs.
-- After it: md5(pg_get_functiondef) must be sub_portal_save_profile 7666aeab7e093eb0980dc97001edd108
-- and sub_claim_alerts_internal b08fa8207c58f6472064809c85164475.
begin;

CREATE OR REPLACE FUNCTION public.sub_portal_save_profile(p_token text, p_full_name text, p_address text, p_email text, p_phone text, p_abn text, p_gst_registered boolean, p_bank_account_name text, p_bank_bsb text, p_bank_account_number text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.sub_claim_alerts_internal(p_sub_id uuid, p_limit integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  n       public.sub_notifications%rowtype;
  v_token uuid;
  v_res   jsonb := '[]'::jsonb;
begin
  for n in
    select * from public.sub_notifications x
    where x.kind = 'bank_changed_by_worker'
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
      'id', n.id, 'claim_token', v_token, 'attempt', n.attempts + 1, 'created_at', n.created_at, 'details', n.details,
      'worker_notify_email', n.worker_notify_email,
      'need_admin', not coalesce(public.sub_alert_channel_final(n.email_status), false),
      'need_worker', not coalesce(public.sub_alert_channel_final(n.worker_email_status), false),
      'worker', (select full_name from public.subcontractors where id = n.subcontractor_id),
      'display_name', (select display_name from public.subcontractors where id = n.subcontractor_id)));
  end loop;
  return v_res;
end;
$function$
;

delete from public.sub_alert_attempts where notification_id in
  (select id from public.sub_notifications where kind = 'email_changed_by_worker');
delete from public.sub_notifications where kind = 'email_changed_by_worker';
alter table public.sub_notifications drop constraint sub_notifications_kind_check;
alter table public.sub_notifications add constraint sub_notifications_kind_check
  check (kind = 'bank_changed_by_worker');
drop function public.sub_mask_email(text);

commit;
