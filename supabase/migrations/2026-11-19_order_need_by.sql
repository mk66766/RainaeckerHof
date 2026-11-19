-- Frist für Nachbar-Bestellungen (19.11.2026)
-- Nachbarn können auf der Nachbar-Seite angeben, bis wann sie die Eier spätestens brauchen („Spätestens benötigt bis“).
-- Freiwillig: ohne Angabe bleibt need_by leer. Die App zeigt die Frist in der Karte „Bestellungen von Nachbarn“.
-- Reihenfolge: ZUERST dieses Skript einspielen, DANN die neue nachbarn.html deployen
-- (die alte Seite funktioniert mit dem neuen Skript weiter, weil p_need_by einen Standardwert hat).

alter table public.egg_orders add column if not exists need_by timestamptz;   -- spätestens benötigt bis (vom Nachbarn)

-- alte Fassung mit drei Parametern entfernen, sonst gibt es zwei gleichnamige Funktionen
drop function if exists public.place_egg_order(text, integer, text);

create or replace function public.place_egg_order(p_buyer text, p_qty integer, p_hp text default '', p_need_by timestamptz default null)
returns jsonb
language plpgsql security definer set search_path to ''
as $$
declare
  hens uuid;
  v_buyer text := regexp_replace(trim(coalesce(p_buyer, '')), '\s+', ' ', 'g');
  v_open_cnt int;
  v_same_cnt int;
  v_recent int;
  v_free int;
  v_wait boolean;
  v_pos int;
  v_id uuid;
begin
  if coalesce(p_hp, '') <> '' then
    return jsonb_build_object('ok', true, 'message', 'Danke!', 'available', 0);
  end if;
  if char_length(v_buyer) < 2 or char_length(v_buyer) > 80 then
    return jsonb_build_object('ok', false, 'message', 'Bitte gib deine Familie an (mindestens 2 Zeichen).');
  end if;
  if p_qty is null or p_qty < 1 or p_qty > 30 then
    return jsonb_build_object('ok', false, 'message', 'Bitte gib eine Stückzahl zwischen 1 und 30 an.');
  end if;
  -- Frist: nicht in der Vergangenheit (5 Minuten Spielraum für Uhren), höchstens 60 Tage voraus
  if p_need_by is not null and p_need_by < now() - interval '5 minutes' then
    return jsonb_build_object('ok', false, 'message', 'Datum und Uhrzeit liegen in der Vergangenheit.');
  end if;
  if p_need_by is not null and p_need_by > now() + interval '61 days' then
    return jsonb_build_object('ok', false, 'message', 'Bitte wähle ein Datum in den nächsten 60 Tagen.');
  end if;

  select id into hens from public.projects where kind = 'hens' order by created_at limit 1;
  if hens is null then
    return jsonb_build_object('ok', false, 'message', 'Bestellungen sind gerade nicht möglich.');
  end if;

  perform pg_advisory_xact_lock(hashtext('egg_orders'));

  select count(*) filter (where status = 'offen' and created_at > now() - interval '7 days'),
         count(*) filter (where status = 'offen' and created_at > now() - interval '7 days' and lower(buyer) = lower(v_buyer)),
         count(*) filter (where created_at > now() - interval '10 minutes')
    into v_open_cnt, v_same_cnt, v_recent
    from public.egg_orders where project_id = hens;

  if v_recent >= 10 then
    return jsonb_build_object('ok', false, 'message', 'Gerade gehen sehr viele Bestellungen ein. Bitte versuche es in ein paar Minuten noch einmal.');
  end if;
  if v_open_cnt >= 25 then
    return jsonb_build_object('ok', false, 'message', 'Zurzeit sind keine weiteren Bestellungen möglich.');
  end if;
  if v_same_cnt >= 2 then
    return jsonb_build_object('ok', false, 'message', 'Von dir sind schon Bestellungen offen. Bitte melde dich direkt bei der Familie.');
  end if;

  select greatest(0, app.hens_surplus(hens) - coalesce(sum(q.qty) filter (where q.ready), 0)),
         coalesce(count(*) filter (where not q.ready), 0)
    into v_free, v_pos from app.order_queue(hens) q;
  v_wait := p_qty > v_free;

  insert into public.egg_orders (project_id, buyer, qty, waited, need_by) values (hens, v_buyer, p_qty, v_wait, p_need_by) returning id into v_id;

  if v_wait then
    return jsonb_build_object('ok', true, 'id', v_id, 'waiting', true, 'pos', v_pos + 1,
      'message', 'Danke! Gerade sind nicht genug Eier frei. Du stehst auf der Warteliste. Den Stand siehst du auf dieser Seite.',
      'available', v_free);
  end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'waiting', false, 'message', 'Danke! Deine Bestellung ist eingegangen.', 'available', v_free - p_qty);
end $$;

revoke all on function public.place_egg_order(text, integer, text, timestamptz) from public;
grant execute on function public.place_egg_order(text, integer, text, timestamptz) to anon, authenticated, service_role;

-- PostgREST die neue Signatur sofort bekannt machen
notify pgrst, 'reload schema';
