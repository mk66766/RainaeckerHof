// Push zu Nachbar-Bestellungen (19.11.2026): Texte und „wann ist die nächste Erinnerung fällig?“.
// Reine Berechnung ohne Datenbankzugriff, damit sie sich mit Testdaten prüfen lässt.
// Regel: Die Familie mit Dienst wird alle 2 Stunden erinnert, solange eine bereite Bestellung offen ist,
// nur zwischen 8 und 20 Uhr Berliner Zeit (Nachtruhe). Die anderen Familien bekommen nur einmal „Neue Bestellung“.
import { berlinNow } from "./reminders.ts";

export const REMIND_EVERY_MIN = 120;
export const QUIET = { until: 8, from: 20 };          // Nachtruhe: ab 20 Uhr bis 8 Uhr
const SLACK_MIN = 5;                                    // der Zeitplan läuft alle 10 Minuten, damit es nicht jedes Mal 10 Minuten später wird

// Zeile aus open_orders_push(): egg_orders-Spalten plus ready, pos, duty_user
export type OpenOrder = {
  id: string; project_id: string; buyer: string; qty: number; status: string; created_at: string;
  waited?: boolean | null; ready_notified_at?: string | null; reminded_at?: string | null; need_by?: string | null;
  ready: boolean; pos?: number | null; duty_user?: string | null;
};
export type Msg = { title: string; body: string; tag: string };

export const eggs = (n: number) => `${n} ${n === 1 ? "Ei" : "Eier"}`;

// Frist: „Sa., 21.11., 18:00 Uhr“ in Berliner Zeit (ohne Uhrzeit, wenn nur ein Datum gespeichert ist)
export function deadlineText(v: string | null | undefined): string {
  if (!v) return "";
  const dateOnly = /^\d{4}-\d\d-\d\d$/.test(v);
  const d = new Date(dateOnly ? v + "T12:00:00Z" : v);
  if (isNaN(d.getTime())) return "";
  const p = Object.fromEntries(new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
  const wd = String(p.weekday).replace(/\.$/, "") + ".";
  return `${wd}, ${p.day}.${p.month}.` + (dateOnly ? "" : `, ${p.hour}:${p.minute} Uhr`);
}

// an die Familie mit Dienst (bei neuer Bestellung und als Erinnerung)
export function dutyMsg(o: OpenOrder): Msg {
  const by = deadlineText(o.need_by);
  return { title: `Offene Bestellung: ${o.buyer}`, body: `${eggs(o.qty)}${by ? `, benötigt bis ${by}` : ""}. Bitte bearbeiten.`, tag: `bestellung-${o.id}` };
}
// an die Familie mit Dienst, wenn gerade nicht genug Eier frei sind (Warteliste)
export function dutyWaitMsg(o: OpenOrder): Msg {
  return { title: `Bestellung wartet: ${o.buyer}`, body: `${eggs(o.qty)}, gerade ist nicht genug frei. Sobald es reicht, kommt eine Nachricht.`, tag: `bestellung-${o.id}` };
}
// einmal an alle anderen Familien
export function infoMsg(o: { id: string; buyer: string; qty: number }): Msg {
  return { title: "Neue Bestellung", body: `Neue Bestellung von ${o.buyer} – ${eggs(o.qty)}. Die diensthabende Familie kümmert sich.`, tag: `bestellung-${o.id}` };
}

export const quiet = (now: Date) => { const h = berlinNow(now).hour; return h < QUIET.until || h >= QUIET.from; };

// zuletzt an die Familie mit Dienst gemeldet: bei Eingang, als „kann raus“ oder als Erinnerung
export function lastPush(o: OpenOrder): number {
  return Math.max(...[o.created_at, o.ready_notified_at, o.reminded_at].filter(Boolean).map((t) => Date.parse(String(t))));
}

// Bestellungen, für die jetzt eine Erinnerung fällig ist: offen, bereit, nicht verfallen, seit 2 Stunden nichts gemeldet, keine Nachtruhe
export function dueOrders(rows: OpenOrder[], now: Date): OpenOrder[] {
  if (quiet(now)) return [];
  const t = now.getTime();
  return rows.filter((o) => o.status === "offen" && o.ready
    && t - Date.parse(o.created_at) < 7 * 864e5
    && t - lastPush(o) >= (REMIND_EVERY_MIN - SLACK_MIN) * 60000);
}
