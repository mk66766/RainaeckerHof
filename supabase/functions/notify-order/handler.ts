// Edge Function „notify-order“: verschickt Push-Nachrichten.
// Wege:
//  1) Datenbank-Auslöser bei neuer Bestellung: Header x-hook-secret + {order_id}
//  2) Zeitplan der Datenbank: Header x-hook-secret + {reminders:true}
//  3) Test aus der App: angemeldeter Nutzer (JWT), Body {test:true}
//  5) Zeitplan der Datenbank: Header x-hook-secret + {queue:true} (Warteliste: Bestellungen, die jetzt raus können)
//  4) Admin-Tab: angemeldeter Admin (JWT), Body {admin:"message"|"notice"|"preview", ...}
import { berlinNow, buildReminders, mergePerUser, type Now } from "./reminders.ts";
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
    let payload: Payload;
    const hook = req.headers.get("x-hook-secret");

    if (hook !== null) {
      if (!cfg.hook_secret || !same(hook, cfg.hook_secret)) return json({ error: "nicht erlaubt" }, 401);
      if (body?.reminders === true) return await sendReminders(d, cfg, site, body?.force === true);
      if (body?.queue === true) return await sendQueue(d, cfg, site);
      const id = body?.order_id;
      if (!id) return json({ error: "order_id fehlt" }, 400);
      const { data: o } = await d.admin.from("egg_orders").select("id,project_id,buyer,qty,status,waited").eq("id", id).maybeSingle();
      if (!o) return json({ error: "Bestellung nicht gefunden" }, 404);
      const { data: mem } = await d.admin.from("project_members").select("family_id, families(user_id)").eq("project_id", o.project_id);
      userIds = (mem || []).map((m: any) => m.families?.user_id).filter(Boolean);
      const eier = `${o.qty} ${o.qty === 1 ? "Ei" : "Eier"}`;
      payload = o.waited ? {
        title: "Bestellung wartet",
        body: `${o.buyer} möchte ${eier}, gerade ist nichts frei. Hast du welche übrig?`,
        url: `${site}/#bestellungen`,
        tag: `bestellung-${o.id}`,
      } : {
        title: "Neue Bestellung",
        body: `${o.buyer}: ${eier}`,
        url: `${site}/#bestellungen`,
        tag: `bestellung-${o.id}`,
      };
    } else if (body?.test === true) {
      const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      const { data: u, error: ue } = jwt ? await d.admin.auth.getUser(jwt) : { data: null, error: true };
      if (ue || !u?.user) return json({ error: "nicht angemeldet" }, 401);
      userIds = [u.user.id];
      payload = { title: "Test erfolgreich", body: "So sehen Benachrichtigungen vom Rainäcker Hof aus.", url: `${site}/`, tag: "test" };
    } else if (typeof body?.admin === "string") {
      return await adminAction(d, cfg, site, req, body);
    } else {
      return json({ error: "nicht erlaubt" }, 401);
    }

    try { return json(await sendTo(d, cfg, site, userIds, () => payload, { TTL: 86400, urgency: "high" })); }
    catch (e: any) { return json({ error: e?.message || "Fehler" }, 500); }
  };
}

type Payload = { title: string; body: string; url: string; tag: string };

// Warteliste: Bestellungen, die jetzt in den Überschuss passen, an die Familie mit Dienst (ohne Dienst: an alle des Projekts)
async function sendQueue(d: Deps, cfg: Record<string, string>, site: string): Promise<Response> {
  const { data: ready, error } = await d.admin.rpc("take_ready_orders");
  if (error) return json({ error: "Warteliste nicht lesbar" }, 500);
  const res = { orders: (ready || []).length, sent: 0 };
  for (const o of ready || []) {
    let users: string[] = o.duty_user ? [o.duty_user] : [];
    if (!users.length) {
      const { data: mem } = await d.admin.from("project_members").select("family_id, families(user_id)").eq("project_id", o.project_id);
      users = (mem || []).map((m: any) => m.families?.user_id).filter(Boolean);
    }
    const p: Payload = { title: "Bestellung kann raus", body: `Für ${o.buyer} ${o.qty === 1 ? "ist jetzt 1 Ei" : `sind jetzt ${o.qty} Eier`} frei.`, url: `${site}/#bestellungen`, tag: `bestellung-${o.id}` };
    try { res.sent += (await sendTo(d, cfg, site, users, () => p, { TTL: 86400, urgency: "high" })).sent; } catch { /* nächste Bestellung trotzdem */ }
  }
  return json(res);
}
// Push an alle Geräte der genannten Nutzer; abgemeldete Geräte (404/410) werden gelöscht
async function sendTo(d: Deps, cfg: Record<string, string>, site: string, userIds: string[], payloadFor: (userId: string) => Payload | null, opts: any, onlyReminders = false) {
  const res = { total: 0, sent: 0, gone: 0, failed: 0 };
  if (!userIds.length) return res;
  let q = d.admin.from("push_subscriptions").select("id,user_id,endpoint,p256dh,auth").in("user_id", userIds);
  if (onlyReminders) q = q.eq("reminders", true);
  const { data: subs, error } = await q;
  if (error) throw new Error("Geräte nicht lesbar");
  if (!subs?.length) return res;
  d.webpush.setVapidDetails(site, cfg.vapid_public, cfg.vapid_private);
  res.total = subs.length;
  await Promise.all(subs.map(async (s: any) => {
    const p = payloadFor(s.user_id);
    if (!p) return;
    try {
      await d.webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(p), opts);
      res.sent++;
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) {          // Gerät hat sich abgemeldet
        await d.admin.from("push_subscriptions").delete().eq("id", s.id);
        res.gone++;
      } else { res.failed++; }
    }
  }));
  return res;
}

// Erinnerungen: wird stündlich vom Zeitplan der Datenbank gerufen und handelt nur zur eingestellten Uhrzeit (Standard 18 Uhr Berlin)
async function sendReminders(d: Deps, cfg: Record<string, string>, site: string, force: boolean): Promise<Response> {
  const now = berlinNow(d.now ? d.now() : new Date());
  const hour = Number(cfg.reminder_hour ?? 18);
  if (!force && now.hour !== hour) return json({ skipped: "nicht die Erinnerungsstunde", hour: now.hour });
  try {
    const msgs = await collectReminders(d, now);
    const res = { users: msgs.length, ...(await sendTo(d, cfg, site, msgs.map((m) => m.userId), (uid) => {
      const m = msgs.find((x) => x.userId === uid)!;
      return { title: m.title, body: m.body, url: `${site}/${m.url}`, tag: "erinnerung" };
    }, { TTL: 43200, urgency: "normal" }, true)) };
    delete (res as any).total;
    await logRun(d, "lauf", { ...res, force });
    return json(res);
  } catch (e: any) {
    await logRun(d, "fehler", { error: String(e?.message || e), force });
    return json({ error: e?.message || "Fehler" }, 500);
  }
}

// Protokoll für den Admin-Tab (Tabelle reminder_runs); ein Fehler beim Protokollieren stoppt nichts
async function logRun(d: Deps, kind: string, result: unknown) {
  try { await d.admin.from("reminder_runs").insert({ kind, result }); } catch { /* egal */ }
}

// Erinnerungen berechnen (ohne Versand), auch für die Vorschau im Admin-Tab
async function collectReminders(d: Deps, now: Now) {
  const a = d.admin;
  const [pr, mem, fam, sw, tx, ck] = await Promise.all([
    a.from("projects").select("id,kind,name,settings"),
    a.from("project_members").select("project_id,family_id"),
    a.from("families").select("id,name,user_id,is_admin"),
    a.from("duty_swaps").select("project_id,week_start,family_id").eq("week_start", new Date(Date.parse(now.date + "T12:00:00Z") + 864e5).toISOString().slice(0, 10)),
    a.from("transactions").select("id,project_id,date,amount,pay_state,seller_id,parent_id").in("pay_state", ["bar_offen", "pruefen"]),
    a.from("cash_checks").select("project_id,created_at").order("created_at", { ascending: false }),
  ]);
  for (const r of [pr, mem, fam, sw, tx, ck]) if (r.error) throw new Error("Daten nicht lesbar");
  const parents = tx.data || [];
  const kids = parents.length ? (await a.from("transactions").select("id,project_id,date,amount,pay_state,seller_id,parent_id").in("parent_id", parents.map((t: any) => t.id))).data || [] : [];
  // sonntags die Eier der Woche für den Wochenrückblick
  const eggs = now.weekday === 0 ? (await a.from("egg_log").select("project_id,date,type,n,price").gte("date", new Date(Date.parse(now.date + "T12:00:00Z") - 6 * 864e5).toISOString().slice(0, 10)).lte("date", now.date)).data || [] : [];
  const items = buildReminders({ projects: pr.data || [], members: mem.data || [], families: fam.data || [], swaps: sw.data || [], tx: [...parents, ...kids], checks: ck.data || [], eggs }, now);
  const msgs = mergePerUser(items);
  return msgs.map((m) => ({ ...m, name: (fam.data || []).find((f: any) => f.user_id === m.userId)?.name || "?" }));
}

// Aktionen aus dem Admin-Tab (nur angemeldete Admins)
async function adminAction(d: Deps, cfg: Record<string, string>, site: string, req: Request, body: any): Promise<Response> {
  const a = d.admin;
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: u, error: ue } = jwt ? await a.auth.getUser(jwt) : { data: null, error: true };
  if (ue || !u?.user) return json({ error: "nicht angemeldet" }, 401);
  const { data: fams, error: fe } = await a.from("families").select("id,name,user_id,is_admin,left_on");
  if (fe) return json({ error: "Daten nicht lesbar" }, 500);
  const me = (fams || []).find((f: any) => f.user_id === u.user.id);
  if (!me || !me.is_admin || me.left_on) return json({ error: "nur für den Admin" }, 403);
  try {
    if (body.admin === "message") {                 // freie Nachricht an eine Familie (z. B. um Push zu testen)
      const t = (fams || []).find((f: any) => f.id === body.family_id && !f.left_on);
      if (!t?.user_id) return json({ error: "Familie nicht gefunden" }, 404);
      const text = String(body.text || "").trim().slice(0, 300);
      if (!text) return json({ error: "Bitte einen Text eingeben" }, 400);
      return json(await sendTo(d, cfg, site, [t.user_id], () => ({ title: "Nachricht vom Admin", body: text, url: `${site}/`, tag: "admin-nachricht" }), { TTL: 86400, urgency: "high" }));
    }
    if (body.admin === "notice") {                  // Hinweis an alle Familien eines Projekts (Text steht in settings.notice)
      const { data: p } = await a.from("projects").select("id,kind,settings").eq("id", body.project_id).maybeSingle();
      const text = String(p?.settings?.notice?.text || "").trim();
      if (!p || !text) return json({ error: "Kein Hinweis gespeichert" }, 400);
      const { data: mem } = await a.from("project_members").select("family_id").eq("project_id", p.id);
      const uids = (mem || []).map((m: any) => (fams || []).find((f: any) => f.id === m.family_id && !f.left_on)?.user_id).filter(Boolean);
      return json(await sendTo(d, cfg, site, uids, () => ({ title: `Hinweis (${p.kind === "goats" ? "Ziegen" : "Hühner"})`, body: text.slice(0, 300), url: `${site}/#hinweis:${p.kind}`, tag: `hinweis-${p.id}` }), { TTL: 86400, urgency: "normal" }));
    }
    if (body.admin === "preview") {                 // Vorschau der Erinnerungen für einen Tag, auf Wunsch nur an den Admin senden
      const date = /^\d{4}-\d\d-\d\d$/.test(String(body.date || "")) ? String(body.date) : berlinNow(d.now ? d.now() : new Date()).date;
      const dt = new Date(date + "T12:00:00Z");
      const now: Now = { date, weekday: dt.getUTCDay(), day: dt.getUTCDate() };
      const msgs = await collectReminders(d, now);
      const out: any = { date, messages: msgs.map((m) => ({ name: m.name, title: m.title, body: m.body })) };
      if (body.send === true && msgs.length) {
        let i = 0;
        const all = await Promise.all(msgs.map((m) => sendTo(d, cfg, site, [u.user.id], () => ({ title: `Vorschau für ${m.name}: ${m.title}`, body: m.body, url: `${site}/${m.url}`, tag: `vorschau-${i++}` }), { TTL: 3600, urgency: "normal" })));
        out.sent = all.reduce((s, r) => s + r.sent, 0);
        out.total = all.length ? all[0].total : 0;
      }
      return json(out);
    }
  } catch (e: any) {
    return json({ error: e?.message || "Fehler" }, 500);
  }
  return json({ error: "Unbekannte Aktion" }, 400);
}
