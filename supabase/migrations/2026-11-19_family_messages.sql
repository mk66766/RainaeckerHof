-- Nachricht an Familien (19.11.2026): Jede Familie kann im Tab Hof eine kurze Push-Nachricht an alle oder
-- ausgewählte Familien des Projekts schicken. Verschickt wird über die Edge Function notify-order ({family_msg:true}).
-- Diese Tabelle ist das Protokoll und die Grundlage für die Sendesperre (1 Minute Abstand, höchstens 10 pro Tag
-- und Familie). Lesen und Schreiben nur mit dem Service-Schlüssel (keine Regeln für die App).
-- Ohne diese Tabelle lehnt notify-order das Senden ab („Datenbank-Update fehlt“).

create table if not exists public.family_messages (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  from_family uuid not null references public.families(id) on delete cascade,
  to_families uuid[] not null,
  text        text not null check (char_length(text) between 1 and 200),
  sent        integer not null default 0          -- zugestellte Geräte
);
create index if not exists family_messages_from_idx on public.family_messages (from_family, created_at desc);
alter table public.family_messages enable row level security;
revoke all on public.family_messages from anon, authenticated;

-- „Wer bekommt was?“: neue Art family_msg. Dabei auch door ergänzen (fehlte in der Datenbank,
-- Schalter „Neue Türzeiten“ ließ sich deshalb nicht speichern).
alter table public.push_prefs drop constraint if exists push_prefs_kind_check;
alter table public.push_prefs add constraint push_prefs_kind_check
  check (kind in ('order_new', 'order_ready', 'duty', 'cash', 'pay_check', 'month', 'door', 'family_msg'));
