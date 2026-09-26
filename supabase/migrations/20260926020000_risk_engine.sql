-- P2: persisted risk assessments + explainable, idempotent alerts.

create table public.risk_assessments (
  transaction_id  uuid primary key references public.transactions (id) on delete cascade,
  customer_id     uuid not null references public.customers (id) on delete cascade,
  score           smallint not null check (score between 0 and 100),
  severity        public.alert_severity not null,
  reason_codes    text[] not null default '{}',
  evidence        jsonb not null default '[]'::jsonb,
  features        jsonb not null default '{}'::jsonb,
  ruleset_version text not null,
  assessed_at     timestamptz not null default now()
);
create index risk_assessments_score_idx on public.risk_assessments (score desc);

alter table public.alerts
  add column evidence        jsonb not null default '[]'::jsonb,
  add column ruleset_version text;

alter table public.risk_assessments enable row level security;
revoke all on public.risk_assessments from anon;
revoke insert, update, delete, truncate on public.risk_assessments from authenticated;
create policy risk_assessments_select on public.risk_assessments
  for select to authenticated using (private.is_staff());

-- Evidence and ruleset version are immutable to users, like score and reason codes.
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
     or new.resolved_at  is distinct from old.resolved_at
     or new.evidence     is distinct from old.evidence
     or new.ruleset_version is distinct from old.ruleset_version then
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

/**
 * Atomically upserts assessments and creates alerts for rows flagged alert=true.
 * Idempotent: assessments are overwritten with the same values; existing alerts are never
 * touched (analyst status, assignment and notes survive re-runs).
 * Executable by service_role only.
 */
create or replace function public.apply_risk_assessments(p_rows jsonb)
returns table (assessed integer, alerts_created integer)
language plpgsql
set search_path = ''
as $$
declare
  v_assessed integer;
  v_alerts   integer;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'p_rows must be a JSON array' using errcode = '22023';
  end if;

  insert into public.risk_assessments
    (transaction_id, customer_id, score, severity, reason_codes, evidence, features, ruleset_version, assessed_at)
  select (r ->> 'transaction_id')::uuid,
         (r ->> 'customer_id')::uuid,
         (r ->> 'score')::smallint,
         (r ->> 'severity')::public.alert_severity,
         array(select jsonb_array_elements_text(coalesce(r -> 'reason_codes', '[]'::jsonb))),
         coalesce(r -> 'evidence', '[]'::jsonb),
         coalesce(r -> 'features', '{}'::jsonb),
         r ->> 'ruleset_version',
         now()
  from jsonb_array_elements(p_rows) r
  on conflict (transaction_id) do update
    set score = excluded.score,
        severity = excluded.severity,
        reason_codes = excluded.reason_codes,
        evidence = excluded.evidence,
        features = excluded.features,
        ruleset_version = excluded.ruleset_version,
        assessed_at = excluded.assessed_at;
  get diagnostics v_assessed = row_count;

  insert into public.alerts (transaction_id, customer_id, risk_score, severity, reason_codes, evidence, ruleset_version)
  select (r ->> 'transaction_id')::uuid,
         (r ->> 'customer_id')::uuid,
         (r ->> 'score')::smallint,
         (r ->> 'severity')::public.alert_severity,
         array(select jsonb_array_elements_text(r -> 'reason_codes')),
         coalesce(r -> 'evidence', '[]'::jsonb),
         r ->> 'ruleset_version'
  from jsonb_array_elements(p_rows) r
  where (r ->> 'alert')::boolean
  on conflict (transaction_id) do nothing;
  get diagnostics v_alerts = row_count;

  return query select v_assessed, v_alerts;
end;
$$;

revoke all on function public.apply_risk_assessments(jsonb) from public, anon, authenticated;
grant execute on function public.apply_risk_assessments(jsonb) to service_role;
