// Tests: notify-order merkt sich je Gerät, ob die letzte Nachricht angekommen ist (Geräteliste im Tab Admin).
// Aufruf: deno run -A device_push_test.ts
import { makeHandler } from "./handler.ts";

let n = 0;
const eq = (a: any, b: any, msg: string) => { n++; if (JSON.stringify(a) !== JSON.stringify(b)) { console.log("FEHLER:", msg, "| erwartet", JSON.stringify(b), "| war", JSON.stringify(a)); Deno.exit(1); } console.log("OK  ", msg); };
type Row = Record<string, any>;
function fakeDb(t: Record<string, Row[]>, updateFails = false) {
  const marks: any[] = [], deleted: any[] = [];
  const from = (name: string) => {
    let rows: Row[] = [...(t[name] ?? [])];
    let upd: any = null;
    const q: any = {
      select: () => q,
      eq: (c: string, v: any) => { if (upd) { if (updateFails) throw new Error("Spalte fehlt"); marks.push({ table: name, id: v, ...upd }); } rows = rows.filter((r) => r[c] === v); return q; },
      in: (c: string, vs: any[]) => { rows = rows.filter((r) => vs.includes(r[c])); return q; },
      update: (v: any) => { upd = v; return q; },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      delete: () => ({ eq: async (_c: string, v: any) => { deleted.push(v); return { error: null }; } }),
      then: (res: any) => res({ data: rows, error: null }),
    };
    return q;
  };
  const rpc = async () => ({ data: null, error: { message: "fehlt" } });
  return { from, rpc, marks, deleted, auth: { getUser: async () => ({ data: null, error: { message: "x" } }) } };
}
const T = {
  push_config: [{ key: "vapid_public", value: "PUB" }, { key: "vapid_private", value: "PRIV" }, { key: "hook_secret", value: "g" }, { key: "site_url", value: "https://h.test" }],
  egg_orders: [{ id: "o1", project_id: "p1", buyer: "Klieber", qty: 6, status: "offen", waited: false }],
  project_members: [{ project_id: "p1", family_id: "fa", families: { user_id: "uA" } }, { project_id: "p1", family_id: "fb", families: { user_id: "uB" } }],
  families: [{ id: "fa", user_id: "uA" }, { id: "fb", user_id: "uB" }],
  push_subscriptions: [{ id: "s1", user_id: "uA", endpoint: "ok" }, { id: "s2", user_id: "uB", endpoint: "kaputt" }, { id: "s3", user_id: "uB", endpoint: "weg" }],
  push_prefs: [] as Row[],
};
const wp = {
  setVapidDetails() {},
  async sendNotification(sub: any) {
    if (sub.endpoint === "kaputt") throw Object.assign(new Error("x"), { statusCode: 500 });
    if (sub.endpoint === "weg") throw Object.assign(new Error("x"), { statusCode: 410 });
    return { statusCode: 201 };
  },
};
const call = async (db: any) => {
  const r = await makeHandler({ admin: db, webpush: wp as any, siteUrl: "x" })(new Request("https://x", { method: "POST", headers: { "x-hook-secret": "g" }, body: JSON.stringify({ order_id: "o1" }) }));
  return await r.json();
};
let db = fakeDb(T);
let j = await call(db);
const m = Object.fromEntries(db.marks.map((x: any) => [x.id, [x.last_push_ok, x.last_push_status, typeof x.last_push_at]]));
eq(m, { s1: [true, 201, "string"], s2: [false, 500, "string"] }, "angekommen und fehlgeschlagen werden je Gerät gemerkt");
eq(db.deleted, ["s3"], "abgemeldetes Gerät (410) wird gelöscht, nicht gemerkt");
eq([j.sent, j.failed, j.gone], [1, 1, 1], "Zählung wie vorher");
db = fakeDb(T, true);
j = await call(db);
eq([j.sent, j.failed, j.gone], [1, 1, 1], "fehlen die neuen Spalten, läuft der Versand trotzdem");
console.log(`\nalle ${n} Tests bestanden`);
