-- Nur der Admin (families.is_admin) darf: Kassenabgleich anlegen/löschen, Erfassung (start_date, live_start),
-- Zahlung (paypal_me) und Sichern (last_backup) ändern. Alle anderen Einstellungen bleiben für jede Familie offen.

drop policy if exists "Mitglieder erstellen Abgleiche" on public.cash_checks;
drop policy if exists "Mitglieder löschen Abgleiche" on public.cash_checks;
create policy "Admin erstellt Abgleiche" on public.cash_checks for insert to authenticated
  with check (app.is_member(project_id) and app.is_admin() and created_by = (select auth.uid()));
create policy "Admin löscht Abgleiche" on public.cash_checks for delete to authenticated
  using (app.is_member(project_id) and app.is_admin());

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

drop trigger if exists guard_project_settings on public.projects;
create trigger guard_project_settings before update on public.projects
  for each row execute function app.guard_project_settings();
