// Tests für die Admin-Aktionen von notify-order (Nachricht, Hinweis, Vorschau) und das Protokoll der Erinnerungs-Läufe.
// Aufruf: deno run -A admin_test.ts
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
const db = () => fakeDb({
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
  duty_swaps: [{ project_id: "p1", week_start: "2026-10-26", family_id: "fB" }],
  transactions: [], cash_checks: [], egg_log: [],
});
const post = (body: any, h: Record<string, string> = {}) => new Request("https://x/fn", { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(body) });
const eq = (a: any, b: any, msg: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) { console.log("FEHLER:", msg, "| erwartet", JSON.stringify(b), "| war", JSON.stringify(a)); Deno.exit(1); } console.log("OK  ", msg); };
const run = async (body: any, h: Record<string, string> = {}, now = "2026-10-25T17:00:00Z") => {
  const d = db(); const w = wp();
  const r = await makeHandler({ admin: d, webpush: w as any, siteUrl: "https://fb.test", now: () => new Date(now) })(post(body, h));
  return { r, j: await r.json(), w, d };
};
const ADM = { authorization: "Bearer jwt-admin" }, FAM = { authorization: "Bearer jwt-fam" };

let x = await run({ admin: "message", family_id: "fA", text: "Hallo" });
eq([x.r.status, x.w.calls.length], [401, 0], "Admin-Aktion ohne Anmeldung: abgelehnt");
x = await run({ admin: "message", family_id: "fA", text: "Hallo" }, FAM);
eq([x.r.status, x.w.calls.length], [403, 0], "Admin-Aktion als Familie ohne Admin-Recht: abgelehnt");
x = await run({ admin: "message", family_id: "fA", text: "  Test vom Admin  " }, ADM);
eq([x.r.status, x.j.sent, x.w.calls.map((c) => c.ep), x.w.calls[0].p.body, x.w.calls[0].p.title], [200, 1, ["https://push/a"], "Test vom Admin", "Nachricht vom Admin"], "Nachricht geht nur an die gewählte Familie");
x = await run({ admin: "message", family_id: "fA", text: "   " }, ADM);
eq([x.r.status, x.w.calls.length], [400, 0], "leere Nachricht: abgelehnt");
x = await run({ admin: "message", family_id: "fX", text: "Hallo" }, ADM);
eq([x.r.status, x.w.calls.length], [404, 0], "ausgetretene Familie: keine Nachricht");
x = await run({ admin: "message", family_id: "fB", text: "x".repeat(500) }, ADM);
eq([x.j.sent, x.w.calls[0].p.body.length], [1, 300], "Nachricht wird auf 300 Zeichen gekürzt, Erinnerungs-Schalter spielt keine Rolle");

x = await run({ admin: "notice", project_id: "p1" }, ADM);
eq([x.r.status, x.w.calls.map((c) => c.ep).sort(), x.w.calls[0].p.body, x.w.calls[0].p.title, x.w.calls[0].p.url], [200, ["https://push/a", "https://push/adm", "https://push/b"], "Samstag Stall putzen", "Hinweis (Hühner)", "https://hof.test/#hinweis:hens"], "Hinweis geht an alle Mitglieder des Projekts");
x = await run({ admin: "notice", project_id: "p2" }, ADM);
eq([x.r.status, x.w.calls.length], [400, 0], "ohne gespeicherten Hinweis: nichts gesendet");

x = await run({ admin: "preview", date: "2026-10-25" }, ADM);
eq([x.r.status, x.w.calls.length, x.j.messages.map((m: any) => m.name), x.j.messages[0].title], [200, 0, ["Stopfer"], "Nächste Woche hast du Dienst"], "Vorschau zeigt die Erinnerungen, sendet aber nichts");
x = await run({ admin: "preview", date: "2026-10-25", send: true }, ADM);
eq([x.j.sent, x.w.calls.map((c) => c.ep), x.w.calls[0].p.title], [1, ["https://push/adm"], "Vorschau für Stopfer: Nächste Woche hast du Dienst"], "Vorschau senden geht nur an den Admin");
x = await run({ admin: "preview", date: "2026-10-24" }, ADM);
eq(x.j.messages.length, 0, "Samstag: keine Dienst-Erinnerung");
x = await run({ admin: "preview" }, FAM);
eq(x.r.status, 403, "Vorschau nur für den Admin");
x = await run({ admin: "unsinn" }, ADM);
eq(x.r.status, 400, "unbekannte Admin-Aktion: 400");

x = await run({ reminders: true }, { "x-hook-secret": "geheim" }, "2026-10-25T17:00:00Z");
eq([x.j.users, x.j.sent, x.d.inserted.reminder_runs?.length, x.d.inserted.reminder_runs?.[0].kind], [1, 0, 1, "lauf"], "18-Uhr-Lauf wird protokolliert (Stopfer hat Erinnerungen aus)");
x = await run({ reminders: true }, { "x-hook-secret": "geheim" }, "2026-10-25T15:00:00Z");
eq([x.j.skipped, x.d.inserted.reminder_runs], ["nicht die Erinnerungsstunde", undefined], "außerhalb der Stunde: kein Protokoll-Eintrag");

console.log("\nalle Tests bestanden");
