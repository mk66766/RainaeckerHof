-- Datenbank-Änderungen vom 20.10.2026 (bereits in Supabase eingespielt; hier zur Dokumentation)
-- 1) Zahlungsstatus für Verkäufe/Zusatz-Eier, Trinkgeld als verknüpfte Buchung, Kassenabgleich
alter table public.transactions
  add column if not exists seller_id uuid references public.families(id) on delete set null,
  add column if not exists pay_method text check (pay_method in ('bar','paypal')),
  add column if not exists pay_state text check (pay_state in ('bar_offen','pruefen','bestaetigt')),
  add column if not exists parent_id uuid references public.transactions(id) on delete cascade,
  add column if not exists confirmed_at timestamptz,
  add column if not exists confirmed_by uuid;
create index if not exists transactions_parent_idx on public.transactions (parent_id);
create table public.cash_checks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid not null default auth.uid(),
  paypal_balance numeric(10,2) not null, expected numeric(10,2) not null,
  open_cash numeric(10,2) not null default 0, note text not null default ''
);
create index on public.cash_checks (project_id, created_at desc);
alter table public.cash_checks enable row level security;
create policy "Mitglieder lesen Abgleiche" on public.cash_checks for select to authenticated using (app.is_member(project_id));
create policy "Mitglieder erstellen Abgleiche" on public.cash_checks for insert to authenticated with check (app.is_member(project_id) and created_by = (select auth.uid()));
create policy "Mitglieder löschen Abgleiche" on public.cash_checks for delete to authenticated using (app.is_member(project_id));
revoke all on public.cash_checks from anon;
create trigger audit_cash_checks after update or delete on public.cash_checks for each row execute function app.log_change();

-- 2) Erinnerungen: Schalter je Gerät + stündlicher Zeitplan (die Funktion handelt nur um 18 Uhr Berlin)
alter table public.push_subscriptions add column if not exists reminders boolean not null default true;
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('hof-erinnerungen', '0 * * * *', $job$
  select net.http_post(
    url := (select value from public.push_config where key = 'function_url'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', (select value from public.push_config where key = 'hook_secret')),
    body := '{"reminders": true}'::jsonb);
$job$);

-- 3) Familienverwaltung
alter table public.families add column if not exists left_on date;
create or replace function app.is_family() returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.families f where f.user_id = (select auth.uid())) $$;
revoke all on function app.is_family() from public, anon; grant execute on function app.is_family() to authenticated;
drop policy if exists "eigene und gemeinsame Familien lesen" on public.families;
create policy "Familien lesen" on public.families for select to authenticated using (app.is_family());
create or replace function public.login_families() returns table(name text, email text) language sql stable security definer set search_path = '' as $$
  select f.name, u.email::text from public.families f join auth.users u on u.id = f.user_id
  where f.left_on is null or f.left_on > current_date order by f.name $$;
revoke all on function public.login_families() from public; grant execute on function public.login_families() to anon, authenticated;
create or replace function public.kill_sessions(uid uuid) returns void language sql security definer set search_path = '' as $$
  delete from auth.sessions where user_id = uid $$;
revoke all on function public.kill_sessions(uuid) from public, anon, authenticated; grant execute on function public.kill_sessions(uuid) to service_role;
-- Außerdem: app.hens_surplus() mit Übertrag (siehe CLAUDE.md), push_config-Einträge function_url/hook_secret/vapid_*/site_url.

-- 4) Admin-Konten (keine Familie): families.is_system; app.hens_surplus() rechnet sie nicht als Familie mit
alter table public.families add column if not exists is_system boolean not null default false;
-- app.hens_surplus(): im Block "reserved" zusätzlich: join public.families fx on fx.id = pm.family_id and not fx.is_system
