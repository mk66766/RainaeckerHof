-- Admin-Tab (25.10.2026): Übersicht für den Admin, Protokoll der Erinnerungs-Läufe, Hinweis an alle nur durch den Admin.

-- 1) Läufe der täglichen Erinnerungen (schreibt nur die Edge Function notify-order mit der Service-Rolle)
create table if not exists public.reminder_runs (
  id bigint generated always as identity primary key,
  ran_at timestamptz not null default now(),
  kind text not null,                -- 'lauf' (18-Uhr-Lauf), 'fehler'
  result jsonb
);
alter table public.reminder_runs enable row level security;
revoke all on public.reminder_runs from anon, authenticated;
-- keine Regeln: gelesen wird nur über public.admin_overview()

-- 2) Hinweis an alle (settings.notice) darf nur der Admin ändern
create or replace function app.guard_project_settings()
 returns trigger language plpgsql security definer set search_path to ''
as $function$
declare k text;
begin
  if (select auth.uid()) is null or app.is_admin() then return new; end if;   -- Service-Rolle/SQL und Admin dürfen alles
  foreach k in array array['start_date', 'live_start', 'paypal_me', 'last_backup', 'hens', 'hens_history', 'quota', 'price_intern', 'price_extern', 'notice'] loop
    if (old.settings -> k) is distinct from (new.settings -> k) then
      raise exception 'Diese Einstellung darf nur der Admin ändern (%).', k using errcode = '42501';
    end if;
  end loop;
  return new;
end $function$;

-- 3) Übersicht für den Admin: Anmeldungen, Aktivität, Geräte, Erinnerungen, Offenes je Projekt
create or replace function public.admin_overview()
 returns jsonb language plpgsql stable security definer set search_path to ''
as $function$
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
revoke all on function public.admin_overview() from public, anon;
grant execute on function public.admin_overview() to authenticated;
