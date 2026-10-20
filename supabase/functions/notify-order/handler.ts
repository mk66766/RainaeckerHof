// Edge Function „notify-order“: verschickt Push-Nachrichten.
// Zwei Wege:
//  1) Datenbank-Auslöser bei neuer Bestellung: Header x-hook-secret + {order_id}
//  2) Test aus der App: angemeldeter Nutzer (JWT), Body {test:true}
import { berlinNow, buildReminders, mergePerUser } from "./reminders.ts";
export type Deps = {
  admin: any;                                   // Supabase-Client mit Service-Schlüssel
  webpush: { setVapidDetails: (s: string, pub: string, priv: string) => void; sendNotification: (sub: any, payload: string, opts?: any) => Promise<any> };
  siteUrl: string;
  now?: () => Date;                             // für Tests: feste Uhrzeit
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

function same(a: string, b: string): boolean {      // Vergleich in konstanter Zeit
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export function makeHandler(d: Deps) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method !== "POST") return json({ error: "POST erwartet" }, 405);

    const { data: rows, error: cfgErr } = await d.admin.from("push_config").select("key,value");
    if (cfgErr || !rows) return json({ error: "Konfiguration nicht lesbar" }, 500);
    const cfg: Record<string, string> = Object.fromEntries(rows.map((r: any) => [r.key, r.value]));
    if (!cfg.vapid_public || !cfg.vapid_private) return json({ error: "VAPID-Schlüssel fehlen" }, 500);
    const site = cfg.site_url || d.siteUrl;

    let body: any = {};
    try { body = await req.json(); } catch { /* leerer Body */ }

    let userIds: string[] = [];
    let payload: { title: string; body: string; url: string; tag: string };
    const hook = req.headers.get("x-hook-secret");

    if (hook !== null) {
      if (!cfg.hook_secret || !same(hook, cfg.hook_secret)) return json({ error: "nicht erlaubt" }, 401);
      if (body?.reminders === true) return await sendReminders(d, cfg, site, body?.force === true);
      const id = body?.order_id;
      if (!id) return json({ error: "order_id fehlt" }, 400);
      const { data: o } = await d.admin.from("egg_orders").select("id,project_id,buyer,qty,status").eq("id", id).maybeSingle();
      if (!o) return json({ error: "Bestellung nicht gefunden" }, 404);
      const { data: mem } = await d.admin.from("project_members").select("family_id, families(user_id)").eq("project_id", o.project_id);
      userIds = (mem || []).map((m: any) => m.families?.user_id).filter(Boolean);
      payload = {
        title: "Neue Bestellung",
        body: `${o.buyer}: ${o.qty} ${o.qty === 1 ? "Ei" : "Eier"}`,
        url: `${site}/#bestellungen`,
        tag: `bestellung-${o.id}`,
      };
    } else if (body?.test === true) {
      const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      const { data: u, error: ue } = jwt ? await d.admin.auth.getUser(jwt) : { data: null, error: true };
      if (ue || !u?.user) return json({ error: "nicht angemeldet" }, 401);
      userIds = [u.user.id];
      payload = { title: "Test erfolgreich", body: "So sehen Benachrichtigungen vom Rainäcker Hof aus.", url: `${site}/`, tag: "test" };
    } else {
      return json({ error: "nicht erlaubt" }, 401);
    }

    if (!userIds.length) return json({ total: 0, sent: 0, gone: 0, failed: 0 });
    const { data: subs, error: subErr } = await d.admin.from("push_subscriptions").select("id,endpoint,p256dh,auth").in("user_id", userIds);
    if (subErr) return json({ error: "Geräte nicht lesbar" }, 500);
    if (!subs?.length) return json({ total: 0, sent: 0, gone: 0, failed: 0 });

    d.webpush.setVapidDetails(site, cfg.vapid_public, cfg.vapid_private);
    const text = JSON.stringify(payload);
    let sent = 0, gone = 0, failed = 0;
    await Promise.all(subs.map(async (s: any) => {
      try {
        await d.webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, text, { TTL: 86400, urgency: "high" });
        sent++;
      } catch (e: any) {
        if (e?.statusCode === 404 || e?.statusCode === 410) {          // Gerät hat sich abgemeldet
          await d.admin.from("push_subscriptions").delete().eq("id", s.id);
          gone++;
        } else { failed++; }
      }
    }));
    return json({ total: subs.length, sent, gone, failed });
  };
}

// Erinnerungen: wird stündlich vom Zeitplan der Datenbank gerufen und handelt nur zur eingestellten Uhrzeit (Standard 18 Uhr Berlin)
async function sendReminders(d: Deps, cfg: Record<string, string>, site: string, force: boolean): Promise<Response> {
  const now = berlinNow(d.now ? d.now() : new Date());
  const hour = Number(cfg.reminder_hour ?? 18);
  if (!force && now.hour !== hour) return json({ skipped: "nicht die Erinnerungsstunde", hour: now.hour });
  const a = d.admin;
  const [pr, mem, fam, sw, tx, ck] = await Promise.all([
    a.from("projects").select("id,kind,name,settings"),
    a.from("project_members").select("project_id,family_id"),
    a.from("families").select("id,name,user_id"),
    a.from("duty_swaps").select("project_id,week_start,family_id").eq("week_start", new Date(Date.parse(now.date + "T12:00:00Z") + 864e5).toISOString().slice(0, 10)),
    a.from("transactions").select("id,project_id,date,amount,pay_state,seller_id,parent_id").in("pay_state", ["bar_offen", "pruefen"]),
    a.from("cash_checks").select("project_id,created_at").order("created_at", { ascending: false }),
  ]);
  for (const r of [pr, mem, fam, sw, tx, ck]) if (r.error) return json({ error: "Daten nicht lesbar" }, 500);
  const parents = tx.data || [];
  const kids = parents.length ? (await a.from("transactions").select("id,project_id,date,amount,pay_state,seller_id,parent_id").in("parent_id", parents.map((t: any) => t.id))).data || [] : [];
  const items = buildReminders({ projects: pr.data || [], members: mem.data || [], families: fam.data || [], swaps: sw.data || [], tx: [...parents, ...kids], checks: ck.data || [] }, now);
  const msgs = mergePerUser(items);
  if (!msgs.length) return json({ users: 0, sent: 0, gone: 0, failed: 0 });
  const { data: subs, error } = await a.from("push_subscriptions").select("id,user_id,endpoint,p256dh,auth").in("user_id", msgs.map((m) => m.userId)).eq("reminders", true);
  if (error) return json({ error: "Geräte nicht lesbar" }, 500);
  d.webpush.setVapidDetails(site, cfg.vapid_public, cfg.vapid_private);
  let sent = 0, gone = 0, failed = 0;
  await Promise.all((subs || []).map(async (s: any) => {
    const m = msgs.find((x) => x.userId === s.user_id)!;
    try {
      await d.webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify({ title: m.title, body: m.body, url: `${site}/${m.url}`, tag: "erinnerung" }), { TTL: 43200, urgency: "normal" });
      sent++;
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) { await a.from("push_subscriptions").delete().eq("id", s.id); gone++; } else failed++;
    }
  }));
  return json({ users: msgs.length, sent, gone, failed });
}
