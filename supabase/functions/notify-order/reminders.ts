// Erinnerungen für den Rainäcker Hof (täglich um 18 Uhr, ausgelöst per Zeitplan in der Datenbank).
// Reine Berechnung ohne Datenbankzugriff, damit sie sich mit Testdaten prüfen lässt.
export type Project = { id: string; kind: string; name: string; settings?: Record<string, any> | null };
export type Data = {
  projects: Project[];
  members: { project_id: string; family_id: string }[];
  families: { id: string; name: string; user_id: string | null }[];
  swaps: { project_id: string; week_start: string; family_id: string }[];
  tx: { id: string; project_id: string; date: string; amount: number | string; pay_state: string | null; seller_id: string | null; parent_id: string | null }[];
  checks: { project_id: string; created_at: string }[];
};
export type Now = { date: string; weekday: number; day: number };       // Berlin: Datum JJJJ-MM-TT, Wochentag 0=Sonntag, Tag im Monat
export type Item = { userId: string; title: string; text: string; url: string; prio: number };

export const eur = (n: number) => n.toFixed(2).replace(".", ",") + " €";
const dayNum = (d: string) => Math.floor(Date.parse(d.slice(0, 10) + "T12:00:00Z") / 864e5);
export const ageDays = (from: string, to: string) => dayNum(to) - dayNum(from);
const addDays = (d: string, n: number) => new Date((dayNum(d) + n) * 864e5).toISOString().slice(0, 10);
const label = (p: Project) => (p.kind === "goats" ? "Ziegen" : "Hühner");

export function buildReminders(d: Data, now: Now): Item[] {
  const items: Item[] = [];
  const uidOf = (famId: string | null) => d.families.find((f) => f.id === famId)?.user_id || null;
  const membersOf = (pid: string) => d.members.filter((m) => m.project_id === pid).map((m) => uidOf(m.family_id)).filter(Boolean) as string[];
  const total = (t: Data["tx"][number]) => Number(t.amount) + d.tx.filter((x) => x.parent_id === t.id).reduce((s, x) => s + Number(x.amount), 0);
  const kindOf = (pid: string) => d.projects.find((p) => p.id === pid)?.kind || "hens";

  // 1) Dienst: sonntags für die nächste Woche
  if (now.weekday === 0) {
    const nextMon = addDays(now.date, 1);
    for (const p of d.projects) {
      const sw = d.swaps.find((s) => s.project_id === p.id && s.week_start === nextMon);
      const uid = sw && uidOf(sw.family_id);
      if (uid) items.push({ userId: uid, title: "Nächste Woche hast du Dienst", text: `${label(p)}: Ab morgen bist du dran.`, url: `#dienst:${p.kind}`, prio: 2 });
    }
  }

  // 2) Bargeld noch nicht eingezahlt: ab 7 Tagen, dann alle 3 Tage
  const cash = d.tx.filter((t) => !t.parent_id && t.pay_state === "bar_offen");
  const byFam = new Map<string, typeof cash>();
  for (const t of cash) if (t.seller_id) byFam.set(t.seller_id, [...(byFam.get(t.seller_id) || []), t]);
  for (const [fid, list] of byFam) {
    const late = list.filter((t) => ageDays(t.date, now.date) >= 7);
    if (!late.some((t) => (ageDays(t.date, now.date) - 7) % 3 === 0)) continue;
    const uid = uidOf(fid);
    if (!uid) continue;
    const oldest = Math.max(...late.map((t) => ageDays(t.date, now.date)));
    items.push({ userId: uid, title: "Bargeld noch einzahlen", text: `Du hast noch ${eur(late.reduce((s, t) => s + total(t), 0))} Bargeld aus Eierverkäufen einzuzahlen (seit ${oldest} Tagen).`, url: `#kasse:${kindOf(late[0].project_id)}`, prio: 1 });
  }

  // 3) PayPal-Eingang noch nicht bestätigt: ab 3 Tagen, dann alle 3 Tage, an alle Familien des Projekts
  for (const p of d.projects) {
    const pend = d.tx.filter((t) => t.project_id === p.id && !t.parent_id && t.pay_state === "pruefen" && ageDays(t.date, now.date) >= 3);
    if (!pend.some((t) => (ageDays(t.date, now.date) - 3) % 3 === 0)) continue;
    const text = `${pend.length === 1 ? "1 PayPal-Eingang" : pend.length + " PayPal-Eingänge"} (${eur(pend.reduce((s, t) => s + total(t), 0))}) ${pend.length === 1 ? "ist" : "sind"} noch nicht bestätigt${d.projects.length > 1 ? ` (${label(p)})` : ""}.`;
    for (const uid of membersOf(p.id)) items.push({ userId: uid, title: "Zahlung prüfen", text, url: `#kasse:${p.kind}`, prio: 1 });
  }

  // 4) Monatsabschluss: am 1. des Monats, wenn Abgleich oder Sicherung länger als 28 Tage her sind
  if (now.day === 1) {
    for (const p of d.projects) {
      const lines: string[] = [];
      const last = d.checks.filter((c) => c.project_id === p.id).map((c) => c.created_at.slice(0, 10)).sort().pop();
      if (!last || ageDays(last, now.date) > 28) lines.push(`Kassenabgleich (${label(p)}): Zeit für den monatlichen Abgleich.`);
      const bk = p.settings?.last_backup as string | undefined;
      if (!bk || ageDays(bk, now.date) > 28) lines.push(`Sicherung (${label(p)}): Zeit, die Daten zu sichern (Tab Hof).`);
      for (const uid of membersOf(p.id)) for (const text of lines) items.push({ userId: uid, title: "Monatsabschluss", text, url: `#kasse:${p.kind}`, prio: 3 });
    }
  }
  return items;
}

// Pro Familie genau eine Nachricht: bei mehreren Erinnerungen werden die Texte zusammengefasst.
export function mergePerUser(items: Item[]): { userId: string; title: string; body: string; url: string }[] {
  const by = new Map<string, Item[]>();
  for (const it of items) by.set(it.userId, [...(by.get(it.userId) || []), it]);
  return [...by].map(([userId, list]) => {
    list.sort((a, b) => a.prio - b.prio);
    const texts = [...new Set(list.map((i) => i.text))];
    return { userId, title: texts.length === 1 ? list[0].title : "Erinnerungen vom Hof", body: texts.join("\n"), url: list[0].url };
  });
}

// aktuelle Berliner Zeit (Datum, Wochentag, Tag, Stunde)
export function berlinNow(d = new Date()): Now & { hour: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(d).map((p) => [p.type, p.value]));
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(String(parts.weekday));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday: wd, day: Number(parts.day), hour: Number(parts.hour) };
}
