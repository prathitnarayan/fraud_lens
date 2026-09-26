-- P5: break score ties. risk_score is capped at 100, so many strong alerts tie.
-- priority = uncapped evidence total (pattern weights + signals capped at 45), mirroring the engine.
-- Generated from evidence → always consistent, and users cannot write it.

create or replace function private.evidence_priority(ev jsonb)
returns integer
language sql immutable parallel safe set search_path = ''
as $$
  select coalesce(sum((e ->> 'weight')::int) filter (where e ->> 'pattern' is not null), 0)
       + least(45, coalesce(sum((e ->> 'weight')::int) filter (where e ->> 'pattern' is null), 0))
  from jsonb_array_elements(coalesce(ev, '[]'::jsonb)) e
$$;

alter table public.alerts
  add column priority integer generated always as (private.evidence_priority(evidence)) stored;

drop index if exists public.alerts_queue_idx;
create index alerts_queue_idx on public.alerts (status, risk_score desc, priority desc, created_at desc);
