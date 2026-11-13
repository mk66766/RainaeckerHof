-- Batteriewechsel (Stromzaun, Hühnerklappe) darf nur der Admin ändern.
-- Die Daten liegen in projects.settings (battery_fence, battery_door); dafür ist keine neue
-- Tabelle oder Spalte nötig. Dieses Skript ergänzt nur die Sperre für Familien ohne Admin-Recht.
-- Einmal im Supabase SQL-Editor ausführen. Ohne das Skript funktioniert die App trotzdem.
create or replace function app.guard_project_settings()
 returns trigger language plpgsql security definer set search_path to ''
as $function$
declare k text;
begin
  if (select auth.uid()) is null or app.is_admin() then return new; end if;   -- Service-Rolle/SQL und Admin dürfen alles
  foreach k in array array['start_date', 'live_start', 'paypal_me', 'last_backup', 'hens', 'hens_history', 'quota', 'price_intern', 'price_extern', 'notice', 'battery_fence', 'battery_door'] loop
    if (old.settings -> k) is distinct from (new.settings -> k) then
      raise exception 'Diese Einstellung darf nur der Admin ändern (%).', k using errcode = '42501';
    end if;
  end loop;
  return new;
end $function$;
revoke all on function app.guard_project_settings() from public, anon, authenticated;
