-- P4: investigation workspace visibility.
-- Staff can read the history of alerts (not the rest of the audit log) for Decision Replay,
-- and see colleagues' names/roles for the decision trail.

create policy audit_select_alert_history on public.audit_log
  for select to authenticated
  using (private.is_staff() and entity_type = 'alert');

create policy profiles_select_staff on public.profiles
  for select to authenticated
  using (private.is_staff());
