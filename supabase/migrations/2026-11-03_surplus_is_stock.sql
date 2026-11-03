-- Alles im Vorrat ist verkäuflich (03.11.2026): Es werden keine Wochenansprüche der Familien mehr zurückgelegt.
-- Überschuss = Vorrat ab Live-Start (Übertrag + gelegt − genommen − verkauft − Zusatz). Die Familien nehmen die ersten
-- Eier der Woche kostenlos, weitere zum internen Preis (über „Zusatz“, nur in der App geregelt).
create or replace function app.hens_surplus(hens uuid)
returns integer
language plpgsql stable security definer set search_path to ''
as $$
declare
  live date;
begin
  select nullif(settings->>'live_start', '')::date into live from public.projects where id = hens;
  return greatest(0, coalesce((
    select sum(case type when 'laid' then n when 'verzicht' then 0 else -n end)
      from public.egg_log where project_id = hens and (live is null or date >= live)), 0));
end $$;
