// Edge Function „manage-family“: Familien aufnehmen, Zugangscode ändern, Projekte zuteilen, Familie entfernen.
// Nur für angemeldete Verwalter (is_admin). Es wird nie etwas gelöscht: Austritt = Mitgliedschaften weg + Login gesperrt.
export type Deps = {
  admin: any;                       // Supabase-Client mit Service-Schlüssel
  today?: () => string;             // für Tests: Datum JJJJ-MM-TT (Berlin)
  uuid?: () => string;
};
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const fail = (msg: string, status = 400) => json({ error: msg }, status);

export const toSlug = (name: string) =>
  name.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
const berlinToday = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" }).format(new Date());
const NAME_RE = /^[\p{L}][\p{L}\p{N} .'-]{1,29}$/u;
const CODE_RE = /^\d{6}$/;

export function makeFamilyHandler(d: Deps) {
  const a = d.admin, today = () => (d.today ? d.today() : berlinToday()), uuid = d.uuid || (() => crypto.randomUUID());
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method !== "POST") return fail("POST erwartet", 405);

    // 1) Anmeldung prüfen und feststellen, ob die Person Verwalter ist
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u, error: ue } = jwt ? await a.auth.getUser(jwt) : { data: null, error: true };
    if (ue || !u?.user) return fail("nicht angemeldet", 401);
    const [fr, pr, mr] = await Promise.all([
      a.from("families").select("id,name,user_id,is_admin,is_system,left_on"),
      a.from("projects").select("id,kind,name"),
      a.from("project_members").select("project_id,family_id"),
    ]);
    if (fr.error || pr.error || mr.error) return fail("Daten nicht lesbar", 500);
    const fams: any[] = fr.data || [], projects: any[] = pr.data || [], members: any[] = mr.data || [];
    const me = fams.find((f) => f.user_id === u.user.id);
    if (!me || !me.is_admin || me.left_on) return fail("nur für Verwalter", 403);

    let b: any = {};
    try { b = await req.json(); } catch { return fail("ungültige Anfrage"); }
    if (!["add", "reset_code", "set_projects", "set_admin", "remove"].includes(b.action)) return fail("Unbekannte Aktion.");
    const pnames = (ids: string[]) => ids.map((id) => projects.find((p) => p.id === id)?.name || "?").join(", ");
    const myProjects = (fid: string) => members.filter((m) => m.project_id && m.family_id === fid).map((m) => m.project_id as string);
    const validPids = (x: any): string[] | null => {
      const ids = Array.isArray(x) ? [...new Set(x.map(String))] : [];
      return ids.every((id) => projects.some((p) => p.id === id)) ? ids : null;
    };
    const audit = async (pids: string[], oldData: any, newData: any, recordId: string) => {
      if (!pids.length) return;
      await a.from("audit_log").insert(pids.map((pid) => ({ table_name: "families", action: "UPDATE", record_id: recordId, project_id: pid, changed_by: u.user.id, family_name: me.name, old_data: oldData, new_data: newData })));
    };
    const target = () => fams.find((f) => f.id === b.family_id);
    // Code für den Admin aufheben (Tabelle family_codes, nur Admins dürfen lesen; nie im Änderungsprotokoll)
    const saveCode = async (fid: string, code: string) => !(await a.from("family_codes").upsert({ family_id: fid, code, set_at: new Date().toISOString() })).error;

    // 2) Aktionen
    if (b.action === "add") {
      const name = String(b.name || "").trim().replace(/\s+/g, " ");
      if (!NAME_RE.test(name)) return fail("Bitte einen Namen mit 2 bis 30 Zeichen eingeben (Buchstaben, Ziffern, Leerzeichen).");
      if (!CODE_RE.test(String(b.code || ""))) return fail("Der Code muss aus genau 6 Ziffern bestehen.");
      const isAdminAccount = b.account === "admin";                       // Admin-Konto: keine Familie, in allen Projekten sichtbar
      const pids = isAdminAccount ? projects.map((p) => p.id) : validPids(b.project_ids);
      if (!pids || !pids.length) return fail("Bitte mindestens ein Projekt auswählen.");
      if (fams.some((f) => f.name.toLowerCase() === name.toLowerCase())) return fail("Diesen Namen gibt es schon.", 409);
      const slug = toSlug(name);
      if (!slug) return fail("Der Name enthält keine Buchstaben oder Ziffern.");
      const { data: created, error: ce } = await a.auth.admin.createUser({ email: `${slug}@huehner.local`, password: String(b.code), email_confirm: true });
      if (ce || !created?.user) return fail("Dieser Anmeldename ist schon vergeben.", 409);
      const id = uuid();
      const f1 = await a.from("families").insert({ id, name, user_id: created.user.id, is_admin: isAdminAccount || b.is_admin === true, is_system: isAdminAccount });
      if (f1.error) { await a.auth.admin.deleteUser(created.user.id); return fail("Familie konnte nicht angelegt werden.", 500); }
      const f2 = await a.from("project_members").insert(pids.map((pid) => ({ project_id: pid, family_id: id })));
      if (f2.error) { await a.from("families").delete().eq("id", id); await a.auth.admin.deleteUser(created.user.id); return fail("Familie konnte nicht angelegt werden.", 500); }
      await audit(pids, {}, { name: isAdminAccount ? `${name} (Admin-Konto)` : name, projekte: pnames(pids), is_admin: isAdminAccount || b.is_admin === true }, id);
      const codeSaved = await saveCode(id, String(b.code));
      return json({ ok: true, code_saved: codeSaved, family: { id, name, email: `${slug}@huehner.local`, admin_account: isAdminAccount } });
    }

    const t = target();
    if (!t) return fail("Familie nicht gefunden.", 404);
    if (t.left_on) return fail("Diese Familie ist schon ausgetreten.", 409);

    if (b.action === "reset_code") {
      if (!CODE_RE.test(String(b.code || ""))) return fail("Der Code muss aus genau 6 Ziffern bestehen.");
      const r = await a.auth.admin.updateUserById(t.user_id, { password: String(b.code) });
      if (r.error) return fail("Code konnte nicht geändert werden.", 500);
      await audit(myProjects(t.id), {}, { zugang: `neuer Code für ${t.name} gesetzt` }, t.id);
      return json({ ok: true, code_saved: await saveCode(t.id, String(b.code)) });
    }

    if (b.action === "set_admin") {
      if (typeof b.is_admin !== "boolean") return fail("Bitte angeben, ob die Familie Verwalter sein soll.");
      if (b.is_admin === false) {
        if (t.is_system) return fail("Admin-Konten behalten das Verwalter-Recht.");
        if (!fams.some((f) => f.id !== t.id && f.is_admin && !f.left_on)) return fail("Es muss mindestens ein Verwalter bleiben.");
      }
      if (t.is_admin === b.is_admin) return json({ ok: true, unchanged: true });
      const r = await a.from("families").update({ is_admin: b.is_admin }).eq("id", t.id);
      if (r.error) return fail("Speichern fehlgeschlagen.", 500);
      await audit(myProjects(t.id), { name: t.name, is_admin: t.is_admin }, { name: t.name, is_admin: b.is_admin }, t.id);
      return json({ ok: true });
    }

    if (b.action === "set_projects") {
      if (t.is_system) return fail("Admin-Konten sind immer in allen Projekten sichtbar.");
      const pids = validPids(b.project_ids);
      if (!pids) return fail("Unbekanntes Projekt.");
      const old = myProjects(t.id), add = pids.filter((x) => !old.includes(x)), del = old.filter((x) => !pids.includes(x));
      if (add.length) { const r = await a.from("project_members").insert(add.map((pid) => ({ project_id: pid, family_id: t.id }))); if (r.error) return fail("Speichern fehlgeschlagen.", 500); }
      for (const pid of del) { const r = await a.from("project_members").delete().eq("project_id", pid).eq("family_id", t.id); if (r.error) return fail("Speichern fehlgeschlagen.", 500); }
      await audit([...new Set([...old, ...pids])], { name: t.name, projekte: pnames(old) || "–" }, { name: t.name, projekte: pnames(pids) || "–" }, t.id);
      return json({ ok: true });
    }

    if (b.action === "remove") {
      if (t.id === me.id) return fail("Du kannst dich nicht selbst entfernen.");
      if (t.is_admin && !fams.some((f) => f.id !== t.id && f.is_admin && !f.left_on)) return fail("Es muss mindestens ein Verwalter bleiben.");
      const old = myProjects(t.id), day = today();
      const m = await a.from("project_members").delete().eq("family_id", t.id);
      if (m.error) return fail("Entfernen fehlgeschlagen.", 500);
      const f = await a.from("families").update({ left_on: day, is_admin: false }).eq("id", t.id);
      if (f.error) return fail("Entfernen fehlgeschlagen.", 500);
      const ban = await a.auth.admin.updateUserById(t.user_id, { ban_duration: "876000h" });
      const kill = await a.rpc("kill_sessions", { uid: t.user_id });
      await a.from("family_codes").delete().eq("family_id", t.id);       // gesperrter Zugang: Code wird nicht mehr gebraucht
      await audit(old, { name: t.name, projekte: pnames(old), left_on: null, login: "aktiv" }, { name: t.name, projekte: "–", left_on: day, login: "gesperrt" }, t.id);
      return json({ ok: true, banned: !ban.error, sessions_closed: !kill.error });
    }
    return fail("Unbekannte Aktion.");
  };
}
