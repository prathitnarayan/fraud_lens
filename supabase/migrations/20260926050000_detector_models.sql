-- P6: advisory detector models (Behaviour, Beneficiary, Network) stored beside the rules score.
-- Models never touch risk_score or alert creation; they add context and "agreement".

alter table public.risk_assessments
  add column behaviour_score   smallint check (behaviour_score between 0 and 100),
  add column beneficiary_score smallint check (beneficiary_score between 0 and 100),
  add column network_score     smallint check (network_score between 0 and 100),
  add column agreement         text check (agreement in ('HIGH', 'MIXED', 'LOW')),
  add column model_only        boolean not null default false,
  add column model_factors     jsonb not null default '{}'::jsonb,
  add column model_version     text;

create index risk_assessments_model_only_idx on public.risk_assessments (model_only) where model_only;

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
    (transaction_id, customer_id, score, severity, reason_codes, evidence, features, ruleset_version, assessed_at,
     behaviour_score, beneficiary_score, network_score, agreement, model_only, model_factors, model_version)
  select (r ->> 'transaction_id')::uuid,
         (r ->> 'customer_id')::uuid,
         (r ->> 'score')::smallint,
         (r ->> 'severity')::public.alert_severity,
         array(select jsonb_array_elements_text(coalesce(r -> 'reason_codes', '[]'::jsonb))),
         coalesce(r -> 'evidence', '[]'::jsonb),
         coalesce(r -> 'features', '{}'::jsonb),
         r ->> 'ruleset_version',
         now(),
         (r ->> 'behaviour_score')::smallint,
         (r ->> 'beneficiary_score')::smallint,
         (r ->> 'network_score')::smallint,
         r ->> 'agreement',
         coalesce((r ->> 'model_only')::boolean, false),
         coalesce(r -> 'model_factors', '{}'::jsonb),
         r ->> 'model_version'
  from jsonb_array_elements(p_rows) r
  on conflict (transaction_id) do update
    set score = excluded.score,
        severity = excluded.severity,
        reason_codes = excluded.reason_codes,
        evidence = excluded.evidence,
        features = excluded.features,
        ruleset_version = excluded.ruleset_version,
        assessed_at = excluded.assessed_at,
        behaviour_score = excluded.behaviour_score,
        beneficiary_score = excluded.beneficiary_score,
        network_score = excluded.network_score,
        agreement = excluded.agreement,
        model_only = excluded.model_only,
        model_factors = excluded.model_factors,
        model_version = excluded.model_version;
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
