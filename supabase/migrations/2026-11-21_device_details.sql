-- Geräte im Tab Admin genauer anzeigen (21.11.2026).
-- 1. Tabelle device_info: je Anmeldung (auth.sessions.id) meldet die App beim Start, ob sie vom Home-Bildschirm
--    läuft, ob Benachrichtigungen am Handy erlaubt sind und welches Push-Abo (endpoint) dazugehört.
--    Geschrieben wird nur über die RPC report_device() (Sitzung und Nutzer kommen aus der Anmeldung, nicht vom Gerät).
--    Keine IP-Adresse, kein Standort.
-- 2. push_subscriptions: notify-order trägt nach jedem Versand ein, ob die Nachricht angekommen ist.
-- 3. admin_overview(): je Familie die Liste der angemeldeten Geräte ('device_list') und Push-Geräte ohne
--    passende Anmeldung ('device_extra'). Alle bisherigen Felder bleiben gleich.
-- Ohne diese Migration zeigt die App die Geräteliste nicht an, sonst ändert sich nichts.

create table if not exists public.device_info (
  session_id  uuid primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  user_agent  text,
  standalone  boolean,
  permission  text check (permission in ('granted', 'denied', 'default', 'unsupported')),
  endpoint    text,
  first_seen  timestamptz not null default now(),
  seen_at     timestamptz not null default now()
);
create index if not exists device_info_user_idx on public.device_info (user_id);
alter table public.device_info enable row level security;
revoke all on public.device_info from anon, authenticated;

create or replace function public.report_device(p_standalone boolean, p_permission text, p_endpoint text, p_user_agent text)
 returns void language plpgsql security definer set search_path to ''
as $function$
declare
  v_sid uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  v_uid uuid := auth.uid();
begin
  if v_uid is null or v_sid is null then return; end if;
  insert into public.device_info as d (session_id, user_id, user_agent, standalone, permission, endpoint)
  values (v_sid, v_uid, left(p_user_agent, 300), p_standalone,
          case when p_permission in ('granted', 'denied', 'default', 'unsupported') then p_permission end,
          left(p_endpoint, 1000))
  on conflict (session_id) do update
    set user_agent = excluded.user_agent, standalone = excluded.standalone, permission = excluded.permission,
        endpoint = excluded.endpoint, seen_at = now()
    where d.user_id = v_uid;
  -- Einträge zu Anmeldungen, die es nicht mehr gibt, aufräumen
  delete from public.device_info x where x.user_id = v_uid and not exists (select 1 from auth.sessions s where s.id = x.session_id);
end $function$;
revoke all on function public.report_device(boolean, text, text, text) from public, anon;
grant execute on function public.report_device(boolean, text, text, text) to authenticated;

alter table public.push_subscriptions add column if not exists last_push_at timestamptz;
alter table public.push_subscriptions add column if not exists last_push_ok boolean;
alter table public.push_subscriptions add column if not exists last_push_status integer;

CREATE OR REPLACE FUNCTION public.admin_overview()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not app.is_admin() then
    raise exception 'Nur für den Admin.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'families', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', f.id, 'name', f.name, 'system', f.is_system, 'left_on', f.left_on,
        'last_sign_in', u.last_sign_in_at,
        'last_seen', (select max(greatest(s.refreshed_at, s.updated_at, s.created_at)) from auth.sessions s where s.user_id = f.user_id),
        'devices', (select count(*) from public.push_subscriptions p where p.user_id = f.user_id),
        'devices_rem', (select count(*) from public.push_subscriptions p where p.user_id = f.user_id and p.reminders),
        'device_list', (
          select coalesce(jsonb_agg(jsonb_build_object(
            'since', x.created_at, 'seen', x.seen, 'ua', x.ua, 'info_at', x.info_at,
            'standalone', x.standalone, 'permission', x.permission,
            'push', x.push_id is not null, 'reminders', x.reminders,
            'last_push_at', x.last_push_at, 'last_push_ok', x.last_push_ok, 'last_push_status', x.last_push_status
          ) order by x.seen desc), '[]'::jsonb)
          from (
            select s.created_at, greatest(s.refreshed_at, s.updated_at, s.created_at) as seen,
                   coalesce(d.user_agent, s.user_agent) as ua, d.seen_at as info_at, d.standalone, d.permission,
                   p.id as push_id, p.reminders, p.last_push_at, p.last_push_ok, p.last_push_status
            from auth.sessions s
            left join public.device_info d on d.session_id = s.id
            left join public.push_subscriptions p on p.user_id = s.user_id and p.endpoint = d.endpoint
            where s.user_id = f.user_id and (s.not_after is null or s.not_after > now())
            order by greatest(s.refreshed_at, s.updated_at, s.created_at) desc
            limit 10
          ) x
        ),
        'device_extra', (
          select coalesce(jsonb_agg(jsonb_build_object(
            'since', p.created_at, 'ua', p.user_agent, 'reminders', p.reminders,
            'last_push_at', p.last_push_at, 'last_push_ok', p.last_push_ok, 'last_push_status', p.last_push_status
          ) order by p.created_at desc), '[]'::jsonb)
          from public.push_subscriptions p
          where p.user_id = f.user_id
            and not exists (select 1 from public.device_info d join auth.sessions s on s.id = d.session_id
                            where d.user_id = p.user_id and d.endpoint = p.endpoint)
        ),
        'last_laid', (select max(e.created_at) from public.egg_log e where e.created_by = f.user_id and e.type = 'laid'),
        'last_egg', (select max(e.created_at) from public.egg_log e where e.created_by = f.user_id and e.type <> 'laid'),
        'last_tx', (select max(t.created_at) from public.transactions t where t.created_by = f.user_id),
        'last_change', (select max(a.changed_at) from public.audit_log a where a.changed_by = f.user_id)
      ) order by f.is_system, f.left_on nulls first, f.name), '[]'::jsonb)
      from public.families f left join auth.users u on u.id = f.user_id
    ),
    'runs', (
      select coalesce(jsonb_agg(jsonb_build_object('at', r.ran_at, 'kind', r.kind, 'result', r.result) order by r.ran_at desc), '[]'::jsonb)
      from (select * from public.reminder_runs order by ran_at desc limit 10) r
    ),
    'calls', (
      select coalesce(jsonb_agg(jsonb_build_object('at', h.created, 'status', h.status_code, 'error', h.error_msg, 'content', left(h.content, 300)) order by h.created desc), '[]'::jsonb)
      from (select * from net._http_response order by created desc limit 6) h
    ),
    'projects', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', p.id, 'kind', p.kind, 'name', p.name,
        'last_backup', p.settings ->> 'last_backup',
        'last_check', (select max(c.created_at) from public.cash_checks c where c.project_id = p.id),
        'duty_end', (select max(d.week_start) from public.duty_swaps d where d.project_id = p.id),
        'orders', (select count(*) from public.egg_orders o where o.project_id = p.id and o.status = 'offen'),
        'orders_oldest', (select min(o.created_at) from public.egg_orders o where o.project_id = p.id and o.status = 'offen'),
        'pruefen', (select jsonb_build_object('n', count(*), 'sum', coalesce(sum(t.amount + coalesce((select sum(k.amount) from public.transactions k where k.parent_id = t.id), 0)), 0), 'oldest', min(t.date))
                    from public.transactions t where t.project_id = p.id and t.parent_id is null and t.pay_state = 'pruefen'),
        'bar', (select coalesce(jsonb_agg(jsonb_build_object('name', x.name, 'n', x.n, 'sum', x.total, 'oldest', x.oldest)), '[]'::jsonb) from (
                  select coalesce(sf.name, '?') as name, count(*) as n, sum(t.amount + coalesce((select sum(k.amount) from public.transactions k where k.parent_id = t.id), 0)) as total, min(t.date) as oldest
                  from public.transactions t left join public.families sf on sf.id = t.seller_id
                  where t.project_id = p.id and t.parent_id is null and t.pay_state = 'bar_offen'
                  group by sf.name) x)
      ) order by p.kind desc), '[]'::jsonb)
      from public.projects p
    )
  );
end $function$;
