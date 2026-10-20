# Übergabe: „Unser Rainäcker Hof“ (Stand Dienstag, 20.10.2026, Abend)

Diese Datei enthält oben die Zusammenfassung und ab Abschnitt 8 den **vollständigen aktuellen Code** (App, Nachbar-Seite, Service Worker, Edge Functions, Tests, Datenbank-Quelltext, Zugriffsregeln). Geheimnisse (privater Push-Schlüssel, Hook-Geheimnis, Login-Codes) stehen **nicht** darin und dürfen nie in Chat oder Code.

## 1. Ziel

Gemeinschafts-App für zwei Hof-Projekte, deutsch, mobile-first, ein Nutzerkreis aus Laien:

- **Hühner:** Familien Bader, Hatesaul, Kaufmann, Stopfer (Bader scheidet ab KW 44 / Mo 26.10.2026 aus).
- **Ziegen:** Familien Kaufmann und Hatesaul.

Funktionen: Eier zählen, Wochenanspruch (10 Eier je Familie), Vorrat/Überschuss, Verkauf an Nachbarn (öffentliche Bestellseite `/nachbarn`), Gemeinschaftskasse mit PayPal-Zahlungskontrolle, Dienstplan, Automatiktür, Termine, Tiere/Gesundheit/Vorräte (Ziegen), Änderungsprotokoll, Push-Nachrichten, Familienverwaltung.

## 2. Technik und Zugänge (ohne Geheimnisse)

- **Frontend:** eine Datei `index.html` (Vanilla JS, kein Build-Schritt, CDN `@supabase/supabase-js@2.45.4`, eingebetteter QR-Code-Generator). In diesem Dokument heißt sie `huehner-hof.html`; im Deploy-Paket `index.html`. Dazu `nachbarn.html`, `sw.js`, `manifest.webmanifest`, `_headers`, `_redirects`, Icons (Binärdateien, erzeugt von `tools/make_assets.py`).
- **Supabase:** Projekt `huehner-hof`, Ref `ubboukewvvrriraxfuzn`, Org MK, Free-Tarif, Region eu-central-1, URL `https://ubboukewvvrriraxfuzn.supabase.co`. Der **Anon-Key steht im `CONFIG`-Block der App** (öffentlich, so gewollt). Service-Schlüssel nur in den Edge Functions.
- **Netlify:** Site `rainaecker-hof-rtti` (ID `94d4ae4d-e0be-44f4-af04-5be34b9e40e8`), `https://rainaecker-hof-rtti.netlify.app`. **Manueller Deploy per ZIP** (kein Git). Free-Tarif: 300 Credits/Monat, 15 pro Production-Deploy, also rund 20 Uploads im Monat. Deshalb Änderungen bündeln.
- **PayPal.me der Hühner-Kasse:** `paypal.me/RainaeckerHuehner` (in den Projekt-Einstellungen).
- **Logins:** `<name>@huehner.local` plus 6-stelliger Code (Ziffern). Die Codes sind absichtlich nirgends dokumentiert. Neue Zugänge legt die Familienverwaltung an.
- **Edge Functions** (beide `verify_jwt = false`, prüfen die Anmeldung selbst im Code):
  - `notify-order` (v2): Push bei neuer Bestellung (Datenbank-Trigger mit `x-hook-secret`), Test aus der App (`{test:true}` mit Nutzer-JWT) und **Erinnerungen** (`{reminders:true}` mit Hook-Geheimnis, `force:true` zum Testen).
  - `manage-family` (v2): Familien aufnehmen, Admin-Konto anlegen, Projekte zuteilen, Zugangscode ändern, Verwalter-Recht setzen, Familie entfernen. Nur für Verwalter.
- **Zeitplan:** `pg_cron`-Job `hof-erinnerungen`, `0 * * * *`, ruft stündlich `notify-order` mit `{reminders:true}`. Die Funktion handelt nur um 18 Uhr Berliner Zeit (`push_config.reminder_hour`, Standard 18).
- **`push_config`-Schlüssel** (Werte geheim, nur Service-Rolle): `function_url`, `hook_secret`, `vapid_public`, `vapid_private`, `site_url`.
- **Storage:** Bucket `tierfotos` (privat, nur Projektmitglieder).
- **Datenbank:** Tabellen, Regeln und Funktionen siehe Abschnitt 8. Autorität ist immer die laufende Datenbank; Abfragen zum Neu-Auslesen stehen am Ende von Abschnitt 8.

## 3. Wichtige Entscheidungen

**Eier und Vorrat**
- Wochenanspruch 10 Eier je Familie. **Verzicht** möglich (bewegt keinen Vorrat, senkt den Anspruch). **Zusatz-Eier** zum internen Preis (0,20 €), externer Preis 0,40 €. Auf der Nachbar-Seite steht nur der Preis pro Ei.
- **Live-Start 12.10.2026:** Vorrat, Überschuss und Eierpreis rechnen erst ab da. Frühere Eier zählen nur in der Statistik.
- **Hennenbestand mit Datum** (`hens_history`: 10 ab 27.7.2026, 9 ab 10.10.2026), Legeleistung tagesgenau.
- **Vorrat** = gelegt − entnommen − verkauft − Zusatz (seit Live-Start).
- **Überschuss (Verkaufsbestand) mit Übertrag:** Eier aus Vorwochen sind sofort verkäuflich und werden zuerst verkauft; von den Eiern der laufenden Woche gehen zuerst die offenen Wochenansprüche ab. Formel identisch in `surplusParts()` (App) und `app.hens_surplus()` (DB): `carry` = Bestand vor Wochenbeginn, `L/T/V` = gelegt/genommen/verkauft+Zusatz in der Woche, `reserved` = offene Ansprüche (nur **echte Familien**, Admin-Konten zählen nicht); `oldRem = max(0, carry−V)`, `newRem = L−T−max(0, V−carry)`, `surplus = max(0, min(carry+L−T−V, oldRem + max(0, newRem−reserved)))`.
- **Jeder Klick aufs Ei ist ein eigener `egg_log`-Eintrag** (n=1, `auto=true`, mit `created_by`/`created_at`, im Verlauf mit Name und Uhrzeit). Nachträge: `auto=false`. Altdaten sind Tagessummen.
- **Jede Familie darf zählen**, auch ohne Dienst. Nur ein Hinweisfenster (`dutyCheck`, einmal pro Tag und Woche) bei Zählen/Korrigieren/Nachtragen/Verkaufen durch eine Familie ohne Dienst. Bewusst ohne Hinweis: Entnehmen, Zusatz, Verzicht.

**Kasse**
- Alle Einnahmen (Verkauf, Zusatz) bleiben in der **Gemeinschaftskasse** für Gemeinschaftsausgaben (Zahler „Gemeinschaftskasse“). Sie werden **nicht** auf Familien verteilt.
- Nur Ausgaben, die eine **Familie** bezahlt hat, werden gleichmäßig auf die aktuellen Mitglieder verteilt. Ausgleich immer über die Kasse (Einzahlung/Auszahlung). Karte „Wer bekommt was?“ ist standardmäßig eingeklappt.
- **Zahlungsstatus** bei Verkauf/Zusatz: `bar_offen` → (Knopf „Eingezahlt“) `pruefen` → (Knopf „Eingang bestätigt“) `bestaetigt`; PayPal-Zahlung startet bei `pruefen`. Beim Bestätigen wird der echte Betrag eingegeben: mehr = **Trinkgeld** als eigene Buchung (`parent_id`), weniger = bleibt offen. Bar-Trinkgeld im Verkaufsfenster („Erhalten“). Im PayPal-Fenster „Auf … aufrunden“.
- **Bestand zählt nur bestätigte Eingänge** (`countsForStock`). Von Hand gebuchte Einnahmen zählen sofort. Alte Verkäufe ohne Status zählen erst nach „Erfassen“.
- **Kassenabgleich** (Karte in der Kasse, Tabelle `cash_checks`): Soll auf PayPal = Bestand (bestätigt) + Eingänge im Status `pruefen`. Mahnung nach 31 Tagen.
- Überfällig: Bargeld ab 7 Tagen, Prüfen ab 3 Tagen (rote Markierung, Push-Erinnerung).
- Es gibt **keinen Winter-Puffer** (bewusst entfernt).

**Dienstplan**
- Hühner: KW 43 Bader, ab KW 44 Hatesaul → Stopfer → Kaufmann reihum, fest in `duty_swaps` bis 27.12.2027.
- Ziegen: Kaufmann in ungeraden, Hatesaul in geraden Kalenderwochen (bewusst gegen die automatische Reihenfolge getauscht), fest eingetragen bis 27.12.2027; danach würde wieder die ungetauschte automatische Reihenfolge greifen.
- Änderungsfenster: Mitglieder 14 Tage rückwirkend, Verwalter unbegrenzt. Protokoll in `audit_log` (UPDATE/DELETE; das laufende Eierzählen von heute wird nicht protokolliert).

**Rechte**
- `families.is_admin` („Verwalter“) bedeutet heute: ältere Einträge unbegrenzt ändern (Eier, Buchungen, Dienstplan), fremde Termine ändern/löschen, **Familienverwaltung**. Alles andere (Einstellungen ändern, Tiere/Gesundheit löschen, Eingänge bestätigen, Kassenabgleich, Sichern, Dienst tauschen) kann **jede Familie**.
- **Stand:** nur **Kaufmann** ist Verwalter. **Geplant (vom Nutzer gewünscht):** ein eigenes **Admin-Konto** (`families.is_system = true`, Mitglied in allen Projekten damit RLS Zugriff gibt, aber aus Berechnungen herausgefiltert: kein Dienst, kein Anspruch, kein Kostenanteil). Kaufmann soll danach eine normale Familie sein. Das Konto ist **noch nicht angelegt** (der Nutzer wählt den Code selbst).

**Familienverwaltung** (Karte „Familien“ im Tab Hof, nur Verwalter): Aktionen `add`, `set_projects`, `reset_code`, `set_admin`, `remove`. Es wird **nie etwas gelöscht**: Entfernen = Mitgliedschaften löschen, `families.left_on` setzen, `is_admin=false`, Login sperren (`ban_duration 876000h`), Sitzungen beenden (`kill_sessions`). Man kann sich nicht selbst entfernen; es bleibt immer mindestens ein Verwalter; Admin-Konten behalten das Recht. Alle Familien dürfen alle Familiennamen lesen (Historie ohne „?“). Anmeldeliste kommt aus `login_families()` (öffentlich, nur aktive Familien); ohne Netz gilt die feste Liste in `CONFIG.families` (Bader dort mit `until`).

**Nachbar-Seite `/nachbarn`:** öffentlich, zeigt Überschuss minus offene Bestellungen, Preis pro Ei, Abholung bei (Familie mit Dienst), Hinweistext, Bestellformular (Felder **leer, ohne Vorschläge**). Schutz: Honeypot, max. 25 offene, max. 2 je Name, max. 10 in 10 Minuten. `egg_orders` ist für anon komplett gesperrt, nur `place_egg_order()` schreibt.

**Push:** (1) Bestell-Nachricht an alle Familien des Projekts mit eingetragenem Handy; (2) Erinnerungen um 18 Uhr: sonntags Dienst für die nächste Woche, Bargeld ab 7 Tagen (dann alle 3 Tage), PayPal-Eingang ab 3 Tagen (dann alle 3), am 1. des Monats Abgleich/Sicherung (älter als 28 Tage). Eine Nachricht je Familie, je Gerät abschaltbar (`push_subscriptions.reminders`). Links: `#bestellungen`, `#kasse:hens|goats`, `#dienst:hens|goats`, `#hof`. iPhone: nur iOS 16.4+ mit App auf dem Home-Bildschirm.

**Oberfläche/Stil**
- **Kein `confirm()` des Browsers**, immer das eigene Fenster `ask(text, {title, ok, cancel, tag, danger})` (async, `await`).
- Keine Platzhalter-Beispiele oder Vorgabewerte in Formularfeldern, die Vorschläge machen.
- Die **Anleitung im Tab Hof** wird bei jeder Funktion mitgepflegt. Ein Prüfskript vergleicht fett gesetzte Begriffe mit dem App-Text.
- Antworten an den Nutzer: kurz, deutsch, mit Umlauten, ehrlich zu ungetesteten Dingen, am Ende den offenen Punkt „Bader entfernen“ nennen.

## 4. Stand der Umsetzung

- **Datenbank und Edge Functions sind live** (alle Migrationen eingespielt, Zeitplan aktiv).
- **Die App-ZIP muss der Nutzer hochladen** (`rainaecker-hof-netlify.zip`, zuletzt gebaut nach dem Admin-Konto-Umbau). Ob er die neueste Version hochgeladen hat, ist **unbekannt**; ältere App-Versionen laufen gegen die neue Datenbank weiter (abwärtskompatibel getestet, nur ohne die neuen Funktionen).
- **Tests:** Edge-Function-Tests (Deno, in Abschnitt 11): 22 + 42 + 69 Prüfungen. Die App-Tests waren **ad hoc** (Node-`vm`-Harness mit simulierter Datenbank in `/tmp`, ca. 14 Läufe mit rund 370 Prüfungen) und sind **nicht** im Paket. Neu schreiben, wenn nötig: Funktionen aus dem `<script>` ziehen, `sb`, `document`, `navigator`, `fetch`, `ask`, `toast` simulieren.
- **Echte Handys:** Push-Zustellung, Erinnerungen, PayPal-Fenster und Familienverwaltung mit echtem Login sind **nicht auf Geräten erprobt**. Der erste Zeitplan-Lauf war am 20.10. noch nicht erfolgt (Auftrag um ~17:15 angelegt, erster Lauf 18:00).

## 5. Offene Punkte (Reihenfolge nach Dringlichkeit)

1. **Nutzer liefert Liste „Funktionen, auf die nur der Admin Zugriff haben soll“.** Dann in der App (`S.admin`, Knöpfe ausblenden) **und** per RLS/Funktion absichern (Kandidaten: `projects` update/Einstellungen, Tiere und Gesundheit löschen, Eingang bestätigen, Kassenabgleich, Sichern, Dienst tauschen). Offene Frage dazu: sieht das Admin-Konto den ganzen Tagesbetrieb oder nur die Verwaltung (aktuell: alles).
2. **Admin-Konto anlegen** (Nutzer, nach Upload der ZIP: Hof → Familien → Hinzufügen → „Admin-Konto statt Familie“), danach bei Kaufmann „Recht entziehen“.
3. **Bader entfernen am Montag 26.10.2026** (Karte „Familien“ → Bader → Aus dem Hof entfernen). Hühner-Dienstplan ist schon ohne Bader hinterlegt. Bis dahin rechnet die App mit 4 Familien (40 Eier Anspruch), danach 30. Offene Zahlungen von Bader vorher klären.
4. **Zeitplan beobachten:** `select * from cron.job_run_details` und `net._http_response`. Erste Dienst-Erinnerung Sonntag 25.10. 18 Uhr.
5. **Nutzer-Aufgaben im Supabase-Dashboard:** Selbstregistrierung ausschalten (Authentication → Sign In), optional Schutz gegen bekannte Passwörter (kann 6-stellige Codes ablehnen).
6. Test mit Test-Familie (hinzufügen, anmelden, entfernen).
7. Nicht gebaut (bewusst): Startseite „Heute“, Eier ohne Netz zählen, automatischer PayPal-Abgleich (CSV/Schnittstelle). `pg_net` im Schema `public` (Lint-Hinweis): `ALTER EXTENSION SET SCHEMA` geht nicht, Neuanlegen würde Push/Zeitplan unterbrechen, daher gelassen.
8. Vor Ende 2027: Dienstpläne verlängern (Tab Dienst → „Plan füllen“).
9. Netlify-Credits beachten (Uploads bündeln).

## 6. Arbeitsweise (so wurde bisher gearbeitet)

1. Vor jeder Änderung Kopie der App nach `/tmp/huehner-hof.before-*.html`.
2. Änderungen per Python-Skript mit `assert s.count(old) == 1`, danach `node --check` auf das extrahierte `<script>` (zweites Script-Tag; das erste ist der QR-Generator) und Test auf doppelte Funktionsnamen.
3. Tests schreiben und laufen lassen, **auch die früheren Suiten erneut**. Fehler zuerst im Test suchen, aber echte Fehler beheben (so wurden z. B. „Eingangänge“, der Übertrag und ein Plural gefunden).
4. Datenbank: Migrationen mit `apply_migration`, Tests in `begin; … rollback;` (Rechte simulieren mit `select set_config('request.jwt.claims', …, true)` **vor** `set local role authenticated`). `execute_sql` zeigt nur das Ergebnis des **letzten** Statements. `pg_net`-Antworten kommen asynchron in `net._http_response`.
5. Edge Functions mit `deploy_edge_function` (immer alle Dateien mit vollem Inhalt) und danach live prüfen (401 ohne Anmeldung).
6. Paket bauen: `deploy/` → `/mnt/user-data/outputs/rainaecker-hof-netlify.zip`, Projekt-Paket `rainaecker-hof-projekt.zip` (mit Funktionen, Tests, SQL, `CLAUDE.md`). **Prüfen, dass der private Push-Schlüssel nicht in den ZIPs steht.** Nur die Deploy-ZIP per `present_files` zeigen.
7. Das ausführliche Protokoll der ganzen Sitzung liegt (falls zugänglich) unter `/mnt/transcripts/2026-10-20-10-26-33-rainaecker-hof-app.txt`.

## 7. Dateiübersicht der Anhänge

- Abschnitt 8: Datenbank (Tabellen, Zugriffsregeln, Funktionen, Auslöser, Zeitplan) und Abfragen zum Neu-Auslesen.
- Abschnitt 9: Web-App: `huehner-hof.html` (= `index.html`), `nachbarn.html`, `sw.js`, `manifest.webmanifest`, `_headers`, `_redirects`.
- Abschnitt 10: Edge Functions `notify-order` (`index.ts`, `handler.ts`, `reminders.ts`) und `manage-family` (`index.ts`, `family.ts`).
- Abschnitt 11: Deno-Tests der Edge Functions.
- Abschnitt 12: SQL-Migrationen vom 20.10.2026 und `tools/make_assets.py`.
- Abschnitt 13: `CLAUDE.md` (laufend gepflegte Projektnotizen mit weiteren Einzelheiten).

## 8. Datenbank (Stand 20.10.2026, aus der laufenden Datenbank ausgelesen)

### 8.1 Tabellen (Schema `public`, RLS überall an)

```
animals           id, project_id, name, born, due, note, created_at, photo_path
audit_log         id bigint, changed_at, project_id, table_name, action, record_id text, old_data jsonb, new_data jsonb, changed_by, family_name
calendar_events   id, project_id, date, end_date, title, kind='Sonstiges', family_id, note, created_by=auth.uid(), created_at
cash_checks       id, project_id, created_at, created_by=auth.uid(), paypal_balance, expected, open_cash=0, note
door_times        id, project_id, changed_on, opens_at time, closes_at time, family_id, note, created_at
duty_checks       project_id, date, key, done=true
duty_swaps        project_id, week_start date, family_id          (PK project_id+week_start)
egg_log           id, project_id, date, type, n int, family_id, buyer, price, tx_id, auto=false, created_by=auth.uid(), created_at
                  type: laid | take | sale | zusatz | verzicht
egg_orders        id, project_id, created_at, buyer, qty, status='offen', handled_at, handled_by      (status: offen|erledigt|abgelehnt)
families          id, name, user_id (unique, -> auth.users), created_at, is_admin=false, left_on date (null=aktiv), is_system=false (Admin-Konto)
health_entries    id, project_id, type, animal='Alle', date, next_due, note, family_id, done=false, created_at
project_members   project_id, family_id
projects          id, kind ('hens'|'goats'), name, settings jsonb, created_at
push_config       key, value                                       (nur Service-Rolle; Werte geheim)
push_subscriptions id, user_id=auth.uid(), endpoint, p256dh, auth, user_agent, created_at, reminders=true   (unique user_id+endpoint)
supplies          id, project_id, name, days, set_on
transactions      id, project_id, date, kind, amount, description, family_id, created_by=auth.uid(), created_at,
                  seller_id, pay_method ('bar'|'paypal'), pay_state ('bar_offen'|'pruefen'|'bestaetigt'), parent_id (Trinkgeld -> Verkauf, on delete cascade), confirmed_at, confirmed_by
                  kind: ausgabe | einnahme | einzahlung | auszahlung      (family_id null = Gemeinschaftskasse)
```

`projects.settings` (Hühner): `hens`, `quota` (10), `price_extern` (0.40), `price_intern` (0.20), `start_date`, `live_start` (2026-10-12), `paypal_me`, `hens_history` (`[{from:'2026-07-27',n:10},{from:'2026-10-10',n:9}]`), `neighbor_note`, `last_backup`.

Storage: Bucket `tierfotos` (privat), Pfad `<project_id>/…`.

### 8.2 Hilfsfunktionen (Quelltext)

```sql
-- Zugriffsprüfungen (security definer, search_path = '')
create or replace function app.is_member(p uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.project_members pm join public.families f on f.id = pm.family_id
                 where pm.project_id = p and f.user_id = (select auth.uid())) $$;
create or replace function app.is_admin() returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select f.is_admin from public.families f where f.user_id = (select auth.uid())), false) $$;
create or replace function app.is_family() returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.families f where f.user_id = (select auth.uid())) $$;
create or replace function app.shares_project_with(fam uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.project_members a join public.project_members b on a.project_id = b.project_id
                 join public.families me on me.id = b.family_id where a.family_id = fam and me.user_id = (select auth.uid())) $$;

-- Anmeldeliste (öffentlich) und Sitzungen beenden (nur service_role)
create or replace function public.login_families() returns table(name text, email text) language sql stable security definer set search_path = '' as $$
  select f.name, u.email::text from public.families f join auth.users u on u.id = f.user_id
  where f.left_on is null or f.left_on > current_date order by f.name $$;
-- grant execute on public.login_families() to anon, authenticated;
create or replace function public.kill_sessions(uid uuid) returns void language sql security definer set search_path = '' as $$
  delete from auth.sessions where user_id = uid $$;
-- revoke from public, anon, authenticated; grant execute to service_role;
```

```sql
-- Verkaufsbestand (Überschuss) mit Übertrag; Admin-Konten (is_system) haben keinen Wochenanspruch
create or replace function app.hens_surplus(hens uuid) returns int language plpgsql stable security definer set search_path = '' as $$
declare
  q int; live date;
  wk date := date_trunc('week', (now() at time zone 'Europe/Berlin'))::date;
  carry int; l int; t int; v int; reserved int; total int; old_rem int; new_rem int;
begin
  select coalesce((settings->>'quota')::int, 10), nullif(settings->>'live_start', '')::date into q, live from public.projects where id = hens;
  select greatest(0, coalesce(sum(case type when 'laid' then n when 'verzicht' then 0 else -n end), 0)) into carry
    from public.egg_log where project_id = hens and (live is null or date >= live) and date < wk;
  select coalesce(sum(n) filter (where type = 'laid'), 0), coalesce(sum(n) filter (where type = 'take'), 0),
         coalesce(sum(n) filter (where type in ('sale', 'zusatz')), 0)
    into l, t, v from public.egg_log where project_id = hens and (live is null or date >= live) and date >= wk and date < wk + 7;
  select coalesce(sum(greatest(0, greatest(0, q - coalesce(w.waived, 0)) - coalesce(tk.taken, 0))), 0) into reserved
    from public.project_members pm
    join public.families fx on fx.id = pm.family_id and not fx.is_system
    left join (select family_id, sum(n) as taken from public.egg_log where project_id = hens and type = 'take' and date >= wk and date < wk + 7 group by family_id) tk on tk.family_id = pm.family_id
    left join (select family_id, sum(n) as waived from public.egg_log where project_id = hens and type = 'verzicht' and date >= wk and date < wk + 7 group by family_id) w on w.family_id = pm.family_id
    where pm.project_id = hens;
  total := greatest(0, carry + l - t - v); old_rem := greatest(0, carry - v); new_rem := l - t - greatest(0, v - carry);
  return greatest(0, least(total, old_rem + greatest(0, new_rem - reserved)));
end $$;
revoke all on function app.hens_surplus(uuid) from public, anon, authenticated;
```

```sql
-- Änderungsprotokoll (Auslöser AFTER UPDATE/DELETE auf egg_log, transactions, duty_swaps, door_times, animals, health_entries, supplies, calendar_events, projects, egg_orders, cash_checks)
CREATE OR REPLACE FUNCTION app.log_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
declare
  o jsonb := to_jsonb(old);
  n jsonb := case when tg_op = 'UPDATE' then to_jsonb(new) else null end;
  pid uuid; fname text;
begin
  -- Das laufende Zählen der heutigen Eier (+1/-1 auf dem Tages-Eintrag) wird nicht protokolliert
  if tg_table_name = 'egg_log'
     and coalesce((o->>'auto')::boolean, false)
     and (o->>'date')::date >= current_date
     and (tg_op = 'DELETE' or (n->>'date' = o->>'date' and n->>'type' = o->>'type')) then
    return null;
  end if;
  pid := case when tg_table_name = 'projects' then (o->>'id')::uuid else (o->>'project_id')::uuid end;
  select f.name into fname from public.families f where f.user_id = (select auth.uid());
  insert into public.audit_log (project_id, table_name, action, record_id, old_data, new_data, changed_by, family_name)
  values (pid, tg_table_name, tg_op, o->>'id', o, n, (select auth.uid()), fname);
  return null;
end $function$;

-- Push bei neuer Bestellung (Auslöser notify_order_insert AFTER INSERT auf egg_orders)
CREATE OR REPLACE FUNCTION app.notify_order() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
declare v_url text; v_secret text;
begin
  select value into v_url from public.push_config where key = 'function_url';
  select value into v_secret from public.push_config where key = 'hook_secret';
  if v_url is null or v_secret is null then return new; end if;
  perform net.http_post(url := v_url, body := jsonb_build_object('order_id', new.id),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', v_secret), timeout_milliseconds := 8000);
  return new;
exception when others then
  return new;   -- eine Bestellung darf nie an der Benachrichtigung scheitern
end $function$;
```

```sql
-- Öffentliche Nachbar-Seite (anon darf nur diese beiden Funktionen ausführen)
CREATE OR REPLACE FUNCTION public.neighbor_info() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $function$
declare
  hens uuid; price numeric; note text;
  wk date := date_trunc('week', (now() at time zone 'Europe/Berlin'))::date;
  surplus int; open_qty int; duty text;
begin
  select id, (settings->>'price_extern')::numeric, nullif(trim(settings->>'neighbor_note'), '')
    into hens, price, note from public.projects where kind = 'hens' order by created_at limit 1;
  if hens is null then
    return jsonb_build_object('available', 0, 'ordered', 0, 'price', null, 'duty', null, 'note', null, 'updated', now());
  end if;
  surplus := app.hens_surplus(hens);
  select coalesce(sum(qty), 0) into open_qty from public.egg_orders where project_id = hens and status = 'offen';
  select f.name into duty from public.duty_swaps d join public.families f on f.id = d.family_id where d.project_id = hens and d.week_start = wk;
  return jsonb_build_object('available', greatest(0, surplus - open_qty), 'ordered', open_qty, 'price', price, 'duty', duty, 'note', note, 'updated', now());
end $function$;

CREATE OR REPLACE FUNCTION public.place_egg_order(p_buyer text, p_qty integer, p_hp text DEFAULT ''::text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
declare
  hens uuid; v_buyer text := regexp_replace(trim(coalesce(p_buyer, '')), '\s+', ' ', 'g');
  v_free int; v_open_qty int; v_open_cnt int; v_same_cnt int; v_recent int;
begin
  if coalesce(p_hp, '') <> '' then return jsonb_build_object('ok', true, 'message', 'Danke!', 'available', 0); end if;   -- Honeypot: Bot
  if char_length(v_buyer) < 2 or char_length(v_buyer) > 80 then return jsonb_build_object('ok', false, 'message', 'Bitte gib deine Familie an (mindestens 2 Zeichen).'); end if;
  if p_qty is null or p_qty < 1 or p_qty > 100 then return jsonb_build_object('ok', false, 'message', 'Bitte gib eine Stückzahl zwischen 1 und 100 an.'); end if;
  select id into hens from public.projects where kind = 'hens' order by created_at limit 1;
  if hens is null then return jsonb_build_object('ok', false, 'message', 'Bestellungen sind gerade nicht möglich.'); end if;
  perform pg_advisory_xact_lock(hashtext('egg_orders'));
  select count(*) filter (where status = 'offen'), coalesce(sum(qty) filter (where status = 'offen'), 0),
         count(*) filter (where status = 'offen' and lower(buyer) = lower(v_buyer)),
         count(*) filter (where created_at > now() - interval '10 minutes')
    into v_open_cnt, v_open_qty, v_same_cnt, v_recent from public.egg_orders where project_id = hens;
  if v_recent >= 10 then return jsonb_build_object('ok', false, 'message', 'Gerade gehen sehr viele Bestellungen ein. Bitte versuche es in ein paar Minuten noch einmal.'); end if;
  if v_open_cnt >= 25 then return jsonb_build_object('ok', false, 'message', 'Zurzeit sind keine weiteren Bestellungen möglich.'); end if;
  if v_same_cnt >= 2 then return jsonb_build_object('ok', false, 'message', 'Von dir sind schon Bestellungen offen. Bitte melde dich direkt bei der Familie.'); end if;
  v_free := greatest(0, app.hens_surplus(hens) - v_open_qty);
  if v_free < 1 then return jsonb_build_object('ok', false, 'message', 'Gerade sind keine Eier frei. Schau später noch einmal vorbei.', 'available', 0); end if;
  if p_qty > v_free then return jsonb_build_object('ok', false, 'message', format('Es sind nur noch %s Eier frei.', v_free), 'available', v_free); end if;
  insert into public.egg_orders (project_id, buyer, qty) values (hens, v_buyer, p_qty);
  return jsonb_build_object('ok', true, 'message', 'Danke! Deine Bestellung ist eingegangen.', 'available', v_free - p_qty);
end $function$;
```

Zeitplan: `select cron.schedule('hof-erinnerungen', '0 * * * *', $$ select net.http_post(url := (select value from public.push_config where key='function_url'), headers := jsonb_build_object('Content-Type','application/json','x-hook-secret',(select value from public.push_config where key='hook_secret')), body := '{"reminders": true}'::jsonb) $$);`

Berechtigungen: `anon` darf nur `public.neighbor_info()`, `public.place_egg_order(...)` und `public.login_families()` ausführen; `egg_orders`, `cash_checks`, `push_subscriptions`, `push_config`, `audit_log` sind für anon ohne Tabellenrecht. `public.kill_sessions` nur `service_role`. Alle anderen Tabellen liefern anon wegen RLS 0 Zeilen.

### 8.3 Zugriffsregeln (RLS), vollständig

```sql
create policy "Mitglieder erstellen" on public.animals for insert to authenticated with check (app.is_member(project_id));
create policy "Mitglieder lesen" on public.animals for select to authenticated using (app.is_member(project_id));
create policy "Mitglieder löschen" on public.animals for delete to authenticated using (app.is_member(project_id));
create policy "Mitglieder ändern" on public.animals for update to authenticated using (app.is_member(project_id)) with check (app.is_member(project_id));
create policy "Mitglieder lesen Protokoll" on public.audit_log for select to authenticated using (app.is_member(project_id));
create policy "Mitglieder erstellen" on public.calendar_events for insert to authenticated with check ((app.is_member(project_id) AND (created_by = (SELECT auth.uid()))));
create policy "Mitglieder lesen" on public.calendar_events for select to authenticated using (app.is_member(project_id));
create policy "eigene oder Admin löschen" on public.calendar_events for delete to authenticated using ((app.is_member(project_id) AND ((created_by = (SELECT auth.uid())) OR app.is_admin())));
create policy "eigene oder Admin ändern" on public.calendar_events for update to authenticated using ((app.is_member(project_id) AND ((created_by = (SELECT auth.uid())) OR app.is_admin()))) with check ((app.is_member(project_id) AND ((created_by = (SELECT auth.uid())) OR app.is_admin())));
create policy "Mitglieder erstellen Abgleiche" on public.cash_checks for insert to authenticated with check ((app.is_member(project_id) AND (created_by = (SELECT auth.uid()))));
create policy "Mitglieder lesen Abgleiche" on public.cash_checks for select to authenticated using (app.is_member(project_id));
create policy "Mitglieder löschen Abgleiche" on public.cash_checks for delete to authenticated using (app.is_member(project_id));
-- door_times, duty_checks, health_entries, supplies: je 4 Regeln (erstellen/lesen/löschen/ändern) nur mit app.is_member(project_id), wie bei animals
create policy "Mitglieder erstellen" on public.duty_swaps for insert to authenticated with check ((app.is_member(project_id) AND (app.is_admin() OR (week_start >= (CURRENT_DATE - 14)))));
create policy "Mitglieder lesen" on public.duty_swaps for select to authenticated using (app.is_member(project_id));
create policy "Mitglieder löschen" on public.duty_swaps for delete to authenticated using ((app.is_member(project_id) AND (app.is_admin() OR (week_start >= (CURRENT_DATE - 14)))));
create policy "Mitglieder ändern" on public.duty_swaps for update to authenticated using ((app.is_member(project_id) AND (app.is_admin() OR (week_start >= (CURRENT_DATE - 14))))) with check ((app.is_member(project_id) AND (app.is_admin() OR (week_start >= (CURRENT_DATE - 14)))));
create policy "Mitglieder erstellen" on public.egg_log for insert to authenticated with check ((app.is_member(project_id) AND (app.is_admin() OR (date >= (CURRENT_DATE - 14)))));
create policy "Mitglieder lesen" on public.egg_log for select to authenticated using (app.is_member(project_id));
create policy "Mitglieder löschen" on public.egg_log for delete to authenticated using ((app.is_member(project_id) AND (app.is_admin() OR (date >= (CURRENT_DATE - 14)))));
create policy "Mitglieder ändern" on public.egg_log for update to authenticated using ((app.is_member(project_id) AND (app.is_admin() OR (date >= (CURRENT_DATE - 14))))) with check ((app.is_member(project_id) AND (app.is_admin() OR (date >= (CURRENT_DATE - 14)))));
-- transactions: dieselben vier Regeln wie egg_log (14-Tage-Fenster, Admin unbegrenzt)
create policy "Mitglieder bearbeiten Bestellungen" on public.egg_orders for update to authenticated using (app.is_member(project_id)) with check (app.is_member(project_id));
create policy "Mitglieder lesen Bestellungen" on public.egg_orders for select to authenticated using (app.is_member(project_id));
create policy "Mitglieder löschen Bestellungen" on public.egg_orders for delete to authenticated using (app.is_member(project_id));
create policy "Familien lesen" on public.families for select to authenticated using (app.is_family());
create policy "Mitglieder lesen Mitgliederliste" on public.project_members for select to authenticated using (app.is_member(project_id));
create policy "Mitglieder lesen Projekt" on public.projects for select to authenticated using (app.is_member(id));
create policy "Mitglieder ändern Projekt" on public.projects for update to authenticated using (app.is_member(id)) with check (app.is_member(id));
create policy "eigene Anmeldungen anlegen" on public.push_subscriptions for insert to authenticated with check ((user_id = (SELECT auth.uid())));
create policy "eigene Anmeldungen lesen" on public.push_subscriptions for select to authenticated using ((user_id = (SELECT auth.uid())));
create policy "eigene Anmeldungen löschen" on public.push_subscriptions for delete to authenticated using ((user_id = (SELECT auth.uid())));
create policy "eigene Anmeldungen ändern" on public.push_subscriptions for update to authenticated using ((user_id = (SELECT auth.uid()))) with check ((user_id = (SELECT auth.uid())));
-- Speicher (storage.objects, Bucket tierfotos): lesen/hochladen/ersetzen/löschen nur wenn app.is_member((storage.foldername(name))[1]::uuid)
```

Es gibt **keine** Schreibregeln für `families`, `project_members`, `push_config` und für `audit_log` (außer dem Auslöser): geschrieben wird nur über Edge Functions/Service-Rolle bzw. Auslöser. `egg_orders` wird für anon nur über `place_egg_order()` angelegt.

### 8.4 So liest du den aktuellen Stand neu aus

```sql
-- Tabellen und Spalten
select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema='public' order by table_name, ordinal_position;
-- Regeln vollständig
select c.relname, p.polname, p.polcmd, pg_get_expr(p.polqual, p.polrelid) as using_, pg_get_expr(p.polwithcheck, p.polrelid) as check_ from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname='public';
-- Funktionen
select n.nspname, p.proname, pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('app','public') and p.prokind = 'f';
-- Zeitplan und letzte Läufe
select * from cron.job; select * from cron.job_run_details order by start_time desc limit 10;
-- Antworten der Funktionsaufrufe (asynchron)
select id, status_code, left(content, 200), created from net._http_response order by id desc limit 10;
```
