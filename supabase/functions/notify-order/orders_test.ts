// Tests für Push zu Nachbar-Bestellungen (Dienst-Familie wird erinnert, die anderen einmal informiert).
// Aufruf: deno run -A orders_test.ts
import { makeHandler } from "./handler.ts";
import { deadlineText, dueOrders, dutyMsg, infoMsg, quiet, type OpenOrder } from "./orders.ts";

let n = 0;
const eq = (a: any, b: any, msg: string) => { n++; if (JSON.stringify(a) !== JSON.stringify(b)) { console.log("FEHLER:", msg, "| erwartet", JSON.stringify(b), "| war", JSON.stringify(a)); Deno.exit(1); } console.log("OK  ", msg); };

// --- Texte ---
eq(deadlineText("2026-11-21T17:00:00Z"), "Sa., 21.11., 18:00 Uhr", "Frist in Berliner Zeit (Winter)");
eq(deadlineText("2026-07-04T08:30:00+00:00"), "Sa., 04.07., 10:30 Uhr", "Frist in Berliner Zeit (Sommer)");
eq(deadlineText("2026-11-21"), "Sa., 21.11.", "Frist nur mit Datum");
eq([deadlineText(null), deadlineText("quatsch")], ["", ""], "keine oder kaputte Frist: leer");
const O = (x: Partial<OpenOrder> = {}): OpenOrder => ({ id: "o1", project_id: "p1", buyer: "Klieber", qty: 10, status: "offen", created_at: "2026-11-19T08:00:00Z", ready: true, duty_user: "uA", ...x });
eq(dutyMsg(O({ need_by: "2026-11-21T17:00:00Z" })), { title: "Offene Bestellung: Klieber", body: "10 Eier, benötigt bis Sa., 21.11., 18:00 Uhr. Bitte bearbeiten.", tag: "bestellung-o1" }, "Dienst-Nachricht mit Frist");
eq(dutyMsg(O({ qty: 1 })).body, "1 Ei. Bitte bearbeiten.", "Dienst-Nachricht ohne Frist, Einzahl");
eq(infoMsg(O()).body, "Neue Bestellung von Klieber – 10 Eier. Die diensthabende Familie kümmert sich.", "Info an die anderen");

// --- wann ist eine Erinnerung fällig? (Berlin = UTC+1 im November) ---
const at = (berlin: string) => new Date(berlin + "+01:00");
eq([quiet(at("2026-11-19T07:59:00")), quiet(at("2026-11-19T08:00:00")), quiet(at("2026-11-19T19:59:00")), quiet(at("2026-11-19T20:00:00"))], [true, false, false, true], "Nachtruhe vor 8 und ab 20 Uhr");
const o9 = O({ created_at: at("2026-11-19T09:00:00").toISOString() });
eq(dueOrders([o9], at("2026-11-19T10:50:00")).length, 0, "nach 1 Std. 50: noch nicht");
eq(dueOrders([o9], at("2026-11-19T10:56:00")).length, 1, "nach knapp 2 Std. (Zeitplan alle 10 Min.): fällig");
eq(dueOrders([{ ...o9, reminded_at: at("2026-11-19T11:00:00").toISOString() }], at("2026-11-19T12:00:00")).length, 0, "eben erinnert: nicht noch mal");
eq(dueOrders([{ ...o9, ready_notified_at: at("2026-11-19T12:00:00").toISOString() }], at("2026-11-19T13:00:00")).length, 0, "gerade „kann raus“ gemeldet: zählt als Meldung");
eq(dueOrders([o9], at("2026-11-19T20:30:00")).length, 0, "abends nach 20 Uhr: Nachtruhe");
const night = O({ created_at: at("2026-11-19T23:00:00").toISOString() });
eq([dueOrders([night], at("2026-11-20T07:50:00")).length, dueOrders([night], at("2026-11-20T08:00:00")).length], [0, 1], "Bestellung in der Nacht: erste Erinnerung um 8 Uhr");
eq(dueOrders([{ ...o9, ready: false }], at("2026-11-19T15:00:00")).length, 0, "wartende Bestellung (nicht genug Eier): keine Erinnerung");
eq(dueOrders([{ ...o9, status: "erledigt" }], at("2026-11-19T15:00:00")).length, 0, "erledigt: keine Erinnerung");
eq(dueOrders([O({ created_at: "2026-11-10T09:00:00Z" })], at("2026-11-19T15:00:00")).length, 0, "älter als 7 Tage (verfällt): keine Erinnerung");

// --- Edge Function mit simulierten Daten ---
type Row = Record<string, any>;
function fakeDb(t: Record<string, Row[]>, open: Row[] | null) {
  const updates: any[] = [];
  const from = (name: string) => {
    let rows: Row[] = [...(t[name] ?? [])];
    let upd: any = null;
    const q: any = {
      select: () => q,
      eq: (c: string, v: any) => { rows = rows.filter((r) => r[c] === v); return q; },
      in: (c: string, vs: any[]) => { if (upd) { updates.push({ table: name, set: upd, ids: vs }); } rows = rows.filter((r) => vs.includes(r[c])); return q; },
      update: (v: any) => { upd = v; return q; },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      delete: () => ({ eq: async () => ({ error: null }) }),
      then: (res: any) => res({ data: rows, error: null }),
    };
    return q;
  };
  const rpc = async (fn: string) => fn === "take_ready_orders" ? { data: [], error: null } : fn === "open_orders_push" && open ? { data: open, error: null } : { data: null, error: { message: "fehlt" } };
  return { from, rpc, updates, auth: { getUser: async () => ({ data: null, error: { message: "x" } }) } };
}
function wp() {
  const calls: any[] = [];
  return { calls, setVapidDetails() {}, async sendNotification(sub: any, p: string) { calls.push({ ep: sub.endpoint, p: JSON.parse(p) }); return {}; } };
}
const T = {
  push_config: [{ key: "vapid_public", value: "PUB" }, { key: "vapid_private", value: "PRIV" }, { key: "hook_secret", value: "g" }, { key: "site_url", value: "https://h.test" }],
  egg_orders: [{ id: "o1", project_id: "p1", buyer: "Klieber", qty: 10, status: "offen", waited: false }, { id: "o2", project_id: "p1", buyer: "Volkert", qty: 30, status: "offen", waited: true }],
  project_members: [{ project_id: "p1", family_id: "fa", families: { user_id: "uA" } }, { project_id: "p1", family_id: "fb", families: { user_id: "uB" } }, { project_id: "p1", family_id: "fc", families: { user_id: "uC" } }],
  families: [{ id: "fa", user_id: "uA" }, { id: "fb", user_id: "uB" }, { id: "fc", user_id: "uC" }],
  push_subscriptions: [{ id: "s1", user_id: "uA", endpoint: "a" }, { id: "s2", user_id: "uB", endpoint: "b" }, { id: "s3", user_id: "uC", endpoint: "c" }],
  push_prefs: [] as Row[],
};
const OPEN = [O({ need_by: "2026-11-21T17:00:00Z" }), O({ id: "o2", buyer: "Volkert", qty: 30, ready: false, waited: true })];
const call = async (body: any, open: Row[] | null = OPEN, tables: any = T, now = at("2026-11-19T12:00:00")) => {
  const a = fakeDb(tables, open), w = wp();
  const r = await makeHandler({ admin: a, webpush: w as any, siteUrl: "x", now: () => now })(new Request("https://x", { method: "POST", headers: { "x-hook-secret": "g" }, body: JSON.stringify(body) }));
  return { j: await r.json(), w, a, by: Object.fromEntries(w.calls.map((c: any) => [c.ep, c.p])) };
};

let x = await call({ order_id: "o1" });
eq(x.by.a, { title: "Offene Bestellung: Klieber", body: "10 Eier, benötigt bis Sa., 21.11., 18:00 Uhr. Bitte bearbeiten.", url: "https://h.test/#bestellungen", tag: "bestellung-o1" }, "neue Bestellung: Familie mit Dienst bekommt „Offene Bestellung“");
eq([x.by.b?.body, x.by.c?.body, x.w.calls.length], ["Neue Bestellung von Klieber – 10 Eier. Die diensthabende Familie kümmert sich.", "Neue Bestellung von Klieber – 10 Eier. Die diensthabende Familie kümmert sich.", 3], "die anderen bekommen einmal die Info");
x = await call({ order_id: "o2" });
eq([x.by.a.title, x.by.b.title], ["Bestellung wartet: Volkert", "Neue Bestellung"], "wartende Bestellung: Dienst erfährt es, die anderen bekommen die Info");
x = await call({ order_id: "o1" }, OPEN.map((o) => ({ ...o, duty_user: null })));
eq([x.by.a.title, x.by.b.title, x.by.c.title], ["Offene Bestellung: Klieber", "Offene Bestellung: Klieber", "Offene Bestellung: Klieber"], "keine Familie mit Dienst: alle bekommen die Dienst-Nachricht");
x = await call({ order_id: "o1" }, OPEN, { ...T, push_prefs: [{ family_id: "fb", kind: "order_new", enabled: false }] });
eq(Object.keys(x.by).sort(), ["a", "c"], "Info im Admin-Tab ausgeschaltet: B bekommt nichts");
x = await call({ order_id: "o1" }, OPEN, { ...T, push_prefs: [{ family_id: "fa", kind: "order_new", enabled: false }] });
eq(x.by.a?.title, "Offene Bestellung: Klieber", "Dienst-Familie hängt nicht an „Neue Bestellung“, sondern an „Bestellung kann raus“");
x = await call({ order_id: "o1" }, null);
eq([x.w.calls.length, x.by.a.body], [3, "Klieber: 10 Eier"], "Datenbank-Funktion fehlt noch: wie früher an alle");

x = await call({ queue: true }, OPEN, T, at("2026-11-19T09:30:00"));
eq([x.j, Object.keys(x.by), x.a.updates.length], [{ orders: 0, sent: 0, reminded: 0 }, [], 0], "Zeitplan: eben erst bestellt, noch keine Erinnerung");
x = await call({ queue: true }, OPEN, T, at("2026-11-19T11:00:00"));
eq([x.j, Object.keys(x.by), x.by.a.title], [{ orders: 0, sent: 1, reminded: 1 }, ["a"], "Offene Bestellung: Klieber"], "Zeitplan: nach 2 Std. nur die Familie mit Dienst, nur die bereite Bestellung");
eq(x.a.updates, [{ table: "egg_orders", set: { reminded_at: at("2026-11-19T11:00:00").toISOString() }, ids: ["o1"] }], "Zeitpunkt der Erinnerung wird gespeichert");
x = await call({ queue: true }, OPEN, T, at("2026-11-19T21:00:00"));
eq([x.j.reminded, x.w.calls.length], [0, 0], "Zeitplan in der Nachtruhe: nichts");
x = await call({ queue: true }, null, T, at("2026-11-19T11:00:00"));
eq(x.j, { orders: 0, sent: 0 }, "Datenbank-Funktion fehlt: Warteliste läuft wie bisher");

console.log(`\nalle ${n} Tests bestanden`);
