// Tests für „Nachricht an Familien“ (Tab Hof) von notify-order.
// Aufruf: deno run -A family_msg_test.ts
import { makeHandler } from "./handler.ts";

type Row = Record<string, any>;
function fakeDb(tables: Record<string, Row[] | undefined>) {
  const inserted: Record<string, Row[]> = {};
  const from = (t: string) => {
    const missing = tables[t] === undefined;
    let rows: Row[] = [...(tables[t] ?? [])];
    const q: any = {
      select: () => q, order: () => q,
      eq: (c: string, v: any) => { rows = rows.filter((r) => r[c] === v); return q; },
      in: (c: string, vs: any[]) => { rows = rows.filter((r) => vs.includes(r[c])); return q; },
      gte: (c: string, v: any) => { rows = rows.filter((r) => r[c] >= v); return q; },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      insert: async (r: Row) => { (inserted[t] ||= []).push(r); return { error: null }; },
      delete: () => ({ eq: async () => ({ error: null }) }),
      then: (res: any) => res(missing ? { data: null, error: { message: "relation does not exist" } } : { data: rows, error: null }),
    };
    return q;
  };
  const users: Record<string, string> = { "jwt-adm": "uAdm", "jwt-a": "uA", "jwt-b": "uB", "jwt-x": "uX" };
  return { from, inserted, auth: { getUser: async (jwt: string) => users[jwt] ? { data: { user: { id: users[jwt] } }, error: null } : { data: null, error: { message: "bad" } } } };
}
function wp() {
  const calls: any[] = [];
  return { calls, setVapidDetails() {}, async sendNotification(sub: any, payload: string) { calls.push({ ep: sub.endpoint, p: JSON.parse(payload) }); return {}; } };
}
const base = (o: { msgs?: Row[] | undefined; prefs?: Row[] } = {}) => fakeDb({
  push_prefs: o.prefs ?? [],
  push_config: [{ key: "vapid_public", value: "PUB" }, { key: "vapid_private", value: "PRIV" }, { key: "site_url", value: "https://hof.test" }],
  families: [
    { id: "fAdm", name: "Admin", user_id: "uAdm", is_system: true, left_on: null },
    { id: "fA", name: "Kaufmann", user_id: "uA", left_on: null },
    { id: "fB", name: "Stopfer", user_id: "uB", left_on: null },
    { id: "fC", name: "Hatesaul", user_id: "uC", left_on: null },
    { id: "fX", name: "Bader", user_id: "uX", left_on: "2026-10-25" },
  ],
  projects: [{ id: "p1", kind: "hens" }, { id: "p2", kind: "goats" }],
  project_members: [
    { project_id: "p1", family_id: "fAdm" }, { project_id: "p1", family_id: "fA" }, { project_id: "p1", family_id: "fB" }, { project_id: "p1", family_id: "fC" }, { project_id: "p1", family_id: "fX" },
    { project_id: "p2", family_id: "fA" }, { project_id: "p2", family_id: "fC" },
  ],
  push_subscriptions: [
    { id: "s0", user_id: "uAdm", endpoint: "https://push/adm", p256dh: "k", auth: "a" },
    { id: "s1", user_id: "uA", endpoint: "https://push/a", p256dh: "k", auth: "a" },
    { id: "s2", user_id: "uB", endpoint: "https://push/b", p256dh: "k", auth: "a" },
    { id: "s2b", user_id: "uB", endpoint: "https://push/b2", p256dh: "k", auth: "a" },
    { id: "s3", user_id: "uX", endpoint: "https://push/x", p256dh: "k", auth: "a" },
  ],
  family_messages: "msgs" in o ? o.msgs : [],
});
const NOW = "2026-11-19T20:00:00.000Z";
const post = (body: any, jwt?: string) => new Request("https://x/fn", { method: "POST", headers: { "content-type": "application/json", ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) }, body: JSON.stringify(body) });
const eq = (a: any, b: any, msg: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) { console.log("FEHLER:", msg, "| erwartet", JSON.stringify(b), "| war", JSON.stringify(a)); Deno.exit(1); } console.log("OK  ", msg); };
const run = async (body: any, jwt?: string, o: any = {}) => {
  const d = base(o); const w = wp();
  const r = await makeHandler({ admin: d, webpush: w as any, siteUrl: "https://fb.test", now: () => new Date(NOW) })(post({ family_msg: true, project_id: "p1", ...body }, jwt));
  return { r, j: await r.json(), w, d, eps: w.calls.map((c) => c.ep).sort() };
};

let x = await run({ to: "all", text: "Hallo" });
eq([x.r.status, x.w.calls.length], [401, 0], "ohne Anmeldung: abgelehnt");
x = await run({ to: "all", text: "Hallo" }, "jwt-x");
eq([x.r.status, x.w.calls.length], [403, 0], "ausgetretene Familie: abgelehnt");
x = await run({ project_id: "p2", to: "all", text: "Hallo" }, "jwt-b");
eq([x.r.status, x.w.calls.length], [403, 0], "nicht Mitglied des Projekts: abgelehnt");
x = await run({ to: "all", text: "   " }, "jwt-a");
eq([x.r.status, x.w.calls.length], [400, 0], "leerer Text: abgelehnt");
x = await run({ to: "all", text: "x".repeat(201) }, "jwt-a");
eq([x.r.status, x.j.error], [400, "Höchstens 200 Zeichen"], "Text über 200 Zeichen: abgelehnt");
x = await run({ to: [], text: "Hallo" }, "jwt-a");
eq(x.r.status, 400, "keine Empfänger gewählt: abgelehnt");
x = await run({ to: ["fB", "fX"], text: "Hallo" }, "jwt-a");
eq([x.r.status, x.w.calls.length], [400, 0], "ausgetretene Familie als Empfänger: abgelehnt");
x = await run({ to: ["fA"], text: "Hallo" }, "jwt-a");
eq([x.r.status, x.w.calls.length], [400, 0], "nur an sich selbst: abgelehnt");

x = await run({ to: "all", text: "Morgen  ist\nStall putzen" }, "jwt-a");
eq([x.r.status, x.j.sent, x.eps], [200, 2, ["https://push/b", "https://push/b2"]], "an alle: andere aktive Familien, nicht Absender, nicht Ausgetretene, nicht Admin-Konto");
eq([x.w.calls[0].p.title, x.w.calls[0].p.body, x.w.calls[0].p.url], ["Nachricht von Familie Kaufmann", "Morgen ist Stall putzen", "https://hof.test/#hof:hens"], "Absender steht im Titel, Text ohne Zeilenumbrüche");
eq([x.j.to, x.j.without], [["Stopfer", "Hatesaul"], ["Hatesaul"]], "Antwort nennt Empfänger und wer keine Benachrichtigungen hat");
eq([x.d.inserted.family_messages?.length, x.d.inserted.family_messages?.[0].to_families, x.d.inserted.family_messages?.[0].sent], [1, ["fB", "fC"], 2], "wird protokolliert");

x = await run({ to: ["fC", "fAdm"], text: "Hallo" }, "jwt-a");
eq([x.r.status, x.eps], [200, ["https://push/adm"]], "Auswahl: Admin-Konto gezielt wählbar, Hatesaul ohne Gerät");
x = await run({ to: "all", text: "Hallo" }, "jwt-adm");
eq([x.w.calls[0].p.title, x.eps], ["Nachricht vom Admin", ["https://push/a", "https://push/b", "https://push/b2"]], "Admin-Konto sendet: Titel „vom Admin“");
x = await run({ to: "all", text: "Hallo" }, "jwt-a", { prefs: [{ family_id: "fB", kind: "family_msg", enabled: false }] });
eq([x.j.sent, x.j.without], [0, ["Stopfer", "Hatesaul"]], "im Admin-Tab für Stopfer ausgeschaltet: bekommt nichts");

x = await run({ to: "all", text: "Hallo" }, "jwt-a", { msgs: [{ from_family: "fA", created_at: "2026-11-19T19:59:30.000Z" }] });
eq([x.r.status, x.w.calls.length], [429, 0], "zweite Nachricht innerhalb einer Minute: gesperrt");
x = await run({ to: "all", text: "Hallo" }, "jwt-a", { msgs: [{ from_family: "fB", created_at: "2026-11-19T19:59:30.000Z" }] });
eq(x.r.status, 200, "Sperre gilt je Familie");
const ten = Array.from({ length: 10 }, (_, i) => ({ from_family: "fA", created_at: `2026-11-19T0${i}:00:00.000Z` }));
x = await run({ to: "all", text: "Hallo" }, "jwt-a", { msgs: ten });
eq([x.r.status, x.w.calls.length], [429, 0], "11. Nachricht in 24 Stunden: gesperrt");
x = await run({ to: "all", text: "Hallo" }, "jwt-a", { msgs: ten.map((m) => ({ ...m, created_at: "2026-11-18T10:00:00.000Z" })) });
eq(x.r.status, 200, "Nachrichten von gestern (älter als 24 Std.) zählen nicht");
x = await run({ to: "all", text: "Hallo" }, "jwt-a", { msgs: undefined });
eq([x.r.status, x.w.calls.length], [503, 0], "ohne Datenbank-Update: nichts gesendet");

console.log("\nalle Tests bestanden");
