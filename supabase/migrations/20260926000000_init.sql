-- FraudLens — P0 schema
-- Security model:
--   * RLS on every table. anon gets nothing.
--   * New sign-ups get role = NULL (no access) until an admin assigns a role.
--   * Scores/reason codes are immutable to users; only the server (service_role) writes them.
--   * Alert status changes follow a DB-enforced state machine and are auto-audited.
--   * audit_log is append-only (trigger blocks UPDATE/DELETE for everyone, incl. service_role).

create schema if not exists private;
revoke all on schema private from public;

-- ───────────────────────── Types ─────────────────────────
create type public.app_role       as enum ('analyst', 'supervisor', 'admin');
create type public.txn_channel    as enum ('UPI', 'CARD', 'NETBANKING', 'IMPS', 'ATM');
create type public.alert_severity as enum ('low', 'medium', 'high', 'critical');
create type public.alert_status   as enum ('open', 'in_review', 'escalated', 'confirmed_fraud', 'false_positive');

-- ───────────────────────── Tables ─────────────────────────
create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  full_name  text not null default '',
  role       public.app_role,               -- NULL = pending approval, no data access
  created_at timestamptz not null default now()
);

create table public.customers (
  id             uuid primary key default gen_random_uuid(),
  external_ref   text not null unique,
  full_name      text not null,
  account_masked text not null check (account_masked ~ '^X{4,}[0-9]{4}$'),
  home_city      text not null,
  segment        text not null check (segment in ('retail', 'msme')),
  kyc_tier       smallint not null check (kyc_tier between 1 and 3),
  created_at     timestamptz not null default now()
);

create table public.transactions (
  id                uuid primary key default gen_random_uuid(),
  customer_id       uuid not null references public.customers (id) on delete restrict,
  amount            numeric(14, 2) not null check (amount > 0),
  channel           public.txn_channel not null,
  direction         text not null check (direction in ('debit', 'credit')),
  counterparty      text not null,
  merchant_category text,
  city              text not null,
  device_id         text not null,
  occurred_at       timestamptz not null,
  created_at        timestamptz not null default now()
);
create index transactions_customer_time_idx on public.transactions (customer_id, occurred_at desc);

-- Ground truth for planted synthetic fraud (evaluation only). Supervisor-visible.
create table public.fraud_labels (
  transaction_id uuid primary key references public.transactions (id) on delete cascade,
  pattern        text not null
);

create table public.alerts (
  id              uuid primary key default gen_random_uuid(),
  transaction_id  uuid not null unique references public.transactions (id) on delete cascade,
  customer_id     uuid not null references public.customers (id) on delete restrict,
  risk_score      smallint not null check (risk_score between 0 and 100),
  severity        public.alert_severity not null,
  reason_codes    text[] not null check (cardinality(reason_codes) > 0),
  status          public.alert_status not null default 'open',
  assigned_to     uuid references public.profiles (id) on delete set null,
  resolution_note text check (resolution_note is null or char_length(resolution_note) <= 2000),
  ai_summary      jsonb,
  ai_model        text,
  ai_generated_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  resolved_at     timestamptz
);
create index alerts_queue_idx    on public.alerts (status, risk_score desc, created_at desc);
create index alerts_customer_idx on public.alerts (customer_id);

-- No FK on actor_id: audit rows must survive user deletion.
create table public.audit_log (
  id          bigint generated always as identity primary key,
  actor_id    uuid,                          -- NULL = system/service
  action      text not null check (char_length(action) between 1 and 64),
  entity_type text not null check (char_length(entity_type) between 1 and 32),
  entity_id   text not null,
  details     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index audit_entity_idx on public.audit_log (entity_type, entity_id, created_at desc);

-- ───────────────────────── Role helpers ─────────────────────────
-- SECURITY DEFINER so policies on profiles don't recurse.
create or replace function private.user_role()
returns public.app_role
language sql stable security definer set search_path = ''
as $$
  select p.role from public.profiles p where p.id = (select auth.uid())
$$;

create or replace function private.is_staff()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.user_role() is not null
$$;

create or replace function private.is_supervisor()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce(private.user_role() in ('supervisor', 'admin'), false)
$$;

-- True for server-side callers (service_role key, migrations, seed).
create or replace function private.is_system()
returns boolean
language sql stable set search_path = ''
as $$
  select current_user in ('service_role', 'postgres', 'supabase_admin')
$$;

grant usage on schema private to authenticated, service_role;
grant execute on all functions in schema private to authenticated, service_role;

-- ───────────────────────── Triggers ─────────────────────────
-- Profile on sign-up. Role is never taken from user metadata (prevents self-escalation).
create or replace function private.handle_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, left(coalesce(new.raw_user_meta_data ->> 'full_name', ''), 120));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- Users cannot change their own role; only system/admin paths may.
create or replace function private.guard_profile_update()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if private.is_system() then
    return new;
  end if;
  if new.role is distinct from old.role or new.id <> old.id or new.created_at <> old.created_at then
    raise exception 'profile_role_immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger profiles_guard
  before update on public.profiles
  for each row execute function private.guard_profile_update();

-- Alert state machine.
--   open        → in_review | escalated
--   in_review   → escalated | confirmed_fraud | false_positive
--   escalated   → confirmed_fraud | false_positive   (supervisor/admin only)
--   terminal    → (no changes)
create or replace function private.guard_alert_update()
returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_sup  boolean := private.is_supervisor();
begin
  if private.is_system() then
    new.updated_at := now();
    return new;
  end if;

  if new.transaction_id  is distinct from old.transaction_id
     or new.customer_id  is distinct from old.customer_id
     or new.risk_score   is distinct from old.risk_score
     or new.severity     is distinct from old.severity
     or new.reason_codes is distinct from old.reason_codes
     or new.created_at   is distinct from old.created_at
     or new.ai_summary   is distinct from old.ai_summary
     or new.ai_model     is distinct from old.ai_model
     or new.ai_generated_at is distinct from old.ai_generated_at
     or new.resolved_at  is distinct from old.resolved_at then
    raise exception 'alert_field_immutable' using errcode = '42501';
  end if;

  if old.status in ('confirmed_fraud', 'false_positive') then
    raise exception 'alert_closed' using errcode = '42501';
  end if;

  if new.status is distinct from old.status then
    if not (
         (old.status = 'open'      and new.status in ('in_review', 'escalated'))
      or (old.status = 'in_review' and new.status in ('escalated', 'confirmed_fraud', 'false_positive'))
      or (old.status = 'escalated' and new.status in ('confirmed_fraud', 'false_positive') and v_sup)
    ) then
      raise exception 'invalid_transition % -> %', old.status, new.status using errcode = '42501';
    end if;
  end if;

  -- Analysts may only assign to themselves.
  if new.assigned_to is distinct from old.assigned_to
     and not v_sup
     and new.assigned_to is distinct from v_uid then
    raise exception 'assign_forbidden' using errcode = '42501';
  end if;

  -- Analysts may only act on alerts that are unassigned or theirs.
  if not v_sup and old.assigned_to is not null and old.assigned_to <> v_uid then
    raise exception 'not_assignee' using errcode = '42501';
  end if;

  if new.status = 'in_review' and new.assigned_to is null then
    new.assigned_to := v_uid;
  end if;

  if new.status in ('escalated', 'confirmed_fraud', 'false_positive')
     and new.status is distinct from old.status then
    if new.resolution_note is null or char_length(btrim(new.resolution_note)) < 10 then
      raise exception 'note_required' using errcode = '23514';
    end if;
  end if;

  if new.status in ('confirmed_fraud', 'false_positive') then
    new.resolved_at := now();
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger alerts_guard
  before update on public.alerts
  for each row execute function private.guard_alert_update();

-- Automatic, tamper-proof audit of every alert change.
create or replace function private.audit_alert_change()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.audit_log (actor_id, action, entity_type, entity_id, details)
  values (
    (select auth.uid()),
    case when tg_op = 'INSERT' then 'alert.created'
         when new.status is distinct from old.status then 'alert.status_changed'
         when new.ai_generated_at is distinct from old.ai_generated_at then 'alert.ai_summary'
         else 'alert.updated' end,
    'alert',
    new.id::text,
    case when tg_op = 'INSERT'
      then jsonb_build_object('risk_score', new.risk_score, 'severity', new.severity)
      else jsonb_build_object(
        'from', old.status, 'to', new.status,
        'assigned_to', new.assigned_to,
        'note', new.resolution_note)
    end
  );
  return new;
end;
$$;

create trigger alerts_audit
  after insert or update on public.alerts
  for each row execute function private.audit_alert_change();

create or replace function private.block_audit_mutation()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  raise exception 'audit_log_append_only' using errcode = '42501';
end;
$$;

create trigger audit_log_immutable
  before update or delete on public.audit_log
  for each row execute function private.block_audit_mutation();

-- ───────────────────────── RLS ─────────────────────────
alter table public.profiles     enable row level security;
alter table public.customers    enable row level security;
alter table public.transactions enable row level security;
alter table public.fraud_labels enable row level security;
alter table public.alerts       enable row level security;
alter table public.audit_log    enable row level security;

-- Defense in depth: anon has no table privileges at all.
revoke all on public.profiles, public.customers, public.transactions,
              public.fraud_labels, public.alerts, public.audit_log from anon;
-- Users never delete or truncate; audit_log is never mutated.
revoke delete, truncate on public.profiles, public.customers, public.transactions,
              public.fraud_labels, public.alerts, public.audit_log from authenticated;
revoke insert on public.profiles, public.customers, public.transactions,
                 public.fraud_labels, public.alerts from authenticated;
revoke update on public.customers, public.transactions, public.fraud_labels, public.audit_log from authenticated;
revoke update, delete, truncate on public.audit_log from service_role;

create policy profiles_select on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or private.is_supervisor());

create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

create policy customers_select on public.customers
  for select to authenticated using (private.is_staff());

create policy transactions_select on public.transactions
  for select to authenticated using (private.is_staff());

create policy fraud_labels_select on public.fraud_labels
  for select to authenticated using (private.is_supervisor());

create policy alerts_select on public.alerts
  for select to authenticated using (private.is_staff());

create policy alerts_update on public.alerts
  for update to authenticated
  using (private.is_staff())
  with check (private.is_staff());

create policy audit_insert_self on public.audit_log
  for insert to authenticated
  with check (private.is_staff() and actor_id = (select auth.uid()));

create policy audit_select on public.audit_log
  for select to authenticated using (private.is_supervisor());

-- ───────────────────────── Realtime ─────────────────────────
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.alerts;
  end if;
end;
$$;
