-- Warteliste für Nachbar-Bestellungen (27.10.2026)
-- Nachbarn dürfen auch bestellen, wenn gerade keine Eier frei sind. Offene Bestellungen werden der Reihe nach
-- (älteste zuerst) aus dem Überschuss bedient: passt eine Bestellung in den Rest, ist sie „bereit“, sonst „wartet“.
-- Nach 7 Tagen verfallen offene Bestellungen.

alter table public.egg_orders add column if not exists waited boolean not null default false;          -- kam auf die Warteliste
alter table public.egg_orders add column if not exists ready_notified_at timestamptz;                  -- Nachricht „kann raus“ verschickt
alter table public.egg_orders drop constraint if exists egg_orders_status_check;
alter table public.egg_orders add constraint egg_orders_status_check check (status = any (array['offen', 'erledigt', 'abgelehnt', 'verfallen']));

-- Reihenfolge der offenen Bestellungen: bereit (passt in den Überschuss) oder wartet (mit Platz auf der Warteliste)
create or replace function app.order_queue(hens uuid)
returns table (id uuid, qty int, ready boolean, pos int)
language plpgsql stable security definer set search_path to ''
as $$
declare
  rest int := app.hens_surplus(hens);
  w int := 0;
  o record;
begin
  for o in select e.id, e.qty from public.egg_orders e
           where e.project_id = hens and e.status = 'offen' and e.created_at > now() - interval '7 days'
           order by e.created_at, e.id loop
    id := o.id; qty := o.qty;
    if o.qty <= rest then
      rest := rest - o.qty; ready := true; pos := null;
    else
      w := w + 1; ready := false; pos := w;
    end if;
    return next;
  end loop;
end $$;

-- Bestellen: auch ohne freie Eier, dann auf die Warteliste
create or replace function public.place_egg_order(p_buyer text, p_qty integer, p_hp text default '')
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
  -- verstecktes Feld ausgefüllt = Bot: stillschweigend ignorieren
  if coalesce(p_hp, '') <> '' then
    return jsonb_build_object('ok', true, 'message', 'Danke!', 'available', 0);
  end if;
  if char_length(v_buyer) < 2 or char_length(v_buyer) > 80 then
    return jsonb_build_object('ok', false, 'message', 'Bitte gib deine Familie an (mindestens 2 Zeichen).');
  end if;
  if p_qty is null or p_qty < 1 or p_qty > 30 then
    return jsonb_build_object('ok', false, 'message', 'Bitte gib eine Stückzahl zwischen 1 und 30 an.');
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

  -- was nach den bereiten Bestellungen frei ist; passt die neue nicht hinein, wartet sie
  select greatest(0, app.hens_surplus(hens) - coalesce(sum(q.qty) filter (where q.ready), 0)),
         coalesce(count(*) filter (where not q.ready), 0)
    into v_free, v_pos from app.order_queue(hens) q;
  v_wait := p_qty > v_free;

  insert into public.egg_orders (project_id, buyer, qty, waited) values (hens, v_buyer, p_qty, v_wait) returning id into v_id;

  if v_wait then
    return jsonb_build_object('ok', true, 'id', v_id, 'waiting', true, 'pos', v_pos + 1,
      'message', 'Danke! Gerade sind nicht genug Eier frei. Du stehst auf der Warteliste. Den Stand siehst du auf dieser Seite.',
      'available', v_free);
  end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'waiting', false, 'message', 'Danke! Deine Bestellung ist eingegangen.', 'available', v_free - p_qty);
end $$;

-- Nachbar-Seite: frei = Überschuss minus bereite Bestellungen
create or replace function public.neighbor_info()
returns jsonb
language plpgsql stable security definer set search_path to ''
as $$
declare
  hens uuid;
  price numeric;
  note text;
  wk date := date_trunc('week', (now() at time zone 'Europe/Berlin'))::date;
  surplus int;
  ready_qty int;
  open_qty int;
  waiting int;
  duty text;
begin
  select id, (settings->>'price_extern')::numeric, nullif(trim(settings->>'neighbor_note'), '')
    into hens, price, note
    from public.projects where kind = 'hens' order by created_at limit 1;

  if hens is null then
    return jsonb_build_object('available', 0, 'ordered', 0, 'waiting', 0, 'price', null, 'duty', null, 'note', null, 'updated', now());
  end if;

  surplus := app.hens_surplus(hens);
  select coalesce(sum(q.qty) filter (where q.ready), 0), coalesce(sum(q.qty), 0), count(*) filter (where not q.ready)
    into ready_qty, open_qty, waiting from app.order_queue(hens) q;

  select f.name into duty
    from public.duty_swaps d join public.families f on f.id = d.family_id
    where d.project_id = hens and d.week_start = wk;

  return jsonb_build_object('available', greatest(0, surplus - ready_qty), 'ordered', open_qty, 'waiting', waiting,
                            'price', price, 'duty', duty, 'note', note, 'updated', now());
end $$;

-- Nachbar-Seite: Stand der eigenen Bestellungen (die IDs kennt nur das Gerät, das bestellt hat)
create or replace function public.order_status(p_ids uuid[])
returns jsonb
language plpgsql stable security definer set search_path to ''
as $$
declare
  hens uuid;
begin
  if p_ids is null or cardinality(p_ids) = 0 or cardinality(p_ids) > 10 then return '[]'::jsonb; end if;
  select id into hens from public.projects where kind = 'hens' order by created_at limit 1;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', e.id, 'qty', e.qty, 'created', e.created_at,
             'status', case when e.status = 'offen' and e.created_at <= now() - interval '7 days' then 'verfallen'
                            when e.status = 'offen' and q.ready then 'bereit'
                            when e.status = 'offen' then 'wartet' else e.status end,
             'pos', q.pos) order by e.created_at)
      from public.egg_orders e left join app.order_queue(hens) q on q.id = e.id
     where e.id = any(p_ids)), '[]'::jsonb);
end $$;
revoke all on function public.order_status(uuid[]) from public;
grant execute on function public.order_status(uuid[]) to anon, authenticated;

-- Zeitplan (alle 10 Minuten, über notify-order {queue:true}): Bestellungen nach 7 Tagen verfallen lassen und
-- wartende Bestellungen melden, die jetzt in den Überschuss passen. Liefert jede nur einmal.
create or replace function public.take_ready_orders()
returns table (id uuid, project_id uuid, buyer text, qty int, duty_user uuid)
language plpgsql security definer set search_path to ''
as $$
declare
  hens uuid;
  wk date := date_trunc('week', (now() at time zone 'Europe/Berlin'))::date;
begin
  update public.egg_orders e set status = 'verfallen'
   where e.status = 'offen' and e.created_at <= now() - interval '7 days';
  select p.id into hens from public.projects p where p.kind = 'hens' order by p.created_at limit 1;
  if hens is null then return; end if;
  return query
  with r as (
    update public.egg_orders e set ready_notified_at = now()
      from app.order_queue(hens) q
     where q.id = e.id and q.ready and e.waited and e.ready_notified_at is null
    returning e.id, e.project_id, e.buyer, e.qty)
  select r.id, r.project_id, r.buyer, r.qty,
         (select f.user_id from public.duty_swaps d join public.families f on f.id = d.family_id
           where d.project_id = r.project_id and d.week_start = wk)
    from r;
end $$;
revoke all on function public.take_ready_orders() from public, anon, authenticated;
grant execute on function public.take_ready_orders() to service_role;

revoke all on function app.order_queue(uuid) from public, anon, authenticated;

select cron.schedule('bestellungen-warteliste', '*/10 * * * *', $c$
    select net.http_post(
      url := (select value from public.push_config where key = 'function_url'),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', (select value from public.push_config where key = 'hook_secret')),
      body := '{"queue": true}'::jsonb
    );
$c$);
