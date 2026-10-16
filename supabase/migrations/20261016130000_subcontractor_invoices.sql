-- =====================================================================
-- Subcontractor invoices (operational payment record) — TEST FIRST.
-- Target: deus-authtest (aaafpfkwpdpfamfuimki). NOT for production yet.
--
-- Model
--   * Admin defines experience levels, job types and the hourly rate for
--     each (job type, level). Each subcontractor has one level.
--   * Each subcontractor has ONE active personal link. Only the SHA-256 hash
--     of the link token is stored. The worker page calls the sub_portal_*
--     RPCs with the raw token; every RPC resolves the token to exactly one
--     subcontractor and only ever touches that subcontractor's rows.
--   * Worker records days (open = invoice_id IS NULL). "Submit" moves all
--     open days into a new pending invoice; those days are then locked and
--     can only be changed by an admin (with an audit row).
--   * Travel time is paid at sub_travel_factor() (0.5) of the hourly rate.
--     The worker RPCs return amounts only, never rates.
--   * This is an operational payment record, not a tax invoice / RCTI.
--
-- Tables have RLS enabled. anon has no table access at all. Admin access
-- is checked with public.sub_is_admin() (user_roles.role = 'admin').
-- All functions are SECURITY DEFINER with an empty search_path and
-- fully-qualified names.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------
create or replace function public.sub_is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_roles r
    where r.user_id = (select auth.uid()) and r.role = 'admin'
  );
$$;

create or replace function public.sub_today()
returns date
language sql
stable
set search_path = ''
as $$ select (now() at time zone 'Australia/Sydney')::date; $$;

create or replace function public.sub_travel_factor()
returns numeric
language sql
immutable
set search_path = ''
as $$ select 0.5::numeric; $$;

-- ABN checksum (11 digits, weights 10,1,3,5,...,19, first digit minus 1, mod 89).
create or replace function public.sub_abn_valid(p_abn text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  w int[] := array[10,1,3,5,7,9,11,13,15,17,19];
  s int := 0;
  d int;
  i int;
begin
  if p_abn is null or p_abn !~ '^[0-9]{11}$' then return false; end if;
  for i in 1..11 loop
    d := substr(p_abn, i, 1)::int;
    if i = 1 then d := d - 1; end if;
    s := s + d * w[i];
  end loop;
  return s % 89 = 0;
end;
$$;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------
create table public.sub_settings (
  id              boolean primary key default true check (id),
  company_name    text not null,
  company_abn     text not null,
  company_address text not null,
  updated_at      timestamptz not null default now()
);

create table public.sub_levels (
  id         smallint generated always as identity primary key,
  name       text not null unique check (char_length(name) between 1 and 40),
  sort_order smallint not null default 0,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.sub_job_types (
  id         smallint generated always as identity primary key,
  name       text not null unique check (char_length(name) between 1 and 60),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.sub_rates (
  job_type_id smallint not null references public.sub_job_types(id) on delete restrict,
  level_id    smallint not null references public.sub_levels(id) on delete restrict,
  hourly_rate numeric(8,2) not null check (hourly_rate > 0 and hourly_rate < 1000),
  updated_at  timestamptz not null default now(),
  primary key (job_type_id, level_id)
);

create table public.subcontractors (
  id                  uuid primary key default gen_random_uuid(),
  display_name        text not null check (char_length(display_name) between 1 and 80),
  level_id            smallint not null references public.sub_levels(id) on delete restrict,
  active              boolean not null default true,
  -- filled by the worker through the portal
  full_name           text check (char_length(full_name) <= 120),
  email               text check (email is null or (char_length(email) <= 254 and email ~ '^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$')),
  phone               text check (char_length(phone) <= 30),
  abn                 text check (abn is null or public.sub_abn_valid(abn)),
  gst_registered      boolean not null default false,
  bank_account_name   text check (char_length(bank_account_name) <= 120),
  bank_bsb            text check (bank_bsb is null or bank_bsb ~ '^[0-9]{6}$'),
  bank_account_number text check (bank_account_number is null or bank_account_number ~ '^[0-9]{5,10}$'),
  profile_updated_at  timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table public.sub_links (
  id               uuid primary key default gen_random_uuid(),
  subcontractor_id uuid not null references public.subcontractors(id) on delete cascade,
  token_hash       text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_by       uuid,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz,
  revoked_at       timestamptz,
  last_used_at     timestamptz
);
-- at most one active (non-revoked) link per subcontractor
create unique index sub_links_one_active on public.sub_links (subcontractor_id) where revoked_at is null;

create sequence public.sub_invoice_seq;

create table public.sub_invoices (
  id                 uuid primary key default gen_random_uuid(),
  invoice_number     text not null unique,
  subcontractor_id   uuid not null references public.subcontractors(id) on delete restrict,
  status             text not null default 'pending' check (status in ('pending','approved','paid','cancelled')),
  worker_snapshot    jsonb not null,
  company_snapshot   jsonb not null,
  gst_registered     boolean not null,
  labour_total       numeric(10,2) not null default 0,
  travel_total       numeric(10,2) not null default 0,
  subtotal           numeric(10,2) not null default 0,
  gst_amount         numeric(10,2) not null default 0,
  total              numeric(10,2) not null default 0,
  submitted_at       timestamptz not null default now(),
  approved_at        timestamptz,
  paid_at            date,
  payment_method     text check (char_length(payment_method) <= 40),
  payment_reference  text check (char_length(payment_reference) <= 120),
  expense_category   text not null default 'Subcontractor labour' check (char_length(expense_category) <= 60),
  admin_notes        text check (char_length(admin_notes) <= 1000),
  worker_email_status text,
  admin_email_status  text,
  updated_at         timestamptz not null default now()
);
create index sub_invoices_status_idx on public.sub_invoices (status, submitted_at desc);
create index sub_invoices_sub_idx on public.sub_invoices (subcontractor_id);

create table public.sub_work_days (
  id               uuid primary key default gen_random_uuid(),
  subcontractor_id uuid not null references public.subcontractors(id) on delete restrict,
  work_date        date not null,
  job_type_id      smallint not null references public.sub_job_types(id) on delete restrict,
  start_time       time not null,
  finish_time      time not null,
  break_minutes    int not null default 0 check (break_minutes between 0 and 600),
  travel_minutes   int not null default 0 check (travel_minutes between 0 and 600),
  notes            text check (char_length(notes) <= 500),
  hourly_rate      numeric(8,2) not null,
  travel_rate      numeric(8,2) not null,
  work_hours       numeric(6,2) not null,
  travel_hours     numeric(6,2) not null,
  labour_amount    numeric(10,2) not null,
  travel_amount    numeric(10,2) not null,
  invoice_id       uuid references public.sub_invoices(id) on delete restrict,
  admin_adjusted   boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (finish_time > start_time),
  check ((extract(epoch from (finish_time - start_time)) / 60) > break_minutes),
  unique (subcontractor_id, work_date, start_time)
);
create index sub_work_days_open_idx on public.sub_work_days (subcontractor_id) where invoice_id is null;
create index sub_work_days_invoice_idx on public.sub_work_days (invoice_id);

create table public.sub_audit (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor       uuid,
  action      text not null,
  invoice_id  uuid,
  work_day_id uuid,
  old_data    jsonb,
  new_data    jsonb,
  reason      text
);
create index sub_audit_invoice_idx on public.sub_audit (invoice_id);

-- Seed: company details already published in invoice.html (not invented).
insert into public.sub_settings (company_name, company_abn, company_address)
values ('Deus Labour Hire Pty Ltd', '62 665 081 783', 'Unit 10/6 Grosvenor St, Croydon NSW');

-- ---------------------------------------------------------------------
-- Access control: RLS on, no anon access, admin via sub_is_admin()
-- ---------------------------------------------------------------------
alter table public.sub_settings   enable row level security;
alter table public.sub_levels     enable row level security;
alter table public.sub_job_types  enable row level security;
alter table public.sub_rates      enable row level security;
alter table public.subcontractors enable row level security;
alter table public.sub_links      enable row level security;
alter table public.sub_invoices   enable row level security;
alter table public.sub_work_days  enable row level security;
alter table public.sub_audit      enable row level security;

revoke all on public.sub_settings, public.sub_levels, public.sub_job_types, public.sub_rates,
              public.subcontractors, public.sub_links, public.sub_invoices, public.sub_work_days,
              public.sub_audit from anon, authenticated;
revoke all on sequence public.sub_invoice_seq from anon, authenticated;

-- Admin-managed configuration: full CRUD for admins.
grant select, update on public.sub_settings to authenticated;
grant select, insert, update, delete on public.sub_levels, public.sub_job_types, public.sub_rates to authenticated;
grant select, insert, update on public.subcontractors to authenticated;
-- Records: read-only for admins; all writes go through audited RPCs.
grant select on public.sub_links, public.sub_invoices, public.sub_work_days, public.sub_audit to authenticated;

create policy sub_settings_admin   on public.sub_settings   for all to authenticated using (public.sub_is_admin()) with check (public.sub_is_admin());
create policy sub_levels_admin     on public.sub_levels     for all to authenticated using (public.sub_is_admin()) with check (public.sub_is_admin());
create policy sub_job_types_admin  on public.sub_job_types  for all to authenticated using (public.sub_is_admin()) with check (public.sub_is_admin());
create policy sub_rates_admin      on public.sub_rates      for all to authenticated using (public.sub_is_admin()) with check (public.sub_is_admin());
create policy subcontractors_admin on public.subcontractors for all to authenticated using (public.sub_is_admin()) with check (public.sub_is_admin());
create policy sub_links_admin_read      on public.sub_links     for select to authenticated using (public.sub_is_admin());
create policy sub_invoices_admin_read   on public.sub_invoices  for select to authenticated using (public.sub_is_admin());
create policy sub_work_days_admin_read  on public.sub_work_days for select to authenticated using (public.sub_is_admin());
create policy sub_audit_admin_read      on public.sub_audit     for select to authenticated using (public.sub_is_admin());

-- ---------------------------------------------------------------------
-- Internal helpers (not callable by clients)
-- ---------------------------------------------------------------------

-- Resolve a raw link token to its subcontractor. Generic error on any failure.
create or replace function public.sub_resolve_token(p_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_link_id uuid;
  v_sub_id  uuid;
begin
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception 'invalid_link' using errcode = 'P0001';
  end if;
  select l.id, l.subcontractor_id into v_link_id, v_sub_id
  from public.sub_links l
  join public.subcontractors s on s.id = l.subcontractor_id
  where l.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
    and l.revoked_at is null
    and (l.expires_at is null or l.expires_at > now())
    and s.active;
  if v_sub_id is null then
    raise exception 'invalid_link' using errcode = 'P0001';
  end if;
  update public.sub_links set last_used_at = now() where id = v_link_id;
  return v_sub_id;
end;
$$;

-- Compute hours and amounts for one day.
create or replace function public.sub_calc_day(
  p_start time, p_finish time, p_break int, p_travel int, p_rate numeric,
  out work_hours numeric, out travel_hours numeric, out travel_rate numeric,
  out labour_amount numeric, out travel_amount numeric)
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_work_min numeric;
begin
  if p_finish <= p_start then raise exception 'finish_before_start' using errcode = 'P0001'; end if;
  v_work_min := extract(epoch from (p_finish - p_start)) / 60 - coalesce(p_break, 0);
  if v_work_min <= 0 then raise exception 'break_too_long' using errcode = 'P0001'; end if;
  travel_rate   := round(p_rate * public.sub_travel_factor(), 2);
  work_hours    := round(v_work_min / 60, 2);
  travel_hours  := round(coalesce(p_travel, 0)::numeric / 60, 2);
  labour_amount := round(v_work_min / 60 * p_rate, 2);
  travel_amount := round(coalesce(p_travel, 0)::numeric / 60 * travel_rate, 2);
end;
$$;

-- Recalculate the totals of one invoice from its days.
create or replace function public.sub_recalc_invoice(p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_labour numeric; v_travel numeric; v_gst_reg boolean; v_sub numeric; v_gst numeric;
begin
  select gst_registered into v_gst_reg from public.sub_invoices where id = p_invoice_id;
  select coalesce(sum(labour_amount), 0), coalesce(sum(travel_amount), 0)
    into v_labour, v_travel
  from public.sub_work_days where invoice_id = p_invoice_id;
  v_sub := v_labour + v_travel;
  v_gst := case when v_gst_reg then round(v_sub * 0.10, 2) else 0 end;
  update public.sub_invoices
     set labour_total = v_labour, travel_total = v_travel, subtotal = v_sub,
         gst_amount = v_gst, total = v_sub + v_gst, updated_at = now()
   where id = p_invoice_id;
end;
$$;

-- Worker-visible view of open days (amounts only, no rates).
create or replace function public.sub_open_days_json(p_sub_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', d.id, 'work_date', d.work_date, 'job_type_id', d.job_type_id, 'job_type', j.name,
           'start_time', to_char(d.start_time, 'HH24:MI'), 'finish_time', to_char(d.finish_time, 'HH24:MI'),
           'break_minutes', d.break_minutes, 'travel_minutes', d.travel_minutes, 'notes', d.notes,
           'work_hours', d.work_hours, 'labour_amount', d.labour_amount, 'travel_amount', d.travel_amount)
         order by d.work_date, d.start_time), '[]'::jsonb)
  from public.sub_work_days d
  join public.sub_job_types j on j.id = d.job_type_id
  where d.subcontractor_id = p_sub_id and d.invoice_id is null;
$$;

-- ---------------------------------------------------------------------
-- Worker portal RPCs (token-scoped)
-- ---------------------------------------------------------------------
create or replace function public.sub_portal_get(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub_id uuid;
  v_sub    public.subcontractors%rowtype;
  v_res    jsonb;
begin
  v_sub_id := public.sub_resolve_token(p_token);
  select * into v_sub from public.subcontractors where id = v_sub_id;
  select jsonb_build_object(
    'company', (select jsonb_build_object('name', company_name, 'abn', company_abn, 'address', company_address) from public.sub_settings),
    'profile', jsonb_build_object(
        'display_name', v_sub.display_name, 'full_name', v_sub.full_name, 'email', v_sub.email, 'phone', v_sub.phone,
        'abn', v_sub.abn, 'gst_registered', v_sub.gst_registered, 'bank_account_name', v_sub.bank_account_name,
        'bank_bsb', v_sub.bank_bsb, 'bank_account_number', v_sub.bank_account_number),
    'job_types', (select coalesce(jsonb_agg(jsonb_build_object('id', j.id, 'name', j.name) order by j.name), '[]'::jsonb)
                  from public.sub_job_types j
                  join public.sub_rates r on r.job_type_id = j.id and r.level_id = v_sub.level_id
                  where j.active),
    'open_days', public.sub_open_days_json(v_sub_id),
    'invoices', (select coalesce(jsonb_agg(x.o order by x.submitted_at desc), '[]'::jsonb) from (
                   select i.submitted_at, jsonb_build_object('invoice_number', i.invoice_number,
                          'submitted_at', i.submitted_at, 'status', i.status, 'total', i.total) as o
                   from public.sub_invoices i where i.subcontractor_id = v_sub_id
                   order by i.submitted_at desc limit 20) x),
    'today', public.sub_today()
  ) into v_res;
  return v_res;
end;
$$;

create or replace function public.sub_portal_save_profile(
  p_token text, p_full_name text, p_email text, p_phone text, p_abn text, p_gst_registered boolean,
  p_bank_account_name text, p_bank_bsb text, p_bank_account_number text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub_id uuid;
  v_abn text := regexp_replace(coalesce(p_abn, ''), '\s', '', 'g');
  v_bsb text := regexp_replace(coalesce(p_bank_bsb, ''), '[\s-]', '', 'g');
  v_acc text := regexp_replace(coalesce(p_bank_account_number, ''), '\s', '', 'g');
begin
  v_sub_id := public.sub_resolve_token(p_token);
  if nullif(btrim(p_full_name), '') is null then raise exception 'name_required' using errcode = 'P0001'; end if;
  if not public.sub_abn_valid(v_abn) then raise exception 'abn_invalid' using errcode = 'P0001'; end if;
  if v_bsb <> '' and v_bsb !~ '^[0-9]{6}$' then raise exception 'bsb_invalid' using errcode = 'P0001'; end if;
  if v_acc <> '' and v_acc !~ '^[0-9]{5,10}$' then raise exception 'account_invalid' using errcode = 'P0001'; end if;
  update public.subcontractors set
    full_name = btrim(p_full_name),
    email = nullif(lower(btrim(p_email)), ''),
    phone = nullif(btrim(p_phone), ''),
    abn = v_abn,
    gst_registered = coalesce(p_gst_registered, false),
    bank_account_name = nullif(btrim(p_bank_account_name), ''),
    bank_bsb = nullif(v_bsb, ''),
    bank_account_number = nullif(v_acc, ''),
    profile_updated_at = now(), updated_at = now()
  where id = v_sub_id;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.sub_portal_save_day(
  p_token text, p_day_id uuid, p_work_date date, p_job_type_id int,
  p_start time, p_finish time, p_break_minutes int, p_travel_minutes int, p_notes text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub_id uuid;
  v_level  smallint;
  v_rate   numeric;
  c        record;
begin
  v_sub_id := public.sub_resolve_token(p_token);
  if p_work_date is null or p_work_date > public.sub_today() then raise exception 'date_invalid' using errcode = 'P0001'; end if;
  if p_work_date < public.sub_today() - 120 then raise exception 'date_too_old' using errcode = 'P0001'; end if;
  select level_id into v_level from public.subcontractors where id = v_sub_id;
  select r.hourly_rate into v_rate
  from public.sub_rates r join public.sub_job_types j on j.id = r.job_type_id
  where r.job_type_id = p_job_type_id and r.level_id = v_level and j.active;
  if v_rate is null then raise exception 'job_type_invalid' using errcode = 'P0001'; end if;
  select * into c from public.sub_calc_day(p_start, p_finish, coalesce(p_break_minutes, 0), coalesce(p_travel_minutes, 0), v_rate);

  if p_day_id is null then
    insert into public.sub_work_days (subcontractor_id, work_date, job_type_id, start_time, finish_time,
      break_minutes, travel_minutes, notes, hourly_rate, travel_rate, work_hours, travel_hours, labour_amount, travel_amount)
    values (v_sub_id, p_work_date, p_job_type_id, p_start, p_finish, coalesce(p_break_minutes, 0), coalesce(p_travel_minutes, 0),
      nullif(btrim(p_notes), ''), v_rate, c.travel_rate, c.work_hours, c.travel_hours, c.labour_amount, c.travel_amount);
  else
    update public.sub_work_days set
      work_date = p_work_date, job_type_id = p_job_type_id, start_time = p_start, finish_time = p_finish,
      break_minutes = coalesce(p_break_minutes, 0), travel_minutes = coalesce(p_travel_minutes, 0),
      notes = nullif(btrim(p_notes), ''), hourly_rate = v_rate, travel_rate = c.travel_rate,
      work_hours = c.work_hours, travel_hours = c.travel_hours, labour_amount = c.labour_amount,
      travel_amount = c.travel_amount, updated_at = now()
    where id = p_day_id and subcontractor_id = v_sub_id and invoice_id is null;
    if not found then raise exception 'day_locked_or_missing' using errcode = 'P0001'; end if;
  end if;
  return jsonb_build_object('ok', true, 'open_days', public.sub_open_days_json(v_sub_id));
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
  v_sub_id := public.sub_resolve_token(p_token);
  delete from public.sub_work_days where id = p_day_id and subcontractor_id = v_sub_id and invoice_id is null;
  if not found then raise exception 'day_locked_or_missing' using errcode = 'P0001'; end if;
  return jsonb_build_object('ok', true, 'open_days', public.sub_open_days_json(v_sub_id));
end;
$$;

-- Submit: only callable by service_role (the sub-invoice-submit Edge Function),
-- so the notification step cannot be skipped by calling the RPC directly.
create or replace function public.sub_portal_submit(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub_id  uuid;
  v_sub     public.subcontractors%rowtype;
  v_inv_id  uuid;
  v_number  text;
  v_count   int;
  v_inv     public.sub_invoices%rowtype;
begin
  v_sub_id := public.sub_resolve_token(p_token);
  -- serialise concurrent submits for the same subcontractor
  select * into v_sub from public.subcontractors where id = v_sub_id for update;
  if v_sub.full_name is null or v_sub.abn is null or v_sub.bank_bsb is null or v_sub.bank_account_number is null then
    raise exception 'profile_incomplete' using errcode = 'P0001';
  end if;
  select count(*) into v_count from public.sub_work_days where subcontractor_id = v_sub_id and invoice_id is null;
  if v_count = 0 then raise exception 'no_open_days' using errcode = 'P0001'; end if;

  v_number := 'SUB-' || to_char(public.sub_today(), 'YYYY') || '-' || lpad(nextval('public.sub_invoice_seq')::text, 5, '0');
  insert into public.sub_invoices (invoice_number, subcontractor_id, worker_snapshot, company_snapshot, gst_registered)
  values (v_number, v_sub_id,
    jsonb_build_object('full_name', v_sub.full_name, 'email', v_sub.email, 'phone', v_sub.phone, 'abn', v_sub.abn,
                       'gst_registered', v_sub.gst_registered, 'bank_account_name', v_sub.bank_account_name,
                       'bank_bsb', v_sub.bank_bsb, 'bank_account_number', v_sub.bank_account_number),
    (select jsonb_build_object('name', company_name, 'abn', company_abn, 'address', company_address) from public.sub_settings),
    v_sub.gst_registered)
  returning id into v_inv_id;

  update public.sub_work_days set invoice_id = v_inv_id, updated_at = now()
  where subcontractor_id = v_sub_id and invoice_id is null;
  perform public.sub_recalc_invoice(v_inv_id);
  insert into public.sub_audit (action, invoice_id, new_data) values ('submitted', v_inv_id, jsonb_build_object('days', v_count));

  select * into v_inv from public.sub_invoices where id = v_inv_id;
  return jsonb_build_object(
    'invoice_id', v_inv.id, 'invoice_number', v_inv.invoice_number, 'submitted_at', v_inv.submitted_at,
    'worker', v_inv.worker_snapshot, 'company', v_inv.company_snapshot,
    'labour_total', v_inv.labour_total, 'travel_total', v_inv.travel_total, 'subtotal', v_inv.subtotal,
    'gst_amount', v_inv.gst_amount, 'total', v_inv.total,
    'days', (select jsonb_agg(jsonb_build_object(
               'work_date', d.work_date, 'job_type', j.name,
               'start_time', to_char(d.start_time, 'HH24:MI'), 'finish_time', to_char(d.finish_time, 'HH24:MI'),
               'break_minutes', d.break_minutes, 'work_hours', d.work_hours, 'labour_amount', d.labour_amount,
               'travel_minutes', d.travel_minutes, 'travel_amount', d.travel_amount,
               'hourly_rate', d.hourly_rate, 'travel_rate', d.travel_rate) order by d.work_date, d.start_time)
             from public.sub_work_days d join public.sub_job_types j on j.id = d.job_type_id
             where d.invoice_id = v_inv_id));
end;
$$;

-- Record the outcome of the notification e-mails (service_role only).
create or replace function public.sub_record_email_status(p_invoice_id uuid, p_worker text, p_admin text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.sub_invoices
     set worker_email_status = left(p_worker, 40), admin_email_status = left(p_admin, 40), updated_at = now()
   where id = p_invoice_id;
$$;

-- ---------------------------------------------------------------------
-- Admin RPCs
-- ---------------------------------------------------------------------
create or replace function public.sub_admin_create_link(p_subcontractor_id uuid, p_token_hash text, p_expires_at timestamptz default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not public.sub_is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'hash_invalid' using errcode = 'P0001'; end if;
  update public.sub_links set revoked_at = now() where subcontractor_id = p_subcontractor_id and revoked_at is null;
  insert into public.sub_links (subcontractor_id, token_hash, created_by, expires_at)
  values (p_subcontractor_id, p_token_hash, (select auth.uid()), p_expires_at)
  returning id into v_id;
  insert into public.sub_audit (actor, action, new_data)
  values ((select auth.uid()), 'link_created', jsonb_build_object('subcontractor_id', p_subcontractor_id, 'link_id', v_id));
  return v_id;
end;
$$;

create or replace function public.sub_admin_revoke_links(p_subcontractor_id uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n int;
begin
  if not public.sub_is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.sub_links set revoked_at = now() where subcontractor_id = p_subcontractor_id and revoked_at is null;
  get diagnostics v_n = row_count;
  insert into public.sub_audit (actor, action, new_data)
  values ((select auth.uid()), 'links_revoked', jsonb_build_object('subcontractor_id', p_subcontractor_id, 'count', v_n));
  return v_n;
end;
$$;

create or replace function public.sub_admin_adjust_day(
  p_day_id uuid, p_job_type_id int, p_start time, p_finish time,
  p_break_minutes int, p_travel_minutes int, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d      public.sub_work_days%rowtype;
  v_stat text;
  v_rate numeric;
  c      record;
begin
  if not public.sub_is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'reason_required' using errcode = 'P0001'; end if;
  select * into d from public.sub_work_days where id = p_day_id for update;
  if d.id is null or d.invoice_id is null then raise exception 'day_not_submitted' using errcode = 'P0001'; end if;
  select status into v_stat from public.sub_invoices where id = d.invoice_id for update;
  if v_stat not in ('pending', 'approved') then raise exception 'invoice_closed' using errcode = 'P0001'; end if;

  if p_job_type_id = d.job_type_id then
    v_rate := d.hourly_rate;               -- keep the rate snapshot taken when the day was recorded
  else
    select r.hourly_rate into v_rate from public.sub_rates r
    join public.subcontractors s on s.level_id = r.level_id and s.id = d.subcontractor_id
    where r.job_type_id = p_job_type_id;
    if v_rate is null then raise exception 'job_type_invalid' using errcode = 'P0001'; end if;
  end if;
  select * into c from public.sub_calc_day(p_start, p_finish, coalesce(p_break_minutes, 0), coalesce(p_travel_minutes, 0), v_rate);

  update public.sub_work_days set
    job_type_id = p_job_type_id, start_time = p_start, finish_time = p_finish,
    break_minutes = coalesce(p_break_minutes, 0), travel_minutes = coalesce(p_travel_minutes, 0),
    hourly_rate = v_rate, travel_rate = c.travel_rate, work_hours = c.work_hours, travel_hours = c.travel_hours,
    labour_amount = c.labour_amount, travel_amount = c.travel_amount, admin_adjusted = true, updated_at = now()
  where id = p_day_id;
  perform public.sub_recalc_invoice(d.invoice_id);

  insert into public.sub_audit (actor, action, invoice_id, work_day_id, old_data, new_data, reason)
  values ((select auth.uid()), 'day_adjusted', d.invoice_id, d.id, to_jsonb(d),
          (select to_jsonb(x) from public.sub_work_days x where x.id = p_day_id), btrim(p_reason));
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.sub_admin_set_status(
  p_invoice_id uuid, p_status text, p_paid_at date default null,
  p_payment_method text default null, p_payment_reference text default null, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old public.sub_invoices%rowtype;
begin
  if not public.sub_is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_old from public.sub_invoices where id = p_invoice_id for update;
  if v_old.id is null then raise exception 'not_found' using errcode = 'P0001'; end if;
  if not (
       (v_old.status = 'pending'  and p_status in ('approved', 'cancelled'))
    or (v_old.status = 'approved' and p_status in ('pending', 'paid', 'cancelled'))
    or (v_old.status = 'paid'     and p_status = 'approved' and nullif(btrim(p_note), '') is not null)
  ) then
    raise exception 'transition_not_allowed' using errcode = 'P0001';
  end if;
  if p_status = 'paid' and p_paid_at is null then raise exception 'paid_date_required' using errcode = 'P0001'; end if;

  update public.sub_invoices set
    status = p_status,
    approved_at = case when p_status = 'approved' and v_old.status = 'pending' then now() else approved_at end,
    paid_at = case when p_status = 'paid' then p_paid_at when p_status <> 'paid' then null else paid_at end,
    payment_method = case when p_status = 'paid' then nullif(btrim(p_payment_method), '') else payment_method end,
    payment_reference = case when p_status = 'paid' then nullif(btrim(p_payment_reference), '') else payment_reference end,
    admin_notes = coalesce(nullif(btrim(p_note), ''), admin_notes),
    updated_at = now()
  where id = p_invoice_id;

  insert into public.sub_audit (actor, action, invoice_id, old_data, new_data, reason)
  values ((select auth.uid()), 'status_changed', p_invoice_id,
          jsonb_build_object('status', v_old.status, 'paid_at', v_old.paid_at),
          jsonb_build_object('status', p_status, 'paid_at', p_paid_at, 'payment_method', p_payment_method,
                             'payment_reference', p_payment_reference),
          nullif(btrim(p_note), ''));
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------
-- Function privileges: nothing is executable by default.
-- ---------------------------------------------------------------------
revoke execute on function
  public.sub_is_admin(), public.sub_today(), public.sub_travel_factor(), public.sub_abn_valid(text),
  public.sub_resolve_token(text), public.sub_calc_day(time, time, int, int, numeric),
  public.sub_recalc_invoice(uuid), public.sub_open_days_json(uuid),
  public.sub_portal_get(text),
  public.sub_portal_save_profile(text, text, text, text, text, boolean, text, text, text),
  public.sub_portal_save_day(text, uuid, date, int, time, time, int, int, text),
  public.sub_portal_delete_day(text, uuid), public.sub_portal_submit(text),
  public.sub_record_email_status(uuid, text, text),
  public.sub_admin_create_link(uuid, text, timestamptz), public.sub_admin_revoke_links(uuid),
  public.sub_admin_adjust_day(uuid, int, time, time, int, int, text),
  public.sub_admin_set_status(uuid, text, date, text, text, text)
from public, anon, authenticated;

-- Used inside RLS policies and table CHECK constraints.
grant execute on function public.sub_is_admin() to authenticated;
grant execute on function public.sub_abn_valid(text) to authenticated;

-- Worker portal (link token is the credential).
grant execute on function
  public.sub_portal_get(text),
  public.sub_portal_save_profile(text, text, text, text, text, boolean, text, text, text),
  public.sub_portal_save_day(text, uuid, date, int, time, time, int, int, text),
  public.sub_portal_delete_day(text, uuid)
to anon, authenticated;

-- Submit + e-mail status: Edge Function only.
grant execute on function public.sub_portal_submit(text), public.sub_record_email_status(uuid, text, text) to service_role;

-- Admin actions (each re-checks sub_is_admin()).
grant execute on function
  public.sub_admin_create_link(uuid, text, timestamptz), public.sub_admin_revoke_links(uuid),
  public.sub_admin_adjust_day(uuid, int, time, time, int, int, text),
  public.sub_admin_set_status(uuid, text, date, text, text, text)
to authenticated;

commit;
