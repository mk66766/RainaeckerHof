-- Übertrag aus Vorwochen von Hand korrigieren (20.11.2026, Wunsch des Nutzers; jede Familie darf).
-- Eine Korrektur ist ein egg_log-Eintrag type = 'korrektur' am Sonntag vor der laufenden Woche:
--   n    = Differenz zum bisher berechneten Übertrag (mit Vorzeichen, nie 0)
--   prev = Übertrag vorher (für die Anzeige „alt → neu“ im Verlauf)
--   note = Grund (Pflichtfeld in der App)
-- Wer und wann stehen wie bei allen Einträgen in created_by/created_at. Rechte: die bestehenden egg_log-Regeln
-- (Mitglied, 14 Tage rückwirkend, Admin unbegrenzt). Löschen und Ändern landen wie gewohnt im Änderungsprotokoll.
-- Ohne diese Migration lehnt die Datenbank das Speichern einer Korrektur ab, sonst funktioniert die App wie vorher.

alter table public.egg_log add column if not exists note text;
alter table public.egg_log add column if not exists prev integer;

alter table public.egg_log drop constraint if exists egg_log_type_check;
alter table public.egg_log add constraint egg_log_type_check
  check (type = any (array['laid', 'take', 'sale', 'zusatz', 'verzicht', 'korrektur']));

alter table public.egg_log drop constraint if exists egg_log_n_check;
alter table public.egg_log add constraint egg_log_n_check
  check (n > 0 or (type = 'korrektur' and n <> 0));

-- Überschuss = Vorrat ab Live-Start; eine Korrektur zählt mit ihrem Vorzeichen (vorher hätte „else -n“ sie abgezogen).
create or replace function app.hens_surplus(hens uuid)
returns integer
language plpgsql stable security definer set search_path to ''
as $$
declare
  live date;
begin
  select nullif(settings->>'live_start', '')::date into live from public.projects where id = hens;
  return greatest(0, coalesce((
    select sum(case type when 'laid' then n when 'korrektur' then n when 'verzicht' then 0 else -n end)
      from public.egg_log where project_id = hens and (live is null or date >= live)), 0));
end $$;
