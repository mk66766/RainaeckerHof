// Edge Function „notify-order“: verschickt Push-Nachrichten.
// Wege:
//  1) Datenbank-Auslöser bei neuer Bestellung: Header x-hook-secret + {order_id} → Familie mit Dienst „Offene Bestellung“, die anderen einmal „Neue Bestellung“
//  2) Zeitplan der Datenbank: Header x-hook-secret + {reminders:true}
//  3) Test aus der App: angemeldeter Nutzer (JWT), Body {test:true}
//  5) Zeitplan der Datenbank: Header x-hook-secret + {queue:true} (Warteliste: Bestellungen, die jetzt raus können;
//     dazu alle 2 Stunden, 8 bis 20 Uhr, eine Erinnerung an die Familie mit Dienst für jede offene bereite Bestellung)
//  4) Admin-Tab: angemeldeter Admin (JWT), Body {admin:"message"|"notice"|"preview", ...}
//  6) Türzeiten geändert: angemeldetes Mitglied (JWT), Body {door:<door_times.id>} → an die anderen Familien des Projekts
//  7) Nachricht an Familien (Tab Hof): angemeldetes Mitglied (JWT), Body {family_msg:true, project_id, to:"all"|[family_id], text}
import { berlinNow, buildReminders, mergePerUser, type Now } from "./reminders.ts";
import { dueOrders, dutyMsg, dutyWaitMsg, eggs, infoMsg, type Msg, type OpenOrder } from "./orders.ts";
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
      return await sendNewOrder(d, cfg, site, o);
    } else if (body?.test === true) {
      const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      const { data: u, error: ue } = jwt ? await d.admin.auth.getUser(jwt) : { data: null, error: true };
      if (ue || !u?.user) return json({ error: "nicht angemeldet" }, 401);
      userIds = [u.user.id];
      payload = { title: "Test erfolgreich", body: "So sehen Benachrichtigungen vom Rainäcker Hof aus.", url: `${site}/`, tag: "test" };
    } else if (typeof body?.door === "string") {
      return await sendDoor(d, cfg, site, req, body.door);
    } else if (body?.family_msg === true) {
      return await sendFamilyMsg(d, cfg, site, req, body);
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

// Nutzer, deren Familie eine Art von Nachricht im Admin-Tab („Wer bekommt was?“) ausgeschaltet hat.
// Arten: order_new, order_ready, duty, cash, pay_check, month, door. Bei einem Lesefehler gilt „nichts ausgeschaltet“.
async function usersOff(d: Deps, kind: string): Promise<Set<string>> {
  try {
    const { data: p } = await d.admin.from("push_prefs").select("family_id").eq("kind", kind).eq("enabled", false);
    const ids = (p || []).map((r: any) => r.family_id);
    if (!ids.length) return new Set();
    const { data: f } = await d.admin.from("families").select("id,user_id").in("id", ids);
    return new Set((f || []).map((r: any) => r.user_id).filter(Boolean));
  } catch { return new Set(); }
}

// Neue Bestellung: Die Familie mit Dienst bekommt „Offene Bestellung“ (bzw. „Bestellung wartet“), alle anderen einmal
// „Neue Bestellung von X – n Eier. Die diensthabende Familie kümmert sich.“ Ohne Dienst-Familie bekommen alle die Dienst-Nachricht.
// Fehlt die Datenbank-Funktion open_orders_push (Migration noch nicht eingespielt), geht wie früher „Neue Bestellung“ an alle.
async function sendNewOrder(d: Deps, cfg: Record<string, string>, site: string, o: any): Promise<Response> {
  const { data: mem } = await d.admin.from("project_members").select("family_id, families(user_id)").eq("project_id", o.project_id);
  const all: string[] = (mem || []).map((m: any) => m.families?.user_id).filter(Boolean);
  const offNew = await usersOff(d, "order_new");
  const opts = { TTL: 86400, urgency: "high" };
  const rows = await openOrders(d);
  const row = rows?.find((r) => r.id === o.id);
  const withUrl = (m: Msg): Payload => ({ title: m.title, body: m.body, url: `${site}/#bestellungen`, tag: m.tag });
  try {
    if (!row) {                                    // Rückfall: alter Ablauf
      const p = withUrl(o.waited
        ? { title: "Bestellung wartet", body: `${o.buyer} möchte ${eggs(o.qty)}, gerade ist nichts frei. Hast du welche übrig?`, tag: `bestellung-${o.id}` }
        : { title: "Neue Bestellung", body: `${o.buyer}: ${eggs(o.qty)}`, tag: `bestellung-${o.id}` });
      return json(await sendTo(d, cfg, site, all.filter((u) => !offNew.has(u)), () => p, opts));
    }
    const duty = row.duty_user && all.includes(row.duty_user) ? row.duty_user : null;
    const dutyP = withUrl(row.ready ? dutyMsg(row) : dutyWaitMsg(row));
    const offReady = await usersOff(d, "order_ready");
    const dutyUsers = (duty ? [duty] : all).filter((u) => !offReady.has(u));
    const others = duty ? all.filter((u) => u !== duty && !offNew.has(u)) : [];
    const infoP = withUrl(infoMsg(row));
    return json(await sendTo(d, cfg, site, [...dutyUsers, ...others], (u) => dutyUsers.includes(u) ? dutyP : infoP, opts));
  } catch (e: any) { return json({ error: e?.message || "Fehler" }, 500); }
}

// offene Bestellungen samt „bereit“ und Familie mit Dienst; null, wenn die Datenbank-Funktion fehlt
async function openOrders(d: Deps): Promise<OpenOrder[] | null> {
  try { const { data, error } = await d.admin.rpc("open_orders_push"); return error ? null : (data || []); } catch { return null; }
}

// Erinnerung an die Familie mit Dienst: alle 2 Stunden je offener bereiter Bestellung, nicht in der Nachtruhe (orders.ts).
// Ohne Dienst-Familie an alle des Projekts. Fehlt die Datenbank-Funktion, passiert nichts.
async function sendOrderReminders(d: Deps, cfg: Record<string, string>, site: string): Promise<{ reminded: number; sent: number } | null> {
  const rows = await openOrders(d);
  if (!rows) return null;
  const due = dueOrders(rows, d.now ? d.now() : new Date());
  const res = { reminded: due.length, sent: 0 };
  if (!due.length) return res;
  const off = await usersOff(d, "order_ready");
  for (const o of due) {
    let users: string[] = o.duty_user ? [o.duty_user] : [];
    if (!users.length) {
      const { data: mem } = await d.admin.from("project_members").select("family_id, families(user_id)").eq("project_id", o.project_id);
      users = (mem || []).map((m: any) => m.families?.user_id).filter(Boolean);
    }
    const m = dutyMsg(o);
    const p: Payload = { title: m.title, body: m.body, url: `${site}/#bestellungen`, tag: m.tag };
    try { res.sent += (await sendTo(d, cfg, site, users.filter((u) => !off.has(u)), () => p, { TTL: 7200, urgency: "high" })).sent; } catch { /* nächste Bestellung trotzdem */ }
  }
  await d.admin.from("egg_orders").update({ reminded_at: (d.now ? d.now() : new Date()).toISOString() }).in("id", due.map((o) => o.id));
  return res;
}

// Neue Türzeiten an die anderen Familien des Projekts. Der Text kommt aus dem gespeicherten Eintrag (kein freier Text),
// der Eintrag muss frisch sein (höchstens 60 Minuten alt) und der Absender Mitglied des Projekts.
export const DOOR_MAX_AGE_MIN = 60;
async function sendDoor(d: Deps, cfg: Record<string, string>, site: string, req: Request, id: string): Promise<Response> {
  const a = d.admin;
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: u, error: ue } = jwt ? await a.auth.getUser(jwt) : { data: null, error: true };
  if (ue || !u?.user) return json({ error: "nicht angemeldet" }, 401);
  const { data: row } = await a.from("door_times").select("id,project_id,opens_at,closes_at,family_id,note,created_at").eq("id", id).maybeSingle();
  if (!row) return json({ error: "Türzeiten nicht gefunden" }, 404);
  const now = d.now ? d.now() : new Date();
  if (now.getTime() - new Date(row.created_at).getTime() > DOOR_MAX_AGE_MIN * 60000) return json({ error: "Eintrag ist zu alt" }, 400);
  const { data: fams, error: fe } = await a.from("families").select("id,name,user_id,left_on");
  if (fe) return json({ error: "Daten nicht lesbar" }, 500);
  const me = (fams || []).find((f: any) => f.user_id === u.user.id && !f.left_on);
  const { data: mem } = await a.from("project_members").select("family_id").eq("project_id", row.project_id);
  const fids = (mem || []).map((m: any) => m.family_id);
  if (!me || !fids.includes(me.id)) return json({ error: "nicht erlaubt" }, 403);
  const off = await usersOff(d, "door");
  const uids = fids.filter((f: string) => f !== me.id)
    .map((f: string) => (fams || []).find((x: any) => x.id === f && !x.left_on)?.user_id)
    .filter((x: any) => x && !off.has(x));
  const hm = (t: string) => String(t || "").slice(0, 5);
  const by = (fams || []).find((f: any) => f.id === row.family_id)?.name || me.name;
  const note = String(row.note || "").trim().slice(0, 120);
  const p: Payload = {
    title: "Neue Türzeiten",
    body: `Die Tür öffnet um ${hm(row.opens_at)} Uhr und schließt um ${hm(row.closes_at)} Uhr (eingetragen von ${by})${note ? `: ${note}` : "."}`,
    url: `${site}/#dienst:hens`,
    tag: `tuer-${row.project_id}`,
  };
  try { return json(await sendTo(d, cfg, site, uids, () => p, { TTL: 86400, urgency: "normal" })); }
  catch (e: any) { return json({ error: e?.message || "Fehler" }, 500); }
}

// Nachricht einer Familie an alle oder ausgewählte Familien des Projekts (Tab Hof).
// Grenzen gegen Missbrauch: höchstens FMSG_MAX_LEN Zeichen, Absendername steht immer im Titel, eine Nachricht pro
// FMSG_GAP_SEC Sekunden und höchstens FMSG_PER_DAY in 24 Stunden je Familie (Protokoll in family_messages).
// Empfänger nur aktive Familien des Projekts, nie der Absender, keine Admin-Konten bei „alle“; Art family_msg abschaltbar.
export const FMSG_MAX_LEN = 200, FMSG_GAP_SEC = 60, FMSG_PER_DAY = 10;
async function sendFamilyMsg(d: Deps, cfg: Record<string, string>, site: string, req: Request, body: any): Promise<Response> {
  const a = d.admin;
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: u, error: ue } = jwt ? await a.auth.getUser(jwt) : { data: null, error: true };
  if (ue || !u?.user) return json({ error: "nicht angemeldet" }, 401);
  const text = String(body.text || "").replace(/\s+/g, " ").trim();
  if (!text) return json({ error: "Bitte einen Text eingeben" }, 400);
  if (text.length > FMSG_MAX_LEN) return json({ error: `Höchstens ${FMSG_MAX_LEN} Zeichen` }, 400);
  const { data: p } = await a.from("projects").select("id,kind").eq("id", body.project_id).maybeSingle();
  if (!p) return json({ error: "Projekt nicht gefunden" }, 404);
  const { data: fams, error: fe } = await a.from("families").select("id,name,user_id,left_on,is_system");
  if (fe) return json({ error: "Daten nicht lesbar" }, 500);
  const me = (fams || []).find((f: any) => f.user_id === u.user.id && !f.left_on);
  const { data: mem } = await a.from("project_members").select("family_id").eq("project_id", p.id);
  const fids: string[] = (mem || []).map((m: any) => m.family_id);
  if (!me || !fids.includes(me.id)) return json({ error: "nicht erlaubt" }, 403);
  const active = (fams || []).filter((f: any) => fids.includes(f.id) && !f.left_on && f.id !== me.id);
  let to: any[];
  if (body.to === "all") to = active.filter((f: any) => !f.is_system);
  else if (Array.isArray(body.to) && body.to.length) {
    to = active.filter((f: any) => body.to.includes(f.id));
    if (to.length !== new Set(body.to).size) return json({ error: "Empfänger nicht im Projekt" }, 400);
  } else return json({ error: "Bitte Empfänger wählen" }, 400);
  if (!to.length) return json({ error: "Keine Empfänger" }, 400);

  const now = d.now ? d.now() : new Date();
  const { data: last, error: le } = await a.from("family_messages").select("created_at").eq("from_family", me.id)
    .gte("created_at", new Date(now.getTime() - 864e5).toISOString()).order("created_at", { ascending: false });
  if (le) return json({ error: "Datenbank-Update fehlt" }, 503);
  if (last?.length && now.getTime() - new Date(last[0].created_at).getTime() < FMSG_GAP_SEC * 1000) return json({ error: "Bitte eine Minute warten" }, 429);
  if ((last?.length || 0) >= FMSG_PER_DAY) return json({ error: `Heute schon ${FMSG_PER_DAY} Nachrichten gesendet` }, 429);

  const off = await usersOff(d, "family_msg");
  const uids = to.map((f: any) => f.user_id).filter((x: any) => x && !off.has(x));
  const { data: subs } = uids.length ? await a.from("push_subscriptions").select("user_id").in("user_id", uids) : { data: [] };
  const withDev = new Set((subs || []).map((s: any) => s.user_id));
  const title = me.is_system ? "Nachricht vom Admin" : `Nachricht von ${/^familie\b/i.test(me.name) ? "" : "Familie "}${me.name}`;
  const pl: Payload = { title, body: text, url: `${site}/#hof:${p.kind}`, tag: `familie-${me.id}-${now.getTime()}` };
  try {
    const res = await sendTo(d, cfg, site, uids, () => pl, { TTL: 86400, urgency: "high" });
    await a.from("family_messages").insert({ project_id: p.id, from_family: me.id, to_families: to.map((f: any) => f.id), text, sent: res.sent });
    return json({ ...res, to: to.map((f: any) => f.name), without: to.filter((f: any) => !withDev.has(f.user_id)).map((f: any) => f.name) });
  } catch (e: any) { return json({ error: e?.message || "Fehler" }, 500); }
}

// Warteliste: Bestellungen, die jetzt in den Überschuss passen, an die Familie mit Dienst (ohne Dienst: an alle des Projekts)
async function sendQueue(d: Deps, cfg: Record<string, string>, site: string): Promise<Response> {
  const { data: ready, error } = await d.admin.rpc("take_ready_orders");
  if (error) return json({ error: "Warteliste nicht lesbar" }, 500);
  const res = { orders: (ready || []).length, sent: 0 };
  const off = await usersOff(d, "order_ready");
  for (const o of ready || []) {
    let users: string[] = o.duty_user ? [o.duty_user] : [];
    if (!users.length) {
      const { data: mem } = await d.admin.from("project_members").select("family_id, families(user_id)").eq("project_id", o.project_id);
      users = (mem || []).map((m: any) => m.families?.user_id).filter(Boolean);
    }
    users = users.filter((u) => !off.has(u));
    const p: Payload = { title: "Bestellung kann raus", body: `Für ${o.buyer} ${o.qty === 1 ? "ist jetzt 1 Ei" : `sind jetzt ${o.qty} Eier`} frei.`, url: `${site}/#bestellungen`, tag: `bestellung-${o.id}` };
    try { res.sent += (await sendTo(d, cfg, site, users, () => p, { TTL: 86400, urgency: "high" })).sent; } catch { /* nächste Bestellung trotzdem */ }
  }
  const rem = await sendOrderReminders(d, cfg, site);
  return json(rem ? { ...res, reminded: rem.reminded, sent: res.sent + rem.sent } : res);
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
  const offBy: Record<string, Set<string>> = {};
  for (const k of ["duty", "cash", "pay_check", "month"]) offBy[k] = await usersOff(d, k);
  const items = buildReminders({ projects: pr.data || [], members: mem.data || [], families: fam.data || [], swaps: sw.data || [], tx: [...parents, ...kids], checks: ck.data || [], eggs }, now);
  const msgs = mergePerUser(items.filter((i) => !offBy[i.kind]?.has(i.userId)));
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
