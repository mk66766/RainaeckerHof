-- Erinnerungen für offene Bestellungen (19.11.2026)
-- Die Familie mit Dienst bekommt alle 2 Stunden eine Push-Erinnerung, solange eine bereite Bestellung offen ist
-- (nur 8 bis 20 Uhr Berliner Zeit). Die anderen Familien bekommen nur einmal die Meldung „Neue Bestellung“.
-- Gerechnet wird in der Edge Function notify-order (orders.ts), angestoßen vom vorhandenen Zeitplan
-- „bestellungen-warteliste“ (alle 10 Minuten, {queue:true}). Kein neuer Zeitplan nötig.

alter table public.egg_orders add column if not exists reminded_at timestamptz;   -- letzte Erinnerung an die Familie mit Dienst

-- Offene Bestellungen für Push: ganze Zeile (damit neue Spalten wie eine Frist mitkommen) plus „bereit“,
-- Platz auf der Warteliste und Nutzer der Familie mit Dienst in dieser Woche. Nur für die Edge Function.
create or replace function public.open_orders_push()
returns setof jsonb
language plpgsql stable security definer set search_path to ''
as $$
declare
  hens uuid;
  wk date := date_trunc('week', (now() at time zone 'Europe/Berlin'))::date;
  duty uuid;
begin
  select p.id into hens from public.projects p where p.kind = 'hens' order by p.created_at limit 1;
  if hens is null then return; end if;
  select f.user_id into duty from public.duty_swaps d join public.families f on f.id = d.family_id
   where d.project_id = hens and d.week_start = wk and f.left_on is null;
  return query
  select to_jsonb(e) || jsonb_build_object('ready', q.ready, 'pos', q.pos, 'duty_user', duty)
    from public.egg_orders e join app.order_queue(hens) q on q.id = e.id
   order by e.created_at;
end $$;
revoke all on function public.open_orders_push() from public, anon, authenticated;
grant execute on function public.open_orders_push() to service_role;
