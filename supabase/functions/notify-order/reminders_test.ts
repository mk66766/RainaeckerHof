import { ageDays, berlinNow, buildReminders, mergePerUser, type Data } from "./reminders.ts";
import { makeHandler } from "./handler.ts";

let gut = 0, n = 0;
const eq = (a: any, b: any, msg: string) => { n++; if (JSON.stringify(a) !== JSON.stringify(b)) { console.log("FEHLER:", msg, "| erwartet", JSON.stringify(b), "| war", JSON.stringify(a)); Deno.exit(1); } gut++; console.log("OK  ", msg); };

const base = (over: Partial<Data> = {}): Data => ({
  projects: [{ id: "h", kind: "hens", name: "Hühner", settings: { last_backup: "2026-10-25" } }, { id: "g", kind: "goats", name: "Ziegen", settings: {} }],
  members: [{ project_id: "h", family_id: "A" }, { project_id: "h", family_id: "B" }, { project_id: "h", family_id: "C" }, { project_id: "g", family_id: "B" }, { project_id: "g", family_id: "C" }],
  families: [{ id: "A", name: "Bader", user_id: "uA" }, { id: "B", name: "Hatesaul", user_id: "uB" }, { id: "C", name: "Kaufmann", user_id: "uC", is_admin: true }],
  swaps: [{ project_id: "h", week_start: "2026-10-26", family_id: "B" }, { project_id: "g", week_start: "2026-10-26", family_id: "C" }],
  tx: [], checks: [], ...over,
});
const sun = { date: "2026-10-25", weekday: 0, day: 25 }, tue = { date: "2026-10-20", weekday: 2, day: 20 };
const minus = (d: string, k: number) => new Date(Date.parse(d + "T12:00:00Z") - k * 864e5).toISOString().slice(0, 10);

// --- Hilfsfunktionen
eq(ageDays("2026-10-12", "2026-10-20"), 8, "Tage zwischen zwei Daten");
eq(berlinNow(new Date("2026-07-12T16:10:00Z")), { date: "2026-07-12", weekday: 0, day: 12, hour: 18 }, "Sommerzeit: 16:10 UTC ist 18:10 Berlin, Sonntag");
eq(berlinNow(new Date("2026-10-25T17:30:00Z")).hour, 18, "Winterzeit (ab 25.10.): 17:30 UTC ist 18:30 Berlin");
eq(berlinNow(new Date("2026-10-25T16:30:00Z")).hour, 17, "Winterzeit: 16:30 UTC ist 17:30 Berlin");

// --- Dienst
let it = buildReminders(base(), sun);
eq(it.map((i) => i.userId + ":" + i.text + ":" + i.url).sort(), ["uB:Hühner: Ab morgen bist du dran.:#dienst:hens", "uC:Ziegen: Ab morgen bist du dran.:#dienst:goats"], "Sonntag: nächste Woche hat Hatesaul (Hühner) und Kaufmann (Ziegen) Dienst");
eq(buildReminders(base(), tue).length, 0, "an einem Dienstag keine Dienst-Erinnerung");
eq(buildReminders(base({ swaps: [] }), sun).length, 0, "ohne eingetragenen Dienstplan keine Nachricht");
eq(buildReminders(base({ families: [{ id: "B", name: "Hatesaul", user_id: null }, { id: "C", name: "K", user_id: "uC" }] }), sun).map((i) => i.userId), ["uC"], "Familie ohne Login wird übersprungen");

// --- Bargeld offen: ab 7 Tagen, dann alle 3 Tage
const cash = (age: number, extra = {}) => ({ id: "t" + age, project_id: "h", date: minus("2026-10-20", age), amount: 4, pay_state: "bar_offen", seller_id: "A", parent_id: null, ...extra });
const kid = (pid: string, amt: number) => ({ id: "k" + pid, project_id: "h", date: "2026-10-01", amount: amt, pay_state: null, seller_id: null, parent_id: pid });
eq(buildReminders(base({ tx: [cash(6)] }), tue).length, 0, "Bargeld seit 6 Tagen: noch keine Erinnerung");
it = buildReminders(base({ tx: [cash(7)] }), tue);
eq(it.map((i) => i.userId + "|" + i.title + "|" + i.text + "|" + i.url), ["uA|Bargeld noch einzahlen|Du hast noch 4,00 € Bargeld aus Eierverkäufen einzuzahlen (seit 7 Tagen).|#kasse:hens"], "Bargeld seit 7 Tagen: Erinnerung an Bader");
eq(buildReminders(base({ tx: [cash(8)] }), tue).length, 0, "Tag 8: Pause");
eq(buildReminders(base({ tx: [cash(10)] }), tue).length, 1, "Tag 10: wieder erinnern (alle 3 Tage)");
eq(buildReminders(base({ tx: [cash(7), cash(5, { id: "tx5" })] }), tue)[0].text.includes("4,00 €"), true, "nur Buchungen ab 7 Tagen zählen (4,00 €, nicht 8,00 €)");
eq(buildReminders(base({ tx: [cash(7), kid("t7", 1)] }), tue)[0].text.includes("5,00 €"), true, "Trinkgeld wird zum Bargeld gezählt (5,00 €)");
eq(buildReminders(base({ tx: [cash(7), cash(10, { id: "tz", seller_id: "B" })] }), tue).map((i) => i.userId).sort(), ["uA", "uB"], "jede Familie bekommt nur ihr eigenes Bargeld genannt");

// --- PayPal-Eingang prüfen: ab 3 Tagen, nur an den Admin (nur er hat Zugriff auf das PayPal-Konto)
const chk = (age: number, id = "p" + age) => ({ id, project_id: "h", date: minus("2026-10-20", age), amount: 4, pay_state: "pruefen", seller_id: "B", parent_id: null });
eq(buildReminders(base({ tx: [chk(2)] }), tue).length, 0, "Eingang seit 2 Tagen: noch nichts");
it = buildReminders(base({ tx: [chk(3)] }), tue);
eq(it.map((i) => i.userId).sort(), ["uC"], "Eingang seit 3 Tagen: nur der Admin, nicht die Familien");
eq(buildReminders(base({ tx: [chk(3)], families: [{ id: "A", name: "Bader", user_id: "uA" }, { id: "B", name: "Hatesaul", user_id: "uB" }, { id: "C", name: "Kaufmann", user_id: "uC" }] }), tue).length, 0, "kein Admin im Projekt: keine Prüf-Erinnerung");
eq(it[0].text, "1 PayPal-Eingang (4,00 €) ist noch nicht bestätigt (Hühner).", "Text Einzahl");
eq(buildReminders(base({ tx: [chk(4)] }), tue).length, 0, "Tag 4: Pause");
eq(buildReminders(base({ tx: [chk(6), chk(3, "pq")] }), tue)[0].text, "2 PayPal-Eingänge (8,00 €) sind noch nicht bestätigt (Hühner).", "Text Mehrzahl mit Summe");

// --- Monatsabschluss
const m1 = { date: "2026-11-01", weekday: 0, day: 1 };
const monthly = (d: Data) => buildReminders(d, { date: "2026-11-01", weekday: 3, day: 1 }).map((i) => i.userId + ":" + i.text);
eq(monthly(base({ checks: [], projects: [{ id: "h", kind: "hens", name: "Hühner", settings: {} }] })).length, 2, "1. des Monats ohne Abgleich und Sicherung (Hühner): 2 Hinweise, nur an den Admin");
eq([...new Set(monthly(base({ checks: [], projects: [{ id: "h", kind: "hens", name: "Hühner", settings: {} }] })).map((x) => x.split(":")[0]))], ["uC"], "Monatsabschluss geht nur an den Admin, nicht an die Familien");
eq(monthly(base({ checks: [], families: [{ id: "A", name: "Bader", user_id: "uA" }, { id: "B", name: "Hatesaul", user_id: "uB" }, { id: "C", name: "Kaufmann", user_id: "uC" }] })), [], "kein Admin im Projekt: keine Monatsabschluss-Nachricht");
eq(monthly(base({ checks: [{ project_id: "h", created_at: "2026-10-20T10:00:00Z" }, { project_id: "g", created_at: "2026-10-20T10:00:00Z" }], projects: [{ id: "h", kind: "hens", name: "Hühner", settings: { last_backup: "2026-10-20" } }, { id: "g", kind: "goats", name: "Ziegen", settings: { last_backup: "2026-10-30" } }] })), [], "alles aktuell: keine Monatsabschluss-Nachricht");
eq(monthly(base({ checks: [{ project_id: "h", created_at: "2026-10-20T10:00:00Z" }], projects: [{ id: "h", kind: "hens", name: "Hühner", settings: {} }] })).every((x) => x.includes("Sicherung (Hühner)")), true, "nur die Sicherung fehlt: nur dieser Hinweis");
eq(buildReminders(base({ checks: [], projects: [{ id: "h", kind: "hens", name: "Hühner", settings: {} }] }), { date: "2026-11-15", weekday: 1, day: 15 }).length, 0, "nicht am 1.: kein Monatsabschluss");
eq(buildReminders(base({ checks: [{ project_id: "h", created_at: "2026-09-01T00:00:00Z" }] }), m1).some((i) => i.text.startsWith("Kassenabgleich (Hühner)")), true, "Abgleich länger als 28 Tage her: Hinweis");

// --- Zusammenfassen pro Familie
const merged = mergePerUser([{ userId: "u", title: "Nächste Woche hast du Dienst", text: "Hühner: Ab morgen bist du dran.", url: "#dienst:hens", prio: 2 }, { userId: "u", title: "Bargeld noch einzahlen", text: "Du hast noch 4,00 € ...", url: "#kasse:hens", prio: 1 }, { userId: "v", title: "Zahlung prüfen", text: "x", url: "#kasse:hens", prio: 1 }]);
eq(merged.find((m) => m.userId === "u")!.title, "Erinnerungen vom Hof", "mehrere Erinnerungen: eine Nachricht mit Sammel-Titel");
eq(merged.find((m) => m.userId === "u")!.body, "Du hast noch 4,00 € ...\nHühner: Ab morgen bist du dran.", "  wichtigstes zuerst, getrennt durch Zeilenumbruch");
eq(merged.find((m) => m.userId === "u")!.url, "#kasse:hens", "  Link führt zur wichtigsten Erinnerung");
eq(merged.find((m) => m.userId === "v")!.title, "Zahlung prüfen", "eine Erinnerung: eigener Titel");
eq(mergePerUser([{ userId: "u", title: "t", text: "gleich", url: "#a", prio: 1 }, { userId: "u", title: "t", text: "gleich", url: "#a", prio: 1 }])[0].body, "gleich", "doppelte Texte werden nur einmal genannt");

// --- Versenden über die Funktion
type Row = Record<string, any>;
function admin(db: Record<string, Row[]>) {
  const deleted: string[] = [];
  const from = (t: string) => {
    let rows: Row[] = db[t] ?? [];
    const q: any = {
      select: () => q, order: () => q, maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      eq: (c: string, v: any) => { rows = rows.filter((r) => r[c] === v); return q; },
      in: (c: string, vs: any[]) => { rows = rows.filter((r) => vs.includes(r[c])); return q; },
      delete: () => ({ eq: async (_c: string, v: string) => { deleted.push(v); return { error: null }; } }),
      then: (res: any) => res({ data: rows, error: null }),
    };
    return q;
  };
  return { from, deleted };
}
const cfg = [{ key: "vapid_public", value: "P" }, { key: "vapid_private", value: "K" }, { key: "hook_secret", value: "geheim" }, { key: "site_url", value: "https://x.test" }];
const db = (): Record<string, Row[]> => ({
  push_config: cfg, projects: base().projects, project_members: base().members, families: base().families,
  duty_swaps: [{ project_id: "h", week_start: "2026-10-26", family_id: "B" }],
  transactions: [{ id: "t1", project_id: "h", date: "2026-10-15", amount: 4, pay_state: "bar_offen", seller_id: "A", parent_id: null }],
  cash_checks: [],
  push_subscriptions: [
    { id: "s1", user_id: "uB", endpoint: "https://p/b", p256dh: "x", auth: "y", reminders: true },
    { id: "s2", user_id: "uB", endpoint: "https://p/b2", p256dh: "x", auth: "y", reminders: false },
    { id: "s3", user_id: "uA", endpoint: "https://p/a", p256dh: "x", auth: "y", reminders: true },
    { id: "s4", user_id: "uC", endpoint: "https://p/c", p256dh: "x", auth: "y", reminders: true },
  ],
});
function wp(fail: (ep: string) => any = () => "ok") { const calls: any[] = []; return { calls, setVapidDetails() {}, async sendNotification(sub: any, payload: string, opts: any) { calls.push({ ep: sub.endpoint, p: JSON.parse(payload), opts }); const r = fail(sub.endpoint); if (r !== "ok") throw r; return {}; } }; }
const post = (body: any, secret = "geheim") => new Request("https://x/fn", { method: "POST", headers: { "content-type": "application/json", "x-hook-secret": secret }, body: JSON.stringify(body) });
const run = async (d: any, req: Request, w = wp(), now = "2026-10-25T17:10:00Z") => { const a = admin(d); const r = await makeHandler({ admin: a, webpush: w as any, siteUrl: "https://f.test", now: () => new Date(now) })(req); return { r, a, w, j: await r.json() }; };

let x = await run(db(), post({ reminders: true }, "falsch"));
eq(x.r.status, 401, "Erinnerungen mit falschem Geheimnis: abgelehnt");
x = await run(db(), post({ reminders: true }), wp(), "2026-10-25T10:00:00Z");
eq([x.j.skipped !== undefined, x.w.calls.length], [true, 0], "falsche Uhrzeit (11 Uhr): nichts gesendet");
x = await run(db(), post({ reminders: true, force: true }), wp(), "2026-10-25T10:00:00Z");
eq(x.w.calls.length > 0, true, "mit force trotz falscher Uhrzeit gesendet (zum Testen)");
x = await run(db(), post({ reminders: true }), wp(), "2026-10-25T17:10:00Z");
eq([x.j.users, x.j.sent], [2, 2], "Sonntag 18:10 Berlin: 2 Familien (Hatesaul Dienst, Bader Bargeld), 2 Geräte");
eq(x.w.calls.map((c: any) => c.ep).sort(), ["https://p/a", "https://p/b"], "  Gerät mit ausgeschalteten Erinnerungen (s2) bekommt nichts");
const forB = x.w.calls.find((c: any) => c.ep === "https://p/b").p, forA = x.w.calls.find((c: any) => c.ep === "https://p/a").p;
eq([forB.title, forB.body, forB.url, forB.tag], ["Nächste Woche hast du Dienst", "Hühner: Ab morgen bist du dran.", "https://x.test/#dienst:hens", "erinnerung"], "  Nachricht Dienst mit Link");
eq([forA.title, forA.url], ["Bargeld noch einzahlen", "https://x.test/#kasse:hens"], "  Nachricht Bargeld mit Link zur Kasse (Bader hat 10 Tage offen)");
eq(x.w.calls[0].opts, { TTL: 43200, urgency: "normal" }, "  Erinnerungen sind 12 Stunden gültig und nicht dringend");
x = await run(db(), post({ reminders: true }), wp((ep) => ep === "https://p/a" ? { statusCode: 410 } : "ok"));
eq([x.j.sent, x.j.gone, x.a.deleted], [1, 1, ["s3"]], "abgemeldetes Gerät (410) wird aufgeräumt");
x = await run({ ...db(), push_subscriptions: [] }, post({ reminders: true }));
eq([x.j.users, x.j.sent], [2, 0], "keine Geräte angemeldet: kein Fehler");
x = await run({ ...db(), transactions: [], duty_swaps: [] }, post({ reminders: true }));
eq([x.j.users, x.j.sent], [0, 0], "nichts zu erinnern: nichts gesendet");
// Bestell-Nachricht funktioniert weiter
const uidMap: Record<string, string> = { A: "uA", B: "uB", C: "uC" };
x = await run({ ...db(), project_members: base().members.map((m) => ({ ...m, families: { user_id: uidMap[m.family_id] } })), egg_orders: [{ id: "o1", project_id: "h", buyer: "Meier", qty: 6, status: "offen" }] }, post({ order_id: "o1" }));
eq([x.j.total, x.w.calls[0].p.title], [4, "Neue Bestellung"], "Bestell-Nachricht unverändert");
console.log(`\n${gut} von ${n} Prüfungen bestanden`);
