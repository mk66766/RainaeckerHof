-- Eingespielt am 20.10.2026 als Migration admin_only_settings_and_cash_checks.
-- Nur der Admin (families.is_admin) darf: Kassenabgleich anlegen/löschen, Erfassung (start_date, live_start),
-- Zahlung (paypal_me) und Sichern (last_backup) ändern. Alle anderen Einstellungen bleiben für jede Familie offen.
alter policy "Mitglieder erstellen Abgleiche" on public.cash_checks
  with check (app.is_member(project_id) and app.is_admin() and created_by = (select auth.uid()));
alter policy "Mitglieder erstellen Abgleiche" on public.cash_checks rename to "Admin erstellt Abgleiche";
alter policy "Mitglieder löschen Abgleiche" on public.cash_checks
  using (app.is_member(project_id) and app.is_admin());
alter policy "Mitglieder löschen Abgleiche" on public.cash_checks rename to "Admin löscht Abgleiche";

create or replace function app.guard_project_settings() returns trigger language plpgsql security definer set search_path = '' as $$
declare k text;
begin
  if (select auth.uid()) is null or app.is_admin() then return new; end if;   -- Service-Rolle/SQL und Admin dürfen alles
  foreach k in array array['start_date', 'live_start', 'paypal_me', 'last_backup'] loop
    if (old.settings -> k) is distinct from (new.settings -> k) then
      raise exception 'Diese Einstellung darf nur der Admin ändern (%).', k using errcode = '42501';
    end if;
  end loop;
  return new;
end $$;
revoke all on function app.guard_project_settings() from public, anon, authenticated;

create trigger guard_project_settings before update on public.projects
  for each row execute function app.guard_project_settings();
