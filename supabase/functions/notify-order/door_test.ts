// Tests für die Meldung „Neue Türzeiten“ von notify-order.
// Aufruf: deno run -A door_test.ts
import { makeHandler } from "./handler.ts";

type Row = Record<string, any>;
function fakeDb(tables: Record<string, Row[]>) {
  const inserted: Record<string, Row[]> = {};
  const from = (t: string) => {
    let rows: Row[] = [...(tables[t] ?? [])];
    const q: any = {
      select: () => q, order: () => q,
      eq: (c: string, v: any) => { rows = rows.filter((r) => r[c] === v); return q; },
      in: (c: string, vs: any[]) => { rows = rows.filter((r) => vs.includes(r[c])); return q; },
      gte: (c: string, v: any) => { rows = rows.filter((r) => r[c] >= v); return q; },
      lte: (c: string, v: any) => { rows = rows.filter((r) => r[c] <= v); return q; },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      insert: async (r: Row) => { (inserted[t] ||= []).push(r); return { error: null }; },
      delete: () => ({ eq: async () => ({ error: null }) }),
      then: (res: any) => res({ data: rows, error: null }),
    };
    return q;
  };
  return { from, inserted, auth: { getUser: async (jwt: string) => ({ "jwt-admin": "uAdm", "jwt-fam": "uA" } as any)[jwt] ? { data: { user: { id: ({ "jwt-admin": "uAdm", "jwt-fam": "uA" } as any)[jwt] } }, error: null } : { data: null, error: { message: "bad" } } } };
}
function wp() {
  const calls: any[] = [];
  return { calls, setVapidDetails() {}, async sendNotification(sub: any, payload: string) { calls.push({ ep: sub.endpoint, p: JSON.parse(payload) }); return {}; } };
}
const db = (prefs: Row[] = []) => fakeDb({
  push_prefs: prefs,
  push_config: [{ key: "vapid_public", value: "PUB" }, { key: "vapid_private", value: "PRIV" }, { key: "hook_secret", value: "geheim" }, { key: "site_url", value: "https://hof.test" }],
  families: [
    { id: "fAdm", name: "Admin", user_id: "uAdm", is_admin: true, left_on: null },
    { id: "fA", name: "Kaufmann", user_id: "uA", is_admin: false, left_on: null },
    { id: "fB", name: "Stopfer", user_id: "uB", is_admin: false, left_on: null },
    { id: "fX", name: "Bader", user_id: "uX", is_admin: false, left_on: "2026-10-25" },
  ],
  projects: [{ id: "p1", kind: "hens", name: "Hühner", settings: { notice: { text: "Samstag Stall putzen", at: "2026-10-25" } } }, { id: "p2", kind: "goats", name: "Ziegen", settings: {} }],
  project_members: [{ project_id: "p1", family_id: "fAdm" }, { project_id: "p1", family_id: "fA" }, { project_id: "p1", family_id: "fB" }, { project_id: "p2", family_id: "fA" }],
  push_subscriptions: [
    { id: "s0", user_id: "uAdm", endpoint: "https://push/adm", p256dh: "k", auth: "a", reminders: true },
    { id: "s1", user_id: "uA", endpoint: "https://push/a", p256dh: "k", auth: "a", reminders: true },
    { id: "s2", user_id: "uB", endpoint: "https://push/b", p256dh: "k", auth: "a", reminders: false },
    { id: "s3", user_id: "uX", endpoint: "https://push/x", p256dh: "k", auth: "a", reminders: true },
  ],
  door_times: [
    { id: "d1", project_id: "p1", opens_at: "07:15:00", closes_at: "18:45:00", family_id: "fA", note: "Winterzeit", created_at: "2026-11-06T10:50:00Z" },
    { id: "d0", project_id: "p1", opens_at: "07:00:00", closes_at: "20:00:00", family_id: "fB", note: "", created_at: "2026-10-01T10:00:00Z" },
    { id: "d2", project_id: "p2", opens_at: "08:00:00", closes_at: "19:00:00", family_id: "fA", note: "", created_at: "2026-11-06T10:55:00Z" },
    { id: "d3", project_id: "p1", opens_at: "07:30:00", closes_at: "19:00:00", family_id: "fB", note: "", created_at: "2026-11-06T10:58:00Z" },
  ],
  duty_swaps: [{ project_id: "p1", week_start: "2026-10-26", family_id: "fB" }],
  transactions: [], cash_checks: [], egg_log: [],
});
const post = (body: any, h: Record<string, string> = {}) => new Request("https://x/fn", { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(body) });
const eq = (a: any, b: any, msg: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) { console.log("FEHLER:", msg, "| erwartet", JSON.stringify(b), "| war", JSON.stringify(a)); Deno.exit(1); } console.log("OK  ", msg); };
const run = async (body: any, h: Record<string, string> = {}, now = "2026-11-06T11:00:00Z", prefs: Row[] = []) => {
  const d = db(prefs); const w = wp();
  const r = await makeHandler({ admin: d, webpush: w as any, siteUrl: "https://fb.test", now: () => new Date(now) })(post(body, h));
  return { r, j: await r.json(), w, d };
};
const ADM = { authorization: "Bearer jwt-admin" }, FAM = { authorization: "Bearer jwt-fam" };

let x = await run({ door: "d1" });
eq([x.r.status, x.w.calls.length], [401, 0], "ohne Anmeldung: abgelehnt");
x = await run({ door: "gibtsnicht" }, FAM);
eq([x.r.status, x.w.calls.length], [404, 0], "unbekannter Eintrag: 404");
x = await run({ door: "d1" }, FAM);
eq([x.r.status, x.j.sent, x.w.calls.map((c) => c.ep).sort()], [200, 2, ["https://push/adm", "https://push/b"]], "geht an die anderen Familien des Projekts, nicht an den Absender und nicht an Ausgetretene");
eq([x.w.calls[0].p.title, x.w.calls[0].p.body, x.w.calls[0].p.url, x.w.calls[0].p.tag], ["Neue Türzeiten", "Die Tür öffnet um 07:15 Uhr und schließt um 18:45 Uhr (eingetragen von Kaufmann): Winterzeit", "https://hof.test/#dienst:hens", "tuer-p1"], "Text kommt aus dem gespeicherten Eintrag");
x = await run({ door: "d3" }, FAM);
eq(x.w.calls[0].p.body, "Die Tür öffnet um 07:30 Uhr und schließt um 19:00 Uhr (eingetragen von Stopfer).", "ohne Notiz: Satz endet mit Punkt, Name der eingetragenen Familie");
x = await run({ door: "d0" }, FAM);
eq([x.r.status, x.w.calls.length], [400, 0], "alter Eintrag (über 60 Minuten): nichts gesendet");
x = await run({ door: "d1" }, FAM, "2026-11-06T11:51:00Z");
eq([x.r.status, x.w.calls.length], [400, 0], "derselbe Eintrag nach 61 Minuten: nichts gesendet");
x = await run({ door: "d2" }, ADM);
eq([x.r.status, x.w.calls.length], [403, 0], "nicht Mitglied des Projekts: abgelehnt");
x = await run({ door: "d1" }, FAM, undefined, [{ family_id: "fB", kind: "door", enabled: false }]);
eq([x.j.sent, x.w.calls.map((c) => c.ep)], [1, ["https://push/adm"]], "im Admin-Tab für Stopfer ausgeschaltet: nur der Admin bekommt es");
x = await run({ door: "d1" }, ADM);
eq([x.r.status, x.w.calls.map((c) => c.ep).sort()], [200, ["https://push/a", "https://push/b"]], "Admin trägt ein: die Familien bekommen es");

console.log("\nalle Tests bestanden");
