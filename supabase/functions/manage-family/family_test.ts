import { makeFamilyHandler, toSlug } from "./family.ts";
let gut = 0, n = 0;
const eq = (a: any, b: any, msg: string) => { n++; if (JSON.stringify(a) !== JSON.stringify(b)) { console.log("FEHLER:", msg, "| erwartet", JSON.stringify(b), "| war", JSON.stringify(a)); Deno.exit(1); } gut++; console.log("OK  ", msg); };

type Row = Record<string, any>;
function world(opts: { failInsert?: string[]; banFails?: boolean; extraFams?: Row[] } = {}) {
  const db: Record<string, Row[]> = {
    families: [
      { id: "A", name: "Bader", user_id: "uA", is_admin: true, is_system: false, left_on: null },
      { id: "B", name: "Hatesaul", user_id: "uB", is_admin: false, left_on: null },
      { id: "C", name: "Kaufmann", user_id: "uC", is_admin: true, left_on: null },
      { id: "X", name: "Alt", user_id: "uX", is_admin: true, left_on: "2025-01-01" },
      ...(opts.extraFams || []),
    ],
    projects: [{ id: "h", kind: "hens", name: "Hühner" }, { id: "g", kind: "goats", name: "Ziegen" }],
    project_members: [{ project_id: "h", family_id: "A" }, { project_id: "h", family_id: "B" }, { project_id: "h", family_id: "C" }, { project_id: "g", family_id: "B" }, { project_id: "g", family_id: "C" }],
    audit_log: [],
    family_codes: [],
  };
  const tokens: Record<string, string> = { jA: "uA", jB: "uB", jC: "uC", jX: "uX", jN: "u100" };
  const log = { created: [] as any[], updated: [] as any[], deleted: [] as string[], killed: [] as string[], emails: new Set<string>(["bader@huehner.local"]) };
  const from = (t: string) => ({
    select: () => Promise.resolve({ data: (db[t] || []).map((r) => ({ ...r })), error: null }),
    upsert: async (row: Row) => { db[t] = db[t].filter((r) => r.family_id !== row.family_id); db[t].push({ ...row }); return { error: null }; },
    insert: async (rows: Row | Row[]) => { if (opts.failInsert?.includes(t)) return { error: { message: "x" } }; (Array.isArray(rows) ? rows : [rows]).forEach((r) => db[t].push({ ...r })); return { error: null }; },
    update: (vals: Row) => ({ eq: async (c: string, v: any) => { db[t].filter((r) => r[c] === v).forEach((r) => Object.assign(r, vals)); return { error: null }; } }),
    delete: () => { const f: [string, any][] = []; const b: any = { eq: (c: string, v: any) => { f.push([c, v]); return b; }, then: (res: any) => { db[t] = db[t].filter((r) => !f.every(([c, v]) => r[c] === v)); res({ error: null }); } }; return b; },
  });
  const admin = {
    from,
    auth: {
      getUser: async (jwt: string) => tokens[jwt] ? { data: { user: { id: tokens[jwt] } }, error: null } : { data: null, error: { message: "bad" } },
      admin: {
        createUser: async (x: any) => { if (log.emails.has(x.email)) return { data: null, error: { message: "exists" } }; log.emails.add(x.email); const id = "u" + (log.created.length + 100); log.created.push({ id, ...x }); return { data: { user: { id } }, error: null }; },
        updateUserById: async (id: string, attrs: any) => { log.updated.push({ id, attrs }); return opts.banFails && attrs.ban_duration ? { error: { message: "x" } } : { error: null }; },
        deleteUser: async (id: string) => { log.deleted.push(id); return { error: null }; },
      },
    },
    rpc: async (fn: string, args: any) => { if (fn === "kill_sessions") log.killed.push(args.uid); return { error: null }; },
  };
  const h = makeFamilyHandler({ admin, today: () => "2026-10-26", uuid: () => "NEU1" });
  const call = async (body: any, jwt = "jC") => { const r = await h(new Request("https://x/fn", { method: "POST", headers: { "content-type": "application/json", ...(jwt ? { authorization: "Bearer " + jwt } : {}) }, body: JSON.stringify(body) })); return { s: r.status, j: await r.json() }; };
  return { db, log, call, h };
}

eq(toSlug("Müller"), "mueller", "Anmeldename: Umlaute werden umgeschrieben");
eq([toSlug("Familie Meier-Huber"), toSlug("Élodie Öz"), toSlug("Straße")], ["familiemeierhuber", "elodieoez", "strasse"], "Anmeldename: Leerzeichen, Striche, Akzente, ß");

// --- Zugang
let w = world();
eq((await w.h(new Request("https://x", { method: "OPTIONS" }))).status, 204, "Vorabfrage des Browsers (CORS)");
eq((await w.h(new Request("https://x", { method: "GET" }))).status, 405, "GET abgelehnt");
eq((await w.call({ action: "add" }, "")).s, 401, "ohne Anmeldung: 401");
eq((await w.call({ action: "add" }, "falsch")).s, 401, "ungültige Anmeldung: 401");
eq((await w.call({ action: "add", name: "Neu", code: "123456", project_ids: ["h"] }, "jB")).s, 403, "angemeldet, aber kein Verwalter: 403");
eq((await w.call({ action: "add", name: "Neu", code: "123456", project_ids: ["h"] }, "jX")).s, 403, "ausgetretene Familie: 403");
eq(w.log.created.length + w.db.families.length, 0 + 4, "  dabei wurde nichts angelegt");

// --- Aufnehmen
w = world();
let r = await w.call({ action: "add", name: "  Müller ", code: "123456", project_ids: ["h", "g"], is_admin: true });
eq([r.s, r.j.family.email, r.j.family.name], [200, "mueller@huehner.local", "Müller"], "Familie aufnehmen: Name bereinigt, Anmeldename mueller");
eq(w.log.created.map((c) => [c.email, c.password, c.email_confirm]), [["mueller@huehner.local", "123456", true]], "  Login mit dem 6-stelligen Code, ohne Bestätigungsmail");
eq(w.db.families.find((f) => f.name === "Müller"), { id: "NEU1", name: "Müller", user_id: "u100", is_admin: true, is_system: false }, "  Familie mit Verwalter-Recht angelegt");
eq(w.db.project_members.filter((m) => m.family_id === "NEU1").map((m) => m.project_id).sort(), ["g", "h"], "  in beide Projekte aufgenommen");
eq([r.j.code_saved, w.db.family_codes.map((c) => [c.family_id, c.code])], [true, [["NEU1", "123456"]]], "  Code für den Admin aufgehoben");
eq(w.db.audit_log.map((a) => [a.project_id, a.table_name, a.family_name, a.new_data.name, a.new_data.projekte]), [["h", "families", "Kaufmann", "Müller", "Hühner, Ziegen"], ["g", "families", "Kaufmann", "Müller", "Hühner, Ziegen"]], "  Eintrag im Änderungsprotokoll je Projekt");
eq(JSON.stringify(w.db.audit_log).includes("123456"), false, "  der Code steht nirgends im Protokoll");
r = await w.call({ action: "add", name: "Nurhühner", code: "654321", project_ids: ["h"] });
eq([r.s, w.db.families.find((f) => f.name === "Nurhühner")!.is_admin], [200, false], "ohne Haken ist die neue Familie kein Verwalter");

// --- Aufnehmen: Fehler
w = world();
for (const [body, status, text] of [
  [{ name: "A", code: "123456", project_ids: ["h"] }, 400, "Name zu kurz"],
  [{ name: "<b>x</b>", code: "123456", project_ids: ["h"] }, 400, "Name mit Sonderzeichen"],
  [{ name: "Neu", code: "12345", project_ids: ["h"] }, 400, "Code zu kurz"],
  [{ name: "Neu", code: "abcdef", project_ids: ["h"] }, 400, "Code mit Buchstaben"],
  [{ name: "Neu", code: "1234567", project_ids: ["h"] }, 400, "Code zu lang"],
  [{ name: "Neu", code: "123456", project_ids: [] }, 400, "kein Projekt"],
  [{ name: "Neu", code: "123456", project_ids: ["zzz"] }, 400, "unbekanntes Projekt"],
  [{ name: "bader", code: "123456", project_ids: ["h"] }, 409, "Name schon vergeben (Groß/Klein egal)"],
] as any[]) { const x = await w.call({ action: "add", ...body }); eq(x.s, status, "Aufnehmen abgelehnt: " + text); }
eq([w.log.created.length, w.db.families.length], [0, 4], "  nach allen Fehlern wurde nichts angelegt");
w = world({ extraFams: [] }); w.log.emails.add("mueller@huehner.local");
r = await w.call({ action: "add", name: "Müller", code: "123456", project_ids: ["h"] });
eq([r.s, w.db.families.length], [409, 4], "Anmeldename schon belegt: 409, keine halb angelegte Familie");
w = world({ failInsert: ["families"] }); r = await w.call({ action: "add", name: "Neu", code: "123456", project_ids: ["h"] });
eq([r.s, w.log.deleted, w.db.families.length], [500, ["u100"], 4], "Fehler beim Speichern der Familie: Login wird wieder gelöscht");
w = world({ failInsert: ["project_members"] }); r = await w.call({ action: "add", name: "Neu", code: "123456", project_ids: ["h"] });
eq([r.s, w.log.deleted, w.db.families.some((f) => f.name === "Neu"), w.db.project_members.length], [500, ["u100"], false, 5], "Fehler bei der Mitgliedschaft: Familie und Login werden zurückgenommen");

// --- Zugangscode ändern
w = world();
r = await w.call({ action: "reset_code", family_id: "B", code: "246810" });
eq([r.s, w.log.updated], [200, [{ id: "uB", attrs: { password: "246810" } }]], "Code ändern: neues Passwort gesetzt");
eq(JSON.stringify(w.db.audit_log).includes("246810"), false, "  der neue Code steht nicht im Protokoll");
eq(w.db.audit_log.length > 0 && w.db.audit_log[0].new_data.zugang.includes("Hatesaul"), true, "  aber dass er geändert wurde");
eq([r.j.code_saved, w.db.family_codes.filter((c) => c.family_id === "B").map((c) => c.code)], [true, ["246810"]], "  neuer Code für den Admin aufgehoben");
r = await w.call({ action: "reset_code", family_id: "B", code: "135790" });
eq(w.db.family_codes.filter((c) => c.family_id === "B").map((c) => c.code), ["135790"], "  nochmal ändern: alter Code wird ersetzt");
eq((await w.call({ action: "reset_code", family_id: "B", code: "12ab56" })).s, 400, "Code mit Buchstaben abgelehnt");
eq((await w.call({ action: "reset_code", family_id: "ZZ", code: "123456" })).s, 404, "unbekannte Familie: 404");
eq((await w.call({ action: "reset_code", family_id: "X", code: "123456" })).s, 409, "ausgetretene Familie: 409");

// --- Projekte zuteilen
w = world();
r = await w.call({ action: "set_projects", family_id: "B", project_ids: ["h"] });
eq([r.s, w.db.project_members.filter((m) => m.family_id === "B").map((m) => m.project_id)], [200, ["h"]], "Hatesaul aus den Ziegen nehmen: bleibt bei den Hühnern");
r = await w.call({ action: "set_projects", family_id: "B", project_ids: ["h", "g"] });
eq(w.db.project_members.filter((m) => m.family_id === "B").map((m) => m.project_id).sort(), ["g", "h"], "und wieder in die Ziegen aufnehmen");
eq([w.db.audit_log.at(-1)!.old_data.projekte, w.db.audit_log.at(-1)!.new_data.projekte], ["Hühner", "Hühner, Ziegen"], "  Protokoll nennt vorher und nachher");
eq((await w.call({ action: "set_projects", family_id: "B", project_ids: ["zzz"] })).s, 400, "unbekanntes Projekt abgelehnt");

// --- Entfernen
w = world();
r = await w.call({ action: "remove", family_id: "B" });
eq([r.s, r.j.banned, r.j.sessions_closed], [200, true, true], "Familie entfernen: Login gesperrt, Sitzungen beendet");
eq(w.db.project_members.filter((m) => m.family_id === "B").length, 0, "  alle Mitgliedschaften weg");
eq(w.db.families.find((f) => f.id === "B"), { id: "B", name: "Hatesaul", user_id: "uB", is_admin: false, left_on: "2026-10-26" }, "  Familie bleibt für die Historie, mit Austrittsdatum");
eq(w.log.updated, [{ id: "uB", attrs: { ban_duration: "876000h" } }], "  Login dauerhaft gesperrt");
eq(w.log.killed, ["uB"], "  bestehende Anmeldungen beendet");
eq(w.db.audit_log.map((a) => a.project_id).sort(), ["g", "h"], "  Protokoll in beiden bisherigen Projekten");
eq(w.db.project_members.length, 3, "  die anderen Familien bleiben unberührt");
eq((await w.call({ action: "remove", family_id: "B" })).s, 409, "nochmals entfernen: 409");
eq((await w.call({ action: "remove", family_id: "C" })).s, 400, "sich selbst entfernen: abgelehnt");
eq((await w.call({ action: "remove", family_id: "ZZ" })).s, 404, "unbekannte Familie: 404");
eq(w.db.families.find((f) => f.id === "C")!.left_on, null, "  die eigene Familie ist unverändert");
w = world({ banFails: true }); r = await w.call({ action: "remove", family_id: "B" });
eq([r.s, r.j.banned], [200, false], "Sperre schlägt fehl: Antwort sagt es ehrlich (banned false)");

// --- Admin-Konto (keine Familie)
w = world();
r = await w.call({ action: "add", name: "Admin", code: "135790", account: "admin", project_ids: [] });
eq([r.s, r.j.family.email, r.j.family.admin_account], [200, "admin@huehner.local", true], "Admin-Konto anlegen: eigener Anmeldename, ohne Projekte angeben");
eq(w.db.families.find((f) => f.name === "Admin"), { id: "NEU1", name: "Admin", user_id: "u100", is_admin: true, is_system: true }, "  als Verwalter und als Admin-Konto (keine Familie) gespeichert");
eq(w.db.project_members.filter((m) => m.family_id === "NEU1").map((m) => m.project_id).sort(), ["g", "h"], "  automatisch in allen Projekten sichtbar");
eq(w.db.audit_log[0].new_data.name, "Admin (Admin-Konto)", "  Protokoll nennt es Admin-Konto");
r = await w.call({ action: "add", name: "Familie Neu", code: "135790", project_ids: ["h"], account: "familie" });
eq(w.db.families.find((f) => f.name === "Familie Neu")!.is_system, false, "normale Familie bleibt keine Admin-Konto");
// --- Verwalter-Recht vergeben und entziehen
w = world();
eq((await w.call({ action: "set_admin", family_id: "A", is_admin: false }, "jC")).s, 200, "Verwalter-Recht entziehen, solange ein anderer Verwalter bleibt");
eq(w.db.families.find((f) => f.id === "A")!.is_admin, false, "  Bader ist kein Verwalter mehr");
eq(w.db.audit_log.at(-1)!.new_data, { name: "Bader", is_admin: false }, "  im Protokoll");
r = await w.call({ action: "set_admin", family_id: "C", is_admin: false }, "jC");
eq([r.s, r.j.error], [400, "Es muss mindestens ein Verwalter bleiben."], "dem letzten Verwalter das Recht entziehen: abgelehnt");
eq(w.db.families.find((f) => f.id === "C")!.is_admin, true, "  Kaufmann bleibt Verwalter");
eq((await w.call({ action: "set_admin", family_id: "B", is_admin: true }, "jC")).s, 200, "Verwalter-Recht vergeben");
eq((await w.call({ action: "set_admin", family_id: "B", is_admin: "ja" }, "jC")).s, 400, "unklare Angabe abgelehnt");
eq((await w.call({ action: "set_admin", family_id: "B", is_admin: true }, "jB")).s, 200, "Hatesaul ist jetzt selbst Verwalter und darf es");
w = world(); await w.call({ action: "add", name: "Admin", code: "135790", account: "admin", project_ids: [] });
eq((await w.call({ action: "set_admin", family_id: "NEU1", is_admin: false }, "jC")).s, 400, "Admin-Konto: Verwalter-Recht nicht entziehbar");
eq((await w.call({ action: "set_admin", family_id: "C", is_admin: false }, "jC")).s, 200, "mit Admin-Konto darf Kaufmann sein Recht abgeben");
eq((await w.call({ action: "set_projects", family_id: "B", project_ids: ["h"] }, "jC")).s, 403, "nach Entzug ist Kaufmann kein Verwalter mehr: weitere Aktionen abgelehnt");
eq((await world().call({ action: "tu_was" })).s, 400, "unbekannte Aktion: 400");
// Admin-Konto handelt selbst
w = world(); await w.call({ action: "add", name: "Admin", code: "135790", account: "admin", project_ids: [] });
await w.call({ action: "set_admin", family_id: "C", is_admin: false }, "jC");
r = await w.call({ action: "add", name: "Neu", code: "111111", project_ids: ["h"] }, "jN");
eq(r.s, 200, "das Admin-Konto kann nach dem Entzug bei Kaufmann Familien aufnehmen");
eq((await w.call({ action: "remove", family_id: "NEU1" }, "jN")).s, 400, "und sich nicht selbst entfernen");
// --- aufgehobene Codes beim Entfernen
w = world();
await w.call({ action: "reset_code", family_id: "B", code: "246810" });
eq(w.db.family_codes.length, 1, "Code von Hatesaul aufgehoben");
await w.call({ action: "remove", family_id: "B" });
eq(w.db.family_codes.length, 0, "  beim Entfernen wird der aufgehobene Code gelöscht");
console.log(`\n${gut} von ${n} Prüfungen bestanden`);
