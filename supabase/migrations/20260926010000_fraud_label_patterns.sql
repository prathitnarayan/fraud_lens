-- P1: stable pattern codes + scenario grouping for evaluation/debugging.
alter table public.fraud_labels
  add column scenario_ref text,
  add constraint fraud_labels_pattern_chk check (
    pattern in ('VELOCITY_BURST', 'NEW_DEVICE_HIGH_VALUE', 'GEO_MISMATCH',
                'MULE_FAN_IN', 'MULE_FAN_OUT', 'STRUCTURING')
  );
