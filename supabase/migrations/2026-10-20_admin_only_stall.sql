-- Eingespielt am 20.10.2026 als Migration admin_only_stall_and_prices.
-- Stall (Hennenbestand, Eier pro Familie und Woche) und Preise darf nur noch der Admin ändern.
create or replace function app.guard_project_settings() returns trigger language plpgsql security definer set search_path = '' as $$
declare k text;
begin
  if (select auth.uid()) is null or app.is_admin() then return new; end if;   -- Service-Rolle/SQL und Admin dürfen alles
  foreach k in array array['start_date', 'live_start', 'paypal_me', 'last_backup', 'hens', 'hens_history', 'quota', 'price_intern', 'price_extern'] loop
    if (old.settings -> k) is distinct from (new.settings -> k) then
      raise exception 'Diese Einstellung darf nur der Admin ändern (%).', k using errcode = '42501';
    end if;
  end loop;
  return new;
end $$;
revoke all on function app.guard_project_settings() from public, anon, authenticated;
