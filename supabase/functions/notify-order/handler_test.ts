import { makeHandler } from "./handler.ts";

type Row = Record<string, any>;
function fakeAdmin(db: { cfg?: Row[]; orders?: Row[]; members?: Row[]; subs?: Row[]; users?: Record<string, string>; cfgError?: boolean; ready?: Row[] | null }) {
  const deleted: string[] = [];
  const from = (t: string) => {
    let rows: Row[] = t === "push_config" ? (db.cfg ?? []) : t === "egg_orders" ? (db.orders ?? []) : t === "project_members" ? (db.members ?? []) : (db.subs ?? []);
    const q: any = {
      select: () => q,
      eq: (c: string, v: any) => { rows = rows.filter(r => r[c] === v); return q; },
      in: (c: string, vs: any[]) => { rows = rows.filter(r => vs.includes(r[c])); return q; },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      delete: () => ({ eq: async (_c: string, v: string) => { deleted.push(v); return { error: null }; } }),
      then: (res: any) => res(t === "push_config" && db.cfgError ? { data: null, error: { message: "x" } } : { data: rows, error: null }),
    };
    return q;
  };
  const rpc = async (name: string) => name === "take_ready_orders" ? (db.ready === null ? { data: null, error: { message: "x" } } : { data: db.ready ?? [], error: null }) : { data: null, error: { message: "unbekannt" } };
  return { from, rpc, deleted, auth: { getUser: async (jwt: string) => db.users?.[jwt] ? { data: { user: { id: db.users[jwt] } }, error: null } : { data: null, error: { message: "bad" } } } };
}
const CFG = [
  { key: "vapid_public", value: "PUB" }, { key: "vapid_private", value: "PRIV" },
  { key: "hook_secret", value: "geheim123" }, { key: "site_url", value: "https://example.test" },
];
function wp(behaviour: (ep: string) => any = () => "ok") {
  const calls: any[] = [];
  return {
    calls, details: [] as any[],
    setVapidDetails(...a: any[]) { this.details.push(a); },
    async sendNotification(sub: any, payload: string, opts: any) {
      calls.push({ sub, payload: JSON.parse(payload), opts });
      const r = behaviour(sub.endpoint); if (r !== "ok") throw r; return {};
    },
  };
}
const post = (body: any, headers: Record<string, string> = {}) => new Request("https://x/fn", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const eq = (a: any, b: any, msg: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) { console.log("FEHLER:", msg, "| erwartet", JSON.stringify(b), "| war", JSON.stringify(a)); Deno.exit(1); } console.log("OK  ", msg); };
const run = async (db: any, req: Request, w = wp()) => { const a = fakeAdmin(db); const r = await makeHandler({ admin: a, webpush: w as any, siteUrl: "https://fallback.test" })(req); return { r, a, w, j: r.status === 204 ? null : await r.json() }; };

const base = {
  cfg: CFG,
  orders: [{ id: "o1", project_id: "p1", buyer: "Familie Meier", qty: 6, status: "offen" }, { id: "o2", project_id: "p1", buyer: "Familie Huber", qty: 1, status: "offen" }, { id: "o3", project_id: "p1", buyer: "Volkert", qty: 6, status: "offen", waited: true }],
  members: [{ project_id: "p1", family_id: "fa", families: { user_id: "uA" } }, { project_id: "p1", family_id: "fb", families: { user_id: "uB" } }, { project_id: "p2", family_id: "fc", families: { user_id: "uC" } }],
  subs: [
    { id: "s1", user_id: "uA", endpoint: "https://push/a", p256dh: "k1", auth: "a1" },
    { id: "s2", user_id: "uB", endpoint: "https://push/b", p256dh: "k2", auth: "a2" },
    { id: "s3", user_id: "uC", endpoint: "https://push/c", p256dh: "k3", auth: "a3" },   // anderes Projekt
    { id: "s4", user_id: "uB", endpoint: "https://push/b2", p256dh: "k4", auth: "a4" },  // zweites Gerät
  ],
  users: { "jwt-A": "uA" },
};

let x = await run(base, new Request("https://x/fn", { method: "OPTIONS" }));
eq([x.r.status, x.r.headers.get("access-control-allow-origin")], [204, "*"], "Vorabfrage des Browsers (CORS) wird beantwortet");
x = await run(base, new Request("https://x/fn", { method: "GET" }));
eq(x.r.status, 405, "GET wird abgelehnt");
x = await run(base, post({ order_id: "o1" }, { "x-hook-secret": "falsch" }));
eq([x.r.status, x.w.calls.length], [401, 0], "falsches Geheimnis: abgelehnt, nichts gesendet");
x = await run(base, post({ order_id: "o1" }));
eq([x.r.status, x.w.calls.length], [401, 0], "ohne Geheimnis und ohne Test: abgelehnt");
x = await run(base, post({ order_id: "o1" }, { "x-hook-secret": "geheim123" }));
eq(x.j, { total: 3, sent: 3, gone: 0, failed: 0 }, "neue Bestellung: 3 Geräte der Projekt-Mitglieder (nicht das andere Projekt)");
eq(x.w.calls.map((c: any) => c.sub.endpoint).sort(), ["https://push/a", "https://push/b", "https://push/b2"], "richtige Empfänger-Geräte");
eq(x.w.calls[0].payload, { title: "Neue Bestellung", body: "Familie Meier: 6 Eier", url: "https://example.test/#bestellungen", tag: "bestellung-o1" }, "Nachrichtentext mit Name, Menge und Link");
eq(x.w.calls[0].opts, { TTL: 86400, urgency: "high" }, "Zustell-Optionen (24 h gültig, dringend)");
eq(x.w.details[0], ["https://example.test", "PUB", "PRIV"], "Absender-Angaben (VAPID) übergeben");
x = await run(base, post({ order_id: "o2" }, { "x-hook-secret": "geheim123" }));
eq(x.w.calls[0].payload.body, "Familie Huber: 1 Ei", "Einzahl: „1 Ei“");
x = await run(base, post({ order_id: "gibtsnicht" }, { "x-hook-secret": "geheim123" }));
eq(x.r.status, 404, "unbekannte Bestellung: 404");
x = await run(base, post({}, { "x-hook-secret": "geheim123" }));
eq(x.r.status, 400, "ohne order_id: 400");
x = await run(base, post({ order_id: "o1" }, { "x-hook-secret": "geheim123" }), wp(ep => ep === "https://push/b" ? { statusCode: 410 } : "ok"));
eq([x.j.sent, x.j.gone, x.j.failed, x.a.deleted], [2, 1, 0, ["s2"]], "abgemeldetes Gerät (410) wird gelöscht, die anderen bekommen die Nachricht");
x = await run(base, post({ order_id: "o1" }, { "x-hook-secret": "geheim123" }), wp(ep => ep === "https://push/a" ? { statusCode: 404 } : ep === "https://push/b2" ? { statusCode: 500 } : "ok"));
eq([x.j.sent, x.j.gone, x.j.failed, x.a.deleted], [1, 1, 1, ["s1"]], "404 gelöscht, 500 nur gezählt (Gerät bleibt)");
x = await run(base, post({ order_id: "o1" }, { "x-hook-secret": "geheim123" }), wp(() => new Error("Netzwerk")));
eq([x.j.sent, x.j.gone, x.j.failed, x.a.deleted], [0, 0, 3, []], "Netzwerkfehler: nichts gelöscht");
x = await run(base, post({ test: true }, { authorization: "Bearer jwt-A" }));
eq([x.j.total, x.w.calls[0].sub.endpoint, x.w.calls[0].payload.title], [1, "https://push/a", "Test erfolgreich"], "Test aus der App: nur an die Geräte des angemeldeten Nutzers");
x = await run(base, post({ test: true }, { authorization: "Bearer falsch" }));
eq([x.r.status, x.w.calls.length], [401, 0], "Test mit ungültiger Anmeldung: abgelehnt");
x = await run(base, post({ test: true }));
eq(x.r.status, 401, "Test ohne Anmeldung: abgelehnt");
x = await run({ ...base, subs: [] }, post({ order_id: "o1" }, { "x-hook-secret": "geheim123" }));
eq(x.j, { total: 0, sent: 0, gone: 0, failed: 0 }, "keine Geräte angemeldet: nichts zu tun, kein Fehler");
x = await run({ ...base, cfg: [{ key: "hook_secret", value: "geheim123" }] }, post({ order_id: "o1" }, { "x-hook-secret": "geheim123" }));
eq(x.r.status, 500, "ohne VAPID-Schlüssel: 500");
x = await run({ ...base, cfgError: true }, post({ order_id: "o1" }, { "x-hook-secret": "geheim123" }));
eq(x.r.status, 500, "Konfiguration nicht lesbar: 500");
x = await run({ ...base, cfg: CFG.filter(r => r.key !== "hook_secret") }, post({ order_id: "o1" }, { "x-hook-secret": "" }));
eq(x.r.status, 401, "kein Geheimnis konfiguriert: nie erlaubt");
// Warteliste
x = await run(base, post({ order_id: "o3" }, { "x-hook-secret": "geheim123" }));
eq([x.j.sent, x.w.calls[0].payload], [3, { title: "Bestellung wartet", body: "Volkert möchte 6 Eier, gerade ist nichts frei. Hast du welche übrig?", url: "https://example.test/#bestellungen", tag: "bestellung-o3" }], "wartende Bestellung: an alle Familien mit der Frage nach übrigen Eiern");
x = await run({ ...base, ready: [{ id: "o3", project_id: "p1", buyer: "Volkert", qty: 6, duty_user: "uB" }] }, post({ queue: true }, { "x-hook-secret": "geheim123" }));
eq([x.j, x.w.calls.map((c: any) => c.sub.endpoint).sort(), x.w.calls[0].payload.title, x.w.calls[0].payload.body], [{ orders: 1, sent: 2 }, ["https://push/b", "https://push/b2"], "Bestellung kann raus", "Für Volkert sind jetzt 6 Eier frei."], "Warteliste: jetzt bereit, Nachricht an die Familie mit Dienst (beide Geräte)");
x = await run({ ...base, ready: [{ id: "o2", project_id: "p1", buyer: "Familie Huber", qty: 1, duty_user: null }] }, post({ queue: true }, { "x-hook-secret": "geheim123" }));
eq([x.j.sent, x.w.calls[0].payload.body], [3, "Für Familie Huber ist jetzt 1 Ei frei."], "ohne Dienst: an alle des Projekts");
x = await run({ ...base, ready: [] }, post({ queue: true }, { "x-hook-secret": "geheim123" }));
eq([x.j, x.w.calls.length], [{ orders: 0, sent: 0 }, 0], "nichts bereit: keine Nachricht");
x = await run({ ...base, ready: null }, post({ queue: true }, { "x-hook-secret": "geheim123" }));
eq(x.r.status, 500, "Warteliste nicht lesbar: 500");
x = await run({ ...base, ready: [] }, post({ queue: true }));
eq(x.r.status, 401, "Warteliste ohne Geheimnis: abgelehnt");
console.log("\nalle Tests bestanden");
