// SIS Bids (Tony, 2026-11-18): estimating, bids and proposals, on its own site next to SIS Tools.
// Cloudflare Worker with static assets (wrangler.jsonc): this file is the Worker, site/ holds the page files.
// It shares SIS Tools' D1 database (bind it to this project as DB) and sign-in (a Cloudflare Access app for this
// site's hostname in the same Access team: ACCESS_AUD, ACCESS_TEAM; ADMIN_EMAILS the same as SIS Tools). People and
// roles come straight from SIS Tools' tables, so nobody is set up twice.
// Tables this site owns are named bid_*, created on first use. Settings live in SIS Tools' settings table under "bids:*".
// Step 1 (this build): settings (cost codes with rates per division, payment schedules, systems, lead numbers) and the
// catalog (products, labor items, service items, packages, D-Tools catalog import).

const enc = new TextEncoder();
const SECURITY = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin", "X-Frame-Options": "SAMEORIGIN" };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...SECURITY } });
const bad = (msg, status = 400) => json({ error: msg }, status);
const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
const numOr = (v, d = 0) => { const n = typeof v === "number" ? v : parseFloat(String(v == null ? "" : v).replace(/[$,\s]/g, "")); return isFinite(n) ? n : d; };
const r2 = n => Math.round(n * 100) / 100;
const r4 = n => Math.round(n * 1e4) / 1e4;
const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
const DIVS = ["EL", "LV"];

// ---------------------------------------------------------------- sign-in (same checks as SIS Tools)
function readCookie(req, name) { const m = (req.headers.get("Cookie") || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)")); return m ? m[1] : null; }
const teamHost = env => String(env.ACCESS_TEAM).replace(/^https?:\/\//, "").replace(/\/.*$/, "");
// ACCESS_TEAM only counts when it is a team domain (yourteam.cloudflareaccess.com); a name like "SIS Tools" is ignored
const teamOn = env => !!env.ACCESS_TEAM && /^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(teamHost(env));
const b64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const certCache = {};
const devLocal = (env, url) => env.DEV_LOGIN === "1" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
async function accessEmail(req, env, url) {
  if (devLocal(env, url)) return (req.headers.get("X-Dev-Email") || decodeURIComponent(readCookie(req, "dev_email") || "") || env.DEV_EMAIL || "").toLowerCase() || null;
  const why = r => { req.signinWhy = r; return null; };
  const tok = req.headers.get("Cf-Access-Jwt-Assertion") || readCookie(req, "CF_Authorization");
  if (!env.ACCESS_AUD) return why("ACCESS_AUD isn't set on this Worker.");
  if (!tok) return why("No Cloudflare Access sign-in reached the site. The Access application probably doesn't cover this address yet: check that its domain matches this site's address exactly.");
  const [h, p, sig] = tok.split("."); if (!h || !p || !sig) return null;
  let head, body; try { head = JSON.parse(new TextDecoder().decode(b64u(h))); body = JSON.parse(new TextDecoder().decode(b64u(p))); } catch (e) { return null; }
  if (head.alg !== "RS256") return null;
  const now = Date.now() / 1000;
  if (!(body.exp > now) || (body.nbf && body.nbf > now + 60)) return why("The sign-in has expired. Reload to sign in again.");
  const aud = Array.isArray(body.aud) ? body.aud : [body.aud];
  const iss = String(body.iss || ""), team = iss.replace(/^https:\/\//, "");
  if (!aud.includes(env.ACCESS_AUD)) return why("The sign-in is for a different Access application. Copy the AUD tag from the Access app that protects THIS site's address into ACCESS_AUD.");
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(iss) && !env.ACCESS_CERTS_URL) return why("The sign-in didn't come from a Cloudflare Access team.");
  if (teamOn(env) && team !== teamHost(env)) return why(`ACCESS_TEAM is ${teamHost(env)} but the sign-in came from ${team}.`);
  const c = certCache[team] ||= { at: 0, keys: [] };
  const load = async () => { const r = await fetch(env.ACCESS_CERTS_URL || `${iss}/cdn-cgi/access/certs`); c.at = Date.now(); c.keys = (await r.json()).keys || []; };
  if (Date.now() - c.at > 3600e3) await load();
  let jwk = c.keys.find(k => k.kid === head.kid);
  if (!jwk && Date.now() - c.at > 60e3) { await load(); jwk = c.keys.find(k => k.kid === head.kid); }
  if (!jwk) return why("Couldn't check the sign-in against Cloudflare's keys.");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(sig), enc.encode(h + "." + p));
  return ok && body.email ? String(body.email).toLowerCase() : why(ok ? "The sign-in has no email address." : "The sign-in signature didn't check out.");
}

// ---------------------------------------------------------------- who is this, from SIS Tools' own records
// Level on this site: "edit" (build bids, see costs), or "none". Admins always edit; then a per-person exception or the role's
// level for tool "bids" if SIS Tools' Role permissions has one; otherwise PMs and up (Tony, 2026-11-18): the Project Manager role,
// and any role with edit on Projects or Administration. Settings: Admins, and roles with the "Manage roles" tick.
const envAdmins = env => String(env.ADMIN_EMAILS || "").toLowerCase().split(/[\s,;]+/).filter(Boolean);
async function setting(env, k) { const r = await env.DB.prepare("SELECT v FROM settings WHERE k = ?").bind(k).first().catch(() => null); return r ? parse(r.v) : null; }
const putSetting = (env, k, v) => env.DB.prepare("INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").bind(k, JSON.stringify(v)).run();
async function personOf(env, email) {
  const u = await env.DB.prepare("SELECT data FROM docs WHERE coll = 'users' AND id = ?").bind(email).first().catch(() => null);
  let rec = u ? parse(u.data) : null; if (rec && rec.deleted) rec = null;
  let name = rec && rec.name;
  if (!name) {
    const { results } = await env.DB.prepare("SELECT data FROM docs WHERE coll = 'employees'").all().catch(() => ({ results: [] }));
    for (const r of results || []) { const d = parse(r.data); if (d && !d.deleted && String(d.email || "").trim().toLowerCase() === email) { name = d.name; if (!rec) rec = { role: "viewer" }; break; } }
  }
  const nm = name || email.split("@")[0];
  if (envAdmins(env).includes(email) || (rec && rec.role === "admin")) return { email, name: nm, role: "admin", level: "edit", settings: true };
  if (!rec) return null;
  const defs = (await setting(env, "roleDefs")) || {}, ov = ((await setting(env, "toolUsers")) || {})[email] || {}, d = defs[rec.role] || {};
  const t = d.tools || {}, lvOk = v => v === "edit" || v === "view" || v === "none";
  let level = lvOk(ov.bids) ? ov.bids : lvOk(t.bids) ? t.bids : (rec.role === "pm" || t.projects === "edit" || t.admin === "edit" || ov.projects === "edit" || ov.admin === "edit") ? "edit" : "none";
  if (level === "view") level = "edit"; // one level for now: everyone allowed in builds bids and sees costs
  return { email, name: nm, role: rec.role, roleName: d.name || rec.role, level, settings: !!d.roles };
}

// ---------------------------------------------------------------- tables
let ready = false;
async function init(db) {
  if (ready) return;
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS bid_catalog (
      id INTEGER PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'product', manufacturer TEXT DEFAULT '', model TEXT NOT NULL, part_number TEXT DEFAULT '',
      catalog_no TEXT DEFAULT '', category TEXT DEFAULT '', subcategory TEXT DEFAULT '', system TEXT DEFAULT '', short_desc TEXT DEFAULT '', long_desc TEXT DEFAULT '',
      url TEXT DEFAULT '', image_url TEXT DEFAULT '', vendor TEXT DEFAULT '', msrp REAL DEFAULT 0, unit_cost REAL DEFAULT 0, unit_price REAL,
      taxable INTEGER DEFAULT 1, order_uom TEXT DEFAULT '', order_units REAL DEFAULT 1, purchase_cost REAL DEFAULT 0, cost_code TEXT DEFAULT '',
      extra TEXT DEFAULT '{}', discontinued INTEGER DEFAULT 0, source TEXT DEFAULT 'manual', updated_at TEXT, updated_by TEXT DEFAULT '',
      UNIQUE (kind, manufacturer, model))`),
    db.prepare("CREATE INDEX IF NOT EXISTS bid_catalog_kind ON bid_catalog (kind, manufacturer, model)"),
    db.prepare("CREATE TABLE IF NOT EXISTS bid_catalog_labor (item_id INTEGER NOT NULL, cost_code TEXT NOT NULL, seconds INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (item_id, cost_code))"),
    db.prepare("CREATE TABLE IF NOT EXISTS bid_package_items (pkg_id INTEGER NOT NULL, n INTEGER NOT NULL, item_id INTEGER NOT NULL, qty REAL NOT NULL DEFAULT 1, PRIMARY KEY (pkg_id, n))"),
    db.prepare("CREATE INDEX IF NOT EXISTS bid_package_items_item ON bid_package_items (item_id)"),
    db.prepare("CREATE TABLE IF NOT EXISTS bid_lead_counters (div TEXT PRIMARY KEY, next INTEGER NOT NULL)"),
  ]);
  await initBids(db);
  ready = true;
}

// ---------------------------------------------------------------- settings
// cost codes: the list SIS Tools has today, with the old D-Tools codes as aliases (Tony, 2026-11-15) so imports map themselves
const SEED_CODES = [
  ["1025", "Training", []], ["7010", "Administration", []], ["7015", "Business Development", []], ["7020", "Design", ["6010"]],
  ["7025", "Finish", ["6005", "3015"]], ["7030", "Rough-In", ["6020", "3040"]], ["7035", "Project Management", ["6040"]], ["7040", "Procurement/Travel", ["6035"]],
  ["7045", "Programming", ["6036"]], ["7050", "Project Engineer", ["6045"]], ["7055", "Warranty", []],
];
const cleanCode = c => ({ code: str(c.code, 12).replace(/[^0-9A-Za-z.-]/g, ""), name: str(c.name, 60), rates: Object.fromEntries(DIVS.map(d => [d, Math.max(0, r2(numOr(c.rates && c.rates[d])))])),
  aliases: [...new Set((Array.isArray(c.aliases) ? c.aliases : String(c.aliases || "").split(/[\s,;]+/)).map(a => str(a, 12)).filter(Boolean))].slice(0, 12), retired: !!c.retired });
async function costCodes(env) {
  const v = await setting(env, "bids:costCodes");
  if (Array.isArray(v)) return v;
  return SEED_CODES.map(([code, name, aliases]) => ({ code, name, rates: { EL: 0, LV: 0 }, aliases, retired: false }));
}
const SEED_PAY = [{ id: "std", name: "Standard 35/35/20/10", steps: [{ label: "Initial Equipment Order", pct: 35 }, { label: "Rough Completion & Finish Equipment Order", pct: 35 }, { label: "Project Completion", pct: 20 }, { label: "Project Completion", pct: 10 }] }];
async function paySchedules(env) { const v = await setting(env, "bids:paySchedules"); return Array.isArray(v) ? v : SEED_PAY; }
async function systems(env) { const v = await setting(env, "bids:systems"); return Array.isArray(v) ? v : []; }
async function leadCounters(env) {
  const { results } = await env.DB.prepare("SELECT div, next FROM bid_lead_counters").all();
  const o = Object.fromEntries(DIVS.map(d => [d, null])); for (const r of results || []) o[r.div] = r.next; return o;
}
// "Lighting: Can Light", "Lighting\Can Light", "Lighting" -> { sys, sub }
const splitSystem = s => { const t = str(s, 120); const m = t.split(/\s*[:\\/>]\s*/).filter(Boolean); return { sys: m[0] || "", sub: m.slice(1).join(" ") }; };
const sysLabel = ({ sys, sub }) => sys ? (sub ? `${sys}: ${sub}` : sys) : "";
function mergeSystems(list, labels) {
  const by = new Map(list.map(s => [s.name.toLowerCase(), s]));
  let added = 0;
  for (const l of labels) { const { sys, sub } = splitSystem(l); if (!sys) continue;
    let s = by.get(sys.toLowerCase()); if (!s) { s = { name: sys, subs: [] }; list.push(s); by.set(sys.toLowerCase(), s); added++; }
    if (sub && !s.subs.some(x => x.toLowerCase() === sub.toLowerCase())) { s.subs.push(sub); added++; } }
  return added;
}

async function settingsApi(req, env, url, me) {
  const p = url.pathname, write = req.method === "PUT" || req.method === "POST";
  if (write && !me.settings) return bad("Only Admins (or roles that can manage roles) can change settings.", 403);
  if (p === "/api/settings") {
    if (req.method !== "GET") return bad("Method not allowed", 405);
    return json({ costCodes: await costCodes(env), paySchedules: await paySchedules(env), systems: await systems(env), leads: await leadCounters(env), divs: DIVS });
  }
  const b = write ? await req.json().catch(() => null) : null;
  if (write && !b) return bad("Bad request");
  if (p === "/api/settings/cost-codes" && req.method === "PUT") {
    const list = (Array.isArray(b.costCodes) ? b.costCodes : []).slice(0, 200).map(cleanCode).filter(c => c.code && c.name);
    const seen = new Set(); for (const c of list) { if (seen.has(c.code)) return bad(`Cost code ${c.code} is listed twice.`); seen.add(c.code); }
    for (const c of list) for (const a of c.aliases) if (seen.has(a)) return bad(`${a} is a cost code of its own, so it can't also be an alias of ${c.code}.`);
    // a code that labor in the catalog uses can be retired but not removed (old bids keep their numbers)
    const used = new Set(((await env.DB.prepare("SELECT DISTINCT cost_code FROM bid_catalog_labor UNION SELECT DISTINCT cost_code FROM bid_catalog WHERE cost_code <> ''").all()).results || []).map(r => r.cost_code));
    const gone = [...used].filter(c => !seen.has(c));
    if (gone.length) return bad(gone.length === 1 ? `Cost code ${gone[0]} is used in the catalog. Retire it instead of deleting it.` : `Cost codes ${gone.join(", ")} are used in the catalog. Retire them instead of deleting them.`);
    await putSetting(env, "bids:costCodes", list); return json({ ok: true, costCodes: list });
  }
  if (p === "/api/settings/pay-schedules" && req.method === "PUT") {
    const out = [];
    for (const s of (Array.isArray(b.paySchedules) ? b.paySchedules : []).slice(0, 50)) {
      const name = str(s.name, 60); if (!name) continue;
      const steps = (Array.isArray(s.steps) ? s.steps : []).slice(0, 20).map(x => ({ label: str(x.label, 80), pct: r2(numOr(x.pct)) })).filter(x => x.label || x.pct);
      const tot = r2(steps.reduce((a, x) => a + x.pct, 0));
      if (Math.abs(tot - 100) > 0.001) return bad(`"${name}" adds up to ${tot}%. Its milestones must total 100%.`);
      if (steps.some(x => !x.label)) return bad(`Every milestone in "${name}" needs a name.`);
      out.push({ id: str(s.id, 40) || crypto.randomUUID().slice(0, 8), name, steps });
    }
    await putSetting(env, "bids:paySchedules", out); return json({ ok: true, paySchedules: out });
  }
  if (p === "/api/settings/systems" && req.method === "PUT") {
    const out = (Array.isArray(b.systems) ? b.systems : []).slice(0, 200).map(s => ({ name: str(s.name, 60), subs: [...new Set((Array.isArray(s.subs) ? s.subs : []).map(x => str(x, 60)).filter(Boolean))].slice(0, 100) })).filter(s => s.name);
    await putSetting(env, "bids:systems", out); return json({ ok: true, systems: out });
  }
  // lead numbers: set the next number per division; it can only move forward, so a number is never handed out twice
  if (p === "/api/settings/leads" && req.method === "PUT") {
    const cur = await leadCounters(env), stmts = [];
    for (const d of DIVS) { if (!(d in (b.leads || {})) || b.leads[d] === null || b.leads[d] === "") continue;
      const n = Math.floor(numOr(b.leads[d], NaN)); if (!(n >= 1 && n <= 999999)) return bad(`${d}: enter a whole number from 1 to 999999.`);
      if (cur[d] != null && n < cur[d]) return bad(`${d} is already at ${fmtLead(d, cur[d])}. The next number can only move forward, so no lead number is used twice.`);
      stmts.push(env.DB.prepare("INSERT INTO bid_lead_counters (div, next) VALUES (?, ?) ON CONFLICT (div) DO UPDATE SET next = excluded.next WHERE excluded.next >= bid_lead_counters.next").bind(d, n)); }
    if (stmts.length) await env.DB.batch(stmts);
    return json({ ok: true, leads: await leadCounters(env) });
  }
  return null;
}
const fmtLead = (d, n) => `${d}-${String(n).padStart(4, "0")}`;
// hands out the next lead number in one statement, so two people creating jobs at once never get the same one (used by step 2)
async function takeLead(env, d) {
  if (!DIVS.includes(d)) throw new Error("Unknown division");
  const r = await env.DB.prepare("UPDATE bid_lead_counters SET next = next + 1 WHERE div = ? RETURNING next - 1 AS n").bind(d).first();
  if (!r) throw new Error(`Set the first ${d} lead number in Settings first.`);
  return fmtLead(d, r.n);
}

// ---------------------------------------------------------------- catalog
const KINDS = ["product", "labor", "service", "package"];
const COLS = ["kind", "manufacturer", "model", "part_number", "catalog_no", "category", "subcategory", "system", "short_desc", "long_desc", "url", "image_url", "vendor",
  "msrp", "unit_cost", "unit_price", "taxable", "order_uom", "order_units", "purchase_cost", "cost_code", "extra", "discontinued", "source"];
const LIM = { manufacturer: 80, model: 160, part_number: 60, catalog_no: 60, category: 80, subcategory: 80, system: 120, short_desc: 1000, long_desc: 4000, url: 1000, image_url: 1000, vendor: 80, order_uom: 30, cost_code: 12, source: 20 };
// only products are taxed (Tony, 2026-11-18): labor, labor items, service items and packages (their parts carry their own) are not
function cleanItem(b, prev) {
  const o = { ...(prev || {}) };
  o.kind = KINDS.includes(b.kind) ? b.kind : (prev && prev.kind) || "product";
  for (const k of Object.keys(LIM)) if (k in b) o[k] = str(b[k], LIM[k]);
  for (const k of ["msrp", "unit_cost", "purchase_cost"]) if (k in b) o[k] = r4(Math.max(0, numOr(b[k])));
  if ("unit_price" in b) o.unit_price = b.unit_price === null || b.unit_price === "" ? null : r4(Math.max(0, numOr(b.unit_price)));
  if ("order_units" in b) o.order_units = Math.max(1, numOr(b.order_units, 1));
  if ("discontinued" in b) o.discontinued = b.discontinued ? 1 : 0;
  if ("extra" in b) o.extra = JSON.stringify(b.extra && typeof b.extra === "object" ? b.extra : {}).slice(0, 4000);
  o.taxable = o.kind === "product" ? ("taxable" in b ? (b.taxable ? 1 : 0) : (prev ? prev.taxable : 1)) : 0;
  if (!o.model) o.model = ""; for (const k of COLS) if (o[k] === undefined) o[k] = k === "taxable" || k === "discontinued" ? 0 : ["msrp", "unit_cost", "purchase_cost"].includes(k) ? 0 : k === "unit_price" ? null : k === "order_units" ? 1 : k === "extra" ? "{}" : "";
  if (!o.source) o.source = "manual";
  return o;
}
// "0:15:00", "15:00" (m:s), "1:30" read as h:m when it has one colon and the first part is under 24? We keep it simple and strict:
// h:mm:ss, h:mm, or decimal hours ("0.25"). Seconds come back from the page already parsed; this is a backstop.
const secs = v => Math.max(0, Math.min(1000 * 3600, Math.round(numOr(v))));
function cleanLabor(list) {
  const out = new Map();
  for (const l of Array.isArray(list) ? list.slice(0, 20) : []) { const c = str(l.cost_code || l.code, 12), s = secs(l.seconds); if (!c || !s) continue; out.set(c, (out.get(c) || 0) + s); }
  return [...out].map(([cost_code, seconds]) => ({ cost_code, seconds }));
}
async function laborOf(env, ids) {
  const o = {}; if (!ids.length) return o;
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90), { results } = await env.DB.prepare(`SELECT item_id, cost_code, seconds FROM bid_catalog_labor WHERE item_id IN (${part.map(() => "?").join(",")})`).bind(...part).all();
    for (const r of results || []) (o[r.item_id] ||= []).push({ cost_code: r.cost_code, seconds: r.seconds });
  }
  return o;
}
const outItem = (r, labor) => ({ ...r, extra: parse(r.extra) || {}, taxable: !!r.taxable, discontinued: !!r.discontinued, labor: labor[r.id] || [] });

// a package's rolled-up cost, sell and labor: the sum of its parts times their quantities, packages inside packages included
async function rollup(env, ids) {
  const items = {}, kids = {}, need = new Set(ids);
  const loadItems = async list => { for (let i = 0; i < list.length; i += 90) { const part = list.slice(i, i + 90); const { results } = await env.DB.prepare(`SELECT id, kind, unit_cost, unit_price, cost_code, taxable FROM bid_catalog WHERE id IN (${part.map(() => "?").join(",")})`).bind(...part).all(); for (const r of results || []) items[r.id] = r; } };
  let frontier = [...need];
  for (let depth = 0; frontier.length && depth < 8; depth++) {
    await loadItems(frontier.filter(id => !items[id]));
    const pk = frontier.filter(id => items[id] && items[id].kind === "package" && !kids[id]); const next = [];
    for (let i = 0; i < pk.length; i += 90) { const part = pk.slice(i, i + 90); const { results } = await env.DB.prepare(`SELECT pkg_id, item_id, qty FROM bid_package_items WHERE pkg_id IN (${part.map(() => "?").join(",")}) ORDER BY pkg_id, n`).bind(...part).all();
      for (const id of part) kids[id] = []; for (const r of results || []) { kids[r.pkg_id].push(r); if (!items[r.item_id]) next.push(r.item_id); } }
    frontier = [...new Set(next)];
  }
  const allIds = Object.keys(items).map(Number), labor = await laborOf(env, allIds), memo = {};
  const calc = (id, stack = new Set()) => {
    if (memo[id]) return memo[id]; const it = items[id]; if (!it || stack.has(id)) return { cost: 0, price: 0, taxable: 0, labor: {} };
    if (it.kind !== "package") {
      const lab = {}; for (const l of labor[id] || []) lab[l.cost_code] = (lab[l.cost_code] || 0) + l.seconds;
      return memo[id] = { cost: it.unit_cost || 0, price: it.unit_price == null ? null : it.unit_price, taxable: it.taxable ? (it.unit_price || 0) : 0, labor: lab };
    }
    stack.add(id); const o = { cost: 0, price: 0, taxable: 0, labor: {}, noPrice: 0 };
    for (const k of kids[id] || []) { const c = calc(k.item_id, stack); o.cost += k.qty * c.cost; if (c.price == null) o.noPrice++; else o.price += k.qty * c.price; o.taxable += k.qty * c.taxable;
      for (const [cc, s] of Object.entries(c.labor)) o.labor[cc] = (o.labor[cc] || 0) + k.qty * s; }
    stack.delete(id); o.cost = r4(o.cost); o.price = r4(o.price); o.taxable = r4(o.taxable); for (const cc in o.labor) o.labor[cc] = Math.round(o.labor[cc]);
    return memo[id] = o;
  };
  return Object.fromEntries(ids.map(id => [id, calc(id)]));
}
// would putting `child` inside `pkg` make a loop?
async function makesLoop(env, pkg, child) {
  if (pkg === child) return true; const seen = new Set(); let frontier = [child];
  for (let d = 0; frontier.length && d < 10; d++) { const next = [];
    for (let i = 0; i < frontier.length; i += 90) { const part = frontier.slice(i, i + 90); const { results } = await env.DB.prepare(`SELECT item_id FROM bid_package_items WHERE pkg_id IN (${part.map(() => "?").join(",")})`).bind(...part).all();
      for (const r of results || []) { if (r.item_id === pkg) return true; if (!seen.has(r.item_id)) { seen.add(r.item_id); next.push(r.item_id); } } }
    frontier = next; }
  return false;
}

async function saveItem(env, me, id, b) {
  const prev = id ? await env.DB.prepare("SELECT * FROM bid_catalog WHERE id = ?").bind(id).first() : null;
  if (id && !prev) return bad("That item is gone.", 404);
  const o = cleanItem(b, prev);
  if (!o.model) return bad(o.kind === "product" ? "Model is required." : "Name is required.");
  if ((o.kind === "labor" || o.kind === "service") && !o.cost_code && !(Array.isArray(b.labor) && b.labor.length)) return bad("Pick a cost code.");
  const now = new Date().toISOString(); o.updated_at = now; o.updated_by = me.email;
  const pkgList = "items" in b && o.kind === "package" ? (Array.isArray(b.items) ? b.items : []).slice(0, 300).map(x => ({ item_id: Math.floor(numOr(x.item_id)), qty: r4(numOr(x.qty, 1)) })).filter(x => x.item_id > 0 && x.qty > 0) : null;
  if (pkgList && id) for (const x of pkgList) if (await makesLoop(env, id, x.item_id)) return bad("A package can't contain itself, directly or through another package.");
  const dup = await env.DB.prepare("SELECT id FROM bid_catalog WHERE kind = ? AND manufacturer = ? AND model = ? AND id <> ?").bind(o.kind, o.manufacturer, o.model, id || 0).first();
  if (dup) return bad(`There's already ${o.kind === "product" ? "a product" : "an item"} called ${[o.manufacturer, o.model].filter(Boolean).join(" ")}.`, 409);
  const cols = [...COLS, "updated_at", "updated_by"];
  let newId = id;
  if (id) await env.DB.prepare(`UPDATE bid_catalog SET ${cols.map(c => c + " = ?").join(", ")} WHERE id = ?`).bind(...cols.map(c => o[c]), id).run();
  else newId = (await env.DB.prepare(`INSERT INTO bid_catalog (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) RETURNING id`).bind(...cols.map(c => o[c])).first()).id;
  const stmts = [];
  if ("labor" in b && o.kind !== "package") {
    stmts.push(env.DB.prepare("DELETE FROM bid_catalog_labor WHERE item_id = ?").bind(newId));
    for (const l of cleanLabor(b.labor)) stmts.push(env.DB.prepare("INSERT INTO bid_catalog_labor (item_id, cost_code, seconds) VALUES (?, ?, ?)").bind(newId, l.cost_code, l.seconds));
  }
  if (pkgList) {
    const list = pkgList;
    stmts.push(env.DB.prepare("DELETE FROM bid_package_items WHERE pkg_id = ?").bind(newId));
    list.forEach((x, n) => stmts.push(env.DB.prepare("INSERT INTO bid_package_items (pkg_id, n, item_id, qty) VALUES (?, ?, ?, ?)").bind(newId, n, x.item_id, x.qty)));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return json({ ok: true, item: await getItem(env, newId) });
}
async function getItem(env, id) {
  const r = await env.DB.prepare("SELECT * FROM bid_catalog WHERE id = ?").bind(id).first(); if (!r) return null;
  const o = outItem(r, await laborOf(env, [id]));
  if (r.kind === "package") {
    const { results } = await env.DB.prepare("SELECT p.item_id, p.qty, c.kind, c.manufacturer, c.model, c.part_number, c.unit_cost, c.unit_price FROM bid_package_items p LEFT JOIN bid_catalog c ON c.id = p.item_id WHERE p.pkg_id = ? ORDER BY p.n").bind(id).all();
    o.items = results || []; const ru = await rollup(env, [id, ...o.items.map(x => x.item_id)]); o.rollup = ru[id];
    for (const x of o.items) x.rollup = ru[x.item_id];
  }
  return o;
}

// D-Tools catalog export rows (the page reads the CSV and sends rows in batches) -> products with labor lines
// Phase "EL Finish [2014] [6005]" and Labor Types "EL Rough [6020]": the last bracketed number is the code, mapped through the aliases.
function codeFrom(s, alias) { const all = [...String(s || "").matchAll(/\[(\d{3,5})\]/g)].map(m => m[1]); for (let i = all.length - 1; i >= 0; i--) if (alias[all[i]]) return alias[all[i]]; return ""; }
const yes = v => /^(true|yes|1)$/i.test(String(v || "").trim());
async function importRows(env, me, rows, dry) {
  const codes = await costCodes(env), alias = {}; for (const c of codes) { alias[c.code] = c.code; for (const a of c.aliases || []) alias[a] = c.code; }
  const now = new Date().toISOString(), out = { added: 0, updated: 0, skipped: 0, noCode: 0, systems: [] }, sysLabels = new Set();
  const cols = [...COLS, "updated_at", "updated_by"];
  const batch = [];
  for (const r of rows.slice(0, 1000)) {
    const model = str(r["Model"], 160); if (!model) { out.skipped++; continue; }
    const manufacturer = str(r["Manufacturer"], 80);
    const sys = str(r["System"], 120); if (sys) sysLabels.add(sys);
    const labCode = codeFrom(r["Labor Types"], alias) || codeFrom(r["Phase"], alias);
    const hrs = numOr(r["Unit Labor Hours"]); if (hrs > 0 && !labCode) out.noCode++;
    const extra = {}; for (const k of ["Height", "Width", "Depth", "Weight", "Amps", "Volts", "Watts", "BTU", "Rack Units"]) { const v = numOr(r[k]); if (v) extra[k.toLowerCase().replace(/\s+/g, "_")] = v; }
    if (str(r["Tags"], 200)) extra.tags = str(r["Tags"], 200); if (str(r["UPC"], 40)) extra.upc = str(r["UPC"], 40); if (str(r["Accounting Item Name"], 120)) extra.accounting = str(r["Accounting Item Name"], 120);
    const o = cleanItem({ kind: "product", manufacturer, model, part_number: String(r["Part Number"] || "").replace(/^'/, ""), catalog_no: r["Catalog"], category: r["Category"], subcategory: r["Subcategory"],
      system: sysLabel(splitSystem(sys)), short_desc: r["Short Description"], long_desc: r["Long Description"], url: r["URL"], vendor: r["Preferred Vendor"], msrp: r["MSRP"], unit_cost: r["Unit Cost"],
      unit_price: r["Unit Price"] === "" || r["Unit Price"] == null ? null : r["Unit Price"], taxable: r["Taxable"] == null || r["Taxable"] === "" ? true : yes(r["Taxable"]), order_uom: r["Order UOM"],
      order_units: numOr(r["Order UOM Units"], 1) || 1, purchase_cost: r["Purchase Cost"], cost_code: "", extra, discontinued: yes(r["Discontinued"]), source: "dtools" }, null);
    o.updated_at = now; o.updated_by = me.email;
    batch.push({ o, lab: hrs > 0 && labCode ? { cost_code: labCode, seconds: Math.round(hrs * 3600) } : null });
  }
  // which already exist (manufacturer + model)
  const exist = {};
  for (let i = 0; i < batch.length; i += 45) { const part = batch.slice(i, i + 45);
    const { results } = await env.DB.prepare(`SELECT id, manufacturer, model FROM bid_catalog WHERE kind = 'product' AND (${part.map(() => "(manufacturer = ? AND model = ?)").join(" OR ")})`).bind(...part.flatMap(x => [x.o.manufacturer, x.o.model])).all();
    for (const r of results || []) exist[r.manufacturer + "\u0001" + r.model] = r.id; }
  const seen = new Set();
  for (const x of batch) { const k = x.o.manufacturer + "\u0001" + x.o.model; if (seen.has(k)) { out.skipped++; continue; } seen.add(k); if (exist[k]) out.updated++; else out.added++; }
  if (dry) { const cur = await systems(env); const copy = JSON.parse(JSON.stringify(cur)); out.newSystems = mergeSystems(copy, sysLabels); return out; }
  const stmts = [], seen2 = new Set();
  for (const x of batch) {
    const k = x.o.manufacturer + "\u0001" + x.o.model; if (seen2.has(k)) continue; seen2.add(k);
    stmts.push(env.DB.prepare(`INSERT INTO bid_catalog (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})
      ON CONFLICT (kind, manufacturer, model) DO UPDATE SET ${cols.filter(c => c !== "kind" && c !== "manufacturer" && c !== "model").map(c => `${c} = excluded.${c}`).join(", ")}`).bind(...cols.map(c => x.o[c])));
    // labor follows the import: the D-Tools line replaces this product's labor (other codes typed by hand stay)
    if (x.lab) stmts.push(env.DB.prepare("INSERT INTO bid_catalog_labor (item_id, cost_code, seconds) SELECT id, ?, ? FROM bid_catalog WHERE kind = 'product' AND manufacturer = ? AND model = ? ON CONFLICT (item_id, cost_code) DO UPDATE SET seconds = excluded.seconds")
      .bind(x.lab.cost_code, x.lab.seconds, x.o.manufacturer, x.o.model));
  }
  for (let i = 0; i < stmts.length; i += 200) await env.DB.batch(stmts.slice(i, i + 200));
  const sy = await systems(env), n = mergeSystems(sy, sysLabels); if (n) await putSetting(env, "bids:systems", sy); out.newSystems = n;
  return out;
}

async function catalogApi(req, env, url, me) {
  const p = url.pathname;
  if (p === "/api/catalog" && req.method === "GET") {
    const q = str(url.searchParams.get("q"), 100), kind = url.searchParams.get("kind") || "", lim = Math.min(500, Math.max(1, numOr(url.searchParams.get("limit"), 100))), off = Math.max(0, numOr(url.searchParams.get("offset"), 0));
    const where = [], args = [];
    if (KINDS.includes(kind)) { where.push("kind = ?"); args.push(kind); }
    if (url.searchParams.get("all") !== "1") where.push("discontinued = 0");
    for (const w of q.split(/\s+/).filter(Boolean).slice(0, 6)) { where.push("(manufacturer || ' ' || model || ' ' || part_number || ' ' || catalog_no || ' ' || category || ' ' || subcategory || ' ' || short_desc || ' ' || vendor) LIKE ?"); args.push("%" + w + "%"); }
    const W = where.length ? "WHERE " + where.join(" AND ") : "";
    const total = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM bid_catalog ${W}`).bind(...args).first()).n;
    const { results } = await env.DB.prepare(`SELECT * FROM bid_catalog ${W} ORDER BY kind = 'package' DESC, manufacturer, model LIMIT ? OFFSET ?`).bind(...args, lim, off).all();
    const rows = results || [], labor = await laborOf(env, rows.map(r => r.id)), pk = rows.filter(r => r.kind === "package").map(r => r.id), ru = pk.length ? await rollup(env, pk) : {};
    const counts = Object.fromEntries(((await env.DB.prepare("SELECT kind, COUNT(*) AS n FROM bid_catalog WHERE discontinued = 0 GROUP BY kind").all()).results || []).map(r => [r.kind, r.n]));
    return json({ total, counts, items: rows.map(r => ({ ...outItem(r, labor), ...(ru[r.id] ? { rollup: ru[r.id] } : {}) })) });
  }
  if (p === "/api/catalog" && req.method === "POST") { const b = await req.json().catch(() => null); if (!b) return bad("Bad request"); return saveItem(env, me, 0, b); }
  if (p === "/api/catalog/import" && req.method === "POST") {
    const b = await req.json().catch(() => null); if (!b || !Array.isArray(b.rows)) return bad("Bad request");
    if (b.rows.length > 1000) return bad("Send at most 1000 rows at a time.");
    return json({ ok: true, ...(await importRows(env, me, b.rows, !!b.dry)) });
  }
  if (p === "/api/catalog/rollup" && req.method === "POST") {
    const b = await req.json().catch(() => null), ids = (b && Array.isArray(b.ids) ? b.ids : []).slice(0, 200).map(x => Math.floor(numOr(x))).filter(x => x > 0);
    return json({ rollup: await rollup(env, ids) });
  }
  const m = p.match(/^\/api\/catalog\/(\d{1,12})$/);
  if (m) {
    const id = Number(m[1]);
    if (req.method === "GET") { const it = await getItem(env, id); return it ? json({ item: it }) : bad("That item is gone.", 404); }
    if (req.method === "PUT") { const b = await req.json().catch(() => null); if (!b) return bad("Bad request"); return saveItem(env, me, id, b); }
    if (req.method === "DELETE") {
      const inPkg = await env.DB.prepare("SELECT c.model FROM bid_package_items p JOIN bid_catalog c ON c.id = p.pkg_id WHERE p.item_id = ? LIMIT 3").bind(id).all();
      if ((inPkg.results || []).length) return bad(`It's used in ${inPkg.results.map(r => r.model).join(", ")}. Take it out of those packages first, or mark it discontinued.`, 409);
      await env.DB.batch([env.DB.prepare("DELETE FROM bid_catalog_labor WHERE item_id = ?").bind(id), env.DB.prepare("DELETE FROM bid_package_items WHERE pkg_id = ?").bind(id), env.DB.prepare("DELETE FROM bid_catalog WHERE id = ?").bind(id)]);
      return json({ ok: true });
    }
  }
  return null;
}

// ---------------------------------------------------------------- the Worker
// ---------------------------------------------------------------- bids (B2a)
// A bid belongs to a SIS Tools job (docs coll "jobs"). A job is made here with the next lead number (EL-0200 / LV-0200) when
// a lead asks for a price, or an existing job is picked. Each bid has its own room tree (level > room > sub-room, as deep as
// three) and lines: a catalog item placed in one room under one system, with a quantity. A line copies cost, sell, tax base and
// labor from the catalog when it's added (a package copies its rolled-up totals and its contents), so later catalog changes
// never move a bid's numbers; "Update prices" pulls them again on purpose.
const DIV_NAME = { EL: "Electrical", LV: "Low Voltage" };
const DIV_OF = name => /low\s*volt/i.test(name || "") ? "LV" : "EL";
const BID_STATUS = ["draft", "sent", "won", "lost"];
async function initBids(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS bids (id INTEGER PRIMARY KEY, job_id TEXT NOT NULL, name TEXT DEFAULT '', rev INTEGER DEFAULT 1, status TEXT DEFAULT 'draft',
      active INTEGER DEFAULT 1, div TEXT DEFAULT 'EL', margin_pct REAL, tax_pct REAL DEFAULT 0, pay_id TEXT DEFAULT '', pay_steps TEXT DEFAULT '[]', notes TEXT DEFAULT '',
      totals TEXT DEFAULT '{}', created_at TEXT, created_by TEXT DEFAULT '', updated_at TEXT, updated_by TEXT DEFAULT '')`),
    db.prepare("CREATE INDEX IF NOT EXISTS bids_job ON bids (job_id)"),
    db.prepare("CREATE TABLE IF NOT EXISTS bid_rooms (id INTEGER PRIMARY KEY, bid_id INTEGER NOT NULL, parent_id INTEGER, name TEXT NOT NULL, sort REAL DEFAULT 0)"),
    db.prepare("CREATE INDEX IF NOT EXISTS bid_rooms_bid ON bid_rooms (bid_id)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS bid_lines (id INTEGER PRIMARY KEY, bid_id INTEGER NOT NULL, room_id INTEGER, system TEXT DEFAULT '', item_id INTEGER, kind TEXT DEFAULT 'product',
      manufacturer TEXT DEFAULT '', model TEXT DEFAULT '', part_number TEXT DEFAULT '', description TEXT DEFAULT '', qty REAL DEFAULT 1, unit_cost REAL DEFAULT 0, unit_price REAL,
      tax_base REAL DEFAULT 0, labor TEXT DEFAULT '[]', contents TEXT DEFAULT '[]', sort REAL DEFAULT 0, source TEXT DEFAULT 'manual', src_key TEXT DEFAULT '', note TEXT DEFAULT '')`),
    db.prepare("CREATE INDEX IF NOT EXISTS bid_lines_bid ON bid_lines (bid_id, room_id)"),
  ]);
}
const nowIso = () => new Date().toISOString();
const uid36 = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// SIS Tools jobs, read straight from its docs table
async function sisJobs(env) {
  const { results } = await env.DB.prepare("SELECT id, data FROM docs WHERE coll = 'jobs'").all().catch(() => ({ results: [] }));
  const out = []; for (const r of results || []) { const j = parse(r.data); if (!j || j.deleted || j.status === "deleted") continue;
    out.push({ id: r.id, no: j.no || "", lead: j.lead || "", name: j.name || "", div: j.div || "", addr: j.addr || "", contact: j.contact || "", status: j.status || "active", kind: j.kind || "" }); }
  return out;
}
async function sisJob(env, id) { const r = await env.DB.prepare("SELECT data FROM docs WHERE coll = 'jobs' AND id = ?").bind(id).first().catch(() => null); const j = r ? parse(r.data) : null;
  return j && !j.deleted ? { id, no: j.no || "", lead: j.lead || "", name: j.name || "", div: j.div || "", addr: j.addr || "", contact: j.contact || "", status: j.status || "active" } : null; }
// a new job in SIS Tools, logged in its history the way SIS Tools logs its own saves (who, when, before and after)
async function createJob(env, me, b) {
  const div = DIVS.includes(b.div) ? b.div : "", name = str(b.name, 120);
  if (!div) return bad("Pick a division."); if (!name) return bad("Enter the job name.");
  const lead = await takeLead(env, div).catch(e => e); if (lead instanceof Error) return bad(lead.message);
  const id = uid36(), now = new Date(), at = now.getTime();
  const job = { no: lead, lead, name, div: DIV_NAME[div], addr: str(b.addr, 200), contact: str(b.contact, 120), phone: str(b.phone, 40), status: "active", color: 7, notes: str(b.notes, 1000), from: "sis-bids", by: me.email, at };
  const h = { at, by: me.email, name: me.name, role: me.role, coll: "jobs", docId: id, before: null, after: job };
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS docs (coll TEXT NOT NULL, id TEXT NOT NULL, date TEXT, data TEXT NOT NULL, updated TEXT NOT NULL, PRIMARY KEY (coll, id))"),
    env.DB.prepare("INSERT INTO docs (coll, id, date, data, updated) VALUES ('jobs', ?, NULL, ?, ?)").bind(id, JSON.stringify(job), now.toISOString()),
    env.DB.prepare("INSERT INTO docs (coll, id, date, data, updated) VALUES ('history', ?, ?, ?, ?)").bind(at + "_" + crypto.randomUUID().slice(0, 8), now.toISOString().slice(0, 10), JSON.stringify(h), now.toISOString()),
  ]);
  return { id, no: lead, lead, name, div: job.div, addr: job.addr, contact: job.contact, status: "active" };
}

// the money: equipment and services at their sell, labor at the bid division's rate per cost code (no markup), tax on taxable sell
function bidTotals(bid, lines, codes) {
  const rate = {}; for (const c of codes) rate[c.code] = (c.rates || {})[bid.div] || 0;
  const t = { equipCost: 0, equipSell: 0, svcCost: 0, svcSell: 0, laborSell: 0, laborSecs: 0, taxBase: 0, byCode: {}, byRoom: {}, bySystem: {}, missingRate: [] };
  const add = (o, k, f) => { const x = o[k] || (o[k] = { sell: 0, cost: 0, labor: 0, secs: 0 }); f(x); };
  for (const l of lines) {
    const q = l.qty || 0, lab = Array.isArray(l.labor) ? l.labor : parse(l.labor) || [];
    let laborUSD = 0, secs = 0;
    for (const x of lab) { const s = (x.seconds || 0) * q; secs += s; const r = rate[x.cost_code] || 0; if (!r && s && !t.missingRate.includes(x.cost_code)) t.missingRate.push(x.cost_code);
      const usd = l.kind === "labor" && l.unit_price != null ? 0 : s / 3600 * r; laborUSD += usd;
      add(t.byCode, x.cost_code, o => { o.secs += s; o.labor += usd; }); }
    let sell = 0, cost = q * (l.unit_cost || 0);
    if (l.kind === "labor") { if (l.unit_price != null) { laborUSD += q * l.unit_price; const c0 = (lab[0] || {}).cost_code || l.cost_code || ""; add(t.byCode, c0, o => { o.labor += q * l.unit_price; }); } cost = 0; }
    else sell = q * (l.unit_price == null ? 0 : l.unit_price);
    if (l.kind === "service") { t.svcCost += cost; t.svcSell += sell; } else if (l.kind !== "labor") { t.equipCost += cost; t.equipSell += sell; }
    t.laborSell += laborUSD; t.laborSecs += secs; t.taxBase += q * (l.tax_base || 0);
    const rk = String(l.room_id || 0); add(t.byRoom, rk, o => { o.sell += sell + laborUSD; o.cost += cost; o.labor += laborUSD; o.secs += secs; });
    add(t.bySystem, l.system || "", o => { o.sell += sell + laborUSD; o.cost += cost; o.labor += laborUSD; o.secs += secs; });
  }
  t.tax = r2(t.taxBase * (bid.tax_pct || 0) / 100);
  t.total = r2(t.equipSell + t.svcSell + t.laborSell + t.tax);
  t.cost = r2(t.equipCost + t.svcCost);
  t.margin = t.equipSell + t.svcSell > 0 ? r2((t.equipSell + t.svcSell - t.cost) / (t.equipSell + t.svcSell) * 100) : 0;
  for (const k of ["equipCost", "equipSell", "svcCost", "svcSell", "laborSell", "taxBase"]) t[k] = r2(t[k]);
  return t;
}
const outBid = b => ({ ...b, active: !!b.active, pay_steps: parse(b.pay_steps) || [], totals: parse(b.totals) || {} });
const outLine = l => ({ ...l, labor: parse(l.labor) || [], contents: parse(l.contents) || [] });
async function loadBid(env, id) {
  const bid = await env.DB.prepare("SELECT * FROM bids WHERE id = ?").bind(id).first(); if (!bid) return null;
  const rooms = (await env.DB.prepare("SELECT * FROM bid_rooms WHERE bid_id = ? ORDER BY sort, id").bind(id).all()).results || [];
  const lines = ((await env.DB.prepare("SELECT * FROM bid_lines WHERE bid_id = ? ORDER BY sort, id").bind(id).all()).results || []).map(outLine);
  return { bid: outBid(bid), rooms, lines };
}
// keep the bid's cached totals (shown in lists) current after every change
async function touch(env, me, id) {
  const d = await loadBid(env, id); if (!d) return null;
  const t = bidTotals(d.bid, d.lines, await costCodes(env));
  const sum = { total: t.total, equipSell: t.equipSell, laborSell: t.laborSell, laborSecs: t.laborSecs, tax: t.tax, lines: d.lines.length };
  await env.DB.prepare("UPDATE bids SET totals = ?, updated_at = ?, updated_by = ? WHERE id = ?").bind(JSON.stringify(sum), nowIso(), me.email, id).run();
  return d;
}
// a catalog item -> the values a new line copies
async function lineFromItem(env, itemId, bid) {
  const it = await env.DB.prepare("SELECT * FROM bid_catalog WHERE id = ?").bind(itemId).first(); if (!it) return null;
  const o = { item_id: it.id, kind: it.kind, manufacturer: it.manufacturer, model: it.model, part_number: it.part_number, description: it.short_desc, system: it.system, unit_cost: it.unit_cost || 0, unit_price: it.unit_price, tax_base: 0, labor: [], contents: [] };
  if (it.kind === "package") {
    const ru = (await rollup(env, [it.id]))[it.id] || {};
    o.unit_cost = ru.cost || 0; o.unit_price = ru.price || 0; o.tax_base = ru.taxable || 0;
    o.labor = Object.entries(ru.labor || {}).map(([cost_code, seconds]) => ({ cost_code, seconds }));
    const { results } = await env.DB.prepare("SELECT p.qty, c.manufacturer, c.model, c.part_number, c.short_desc FROM bid_package_items p JOIN bid_catalog c ON c.id = p.item_id WHERE p.pkg_id = ? ORDER BY p.n").bind(it.id).all();
    o.contents = (results || []).map(r => ({ qty: r.qty, manufacturer: r.manufacturer, model: r.model, part_number: r.part_number, description: r.short_desc }));
  } else {
    o.labor = (await laborOf(env, [it.id]))[it.id] || [];
    if (it.kind === "product" && bid.margin_pct != null && (it.unit_price == null || it.unit_price === 0) && it.unit_cost) o.unit_price = r4(it.unit_cost / (1 - bid.margin_pct / 100));
    if (it.kind === "product" && it.taxable) o.tax_base = o.unit_price || 0;
  }
  if (it.kind !== "labor" && o.unit_price == null) o.unit_price = 0;
  return o;
}
const LINE_COLS = ["bid_id", "room_id", "system", "item_id", "kind", "manufacturer", "model", "part_number", "description", "qty", "unit_cost", "unit_price", "tax_base", "labor", "contents", "sort", "source", "src_key", "note"];
const insLine = (env, o) => env.DB.prepare(`INSERT INTO bid_lines (${LINE_COLS.join(", ")}) VALUES (${LINE_COLS.map(() => "?").join(", ")})`)
  .bind(...LINE_COLS.map(c => c === "labor" || c === "contents" ? JSON.stringify(o[c] || []) : o[c] === undefined ? (c === "qty" ? 1 : c === "sort" ? Date.now() : c === "room_id" || c === "item_id" || c === "unit_price" ? null : "") : o[c]));

async function bidsApi(req, env, url, me) {
  const p = url.pathname, M = req.method;
  const body = async () => (await req.json().catch(() => null)) || {};
  if (p === "/api/jobs" && M === "GET") {
    const q = str(url.searchParams.get("q"), 80).toLowerCase(), jobs = await sisJobs(env);
    const counts = Object.fromEntries((((await env.DB.prepare("SELECT job_id, COUNT(*) AS n FROM bids GROUP BY job_id").all()).results) || []).map(r => [r.job_id, r.n]));
    const words = q.split(/\s+/).filter(Boolean);
    const list = jobs.filter(j => j.kind !== "wo" && (!words.length || words.every(w => `${j.no} ${j.lead} ${j.name} ${j.addr}`.toLowerCase().includes(w))))
      .map(j => ({ ...j, bids: counts[j.id] || 0 })).sort((a, b) => (b.bids - a.bids) || String(b.no).localeCompare(String(a.no), undefined, { numeric: true })).slice(0, 60);
    return json({ jobs: list });
  }
  if (p === "/api/jobs" && M === "POST") { const r = await createJob(env, me, await body()); return r instanceof Response ? r : json({ ok: true, job: r }); }
  if (p === "/api/bids" && M === "GET") {
    const job = url.searchParams.get("job");
    const { results } = job ? await env.DB.prepare("SELECT * FROM bids WHERE job_id = ? ORDER BY rev DESC, id DESC").bind(job).all()
      : await env.DB.prepare("SELECT * FROM bids ORDER BY updated_at DESC LIMIT 200").all();
    const jobs = Object.fromEntries((await sisJobs(env)).map(j => [j.id, j]));
    return json({ bids: (results || []).map(b => ({ ...outBid(b), job: jobs[b.job_id] || null })) });
  }
  if (p === "/api/bids" && M === "POST") {
    const b = await body(), job = await sisJob(env, str(b.job_id, 60)); if (!job) return bad("Pick a job first.");
    const prev = await env.DB.prepare("SELECT MAX(rev) AS r FROM bids WHERE job_id = ?").bind(job.id).first(), rev = ((prev && prev.r) || 0) + 1;
    const pays = await paySchedules(env), pay = pays.find(x => x.id === b.pay_id) || pays[0] || { id: "", steps: [] };
    const src = b.copy_from ? await loadBid(env, Math.floor(numOr(b.copy_from))) : null;
    const base = src ? src.bid : { div: DIV_OF(job.div), margin_pct: null, tax_pct: 0, pay_id: pay.id, pay_steps: pay.steps, notes: "" };
    const now = nowIso();
    const r = await env.DB.prepare(`INSERT INTO bids (job_id, name, rev, status, active, div, margin_pct, tax_pct, pay_id, pay_steps, notes, created_at, created_by, updated_at, updated_by)
      VALUES (?, ?, ?, 'draft', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).bind(job.id, str(b.name, 120) || (src ? `${src.bid.name || "Bid"} (copy)` : "Base bid"), rev, base.div, base.margin_pct, base.tax_pct || 0,
      base.pay_id || "", JSON.stringify(base.pay_steps || []), base.notes || "", now, me.email, now, me.email).first();
    const id = r.id;
    await env.DB.prepare("UPDATE bids SET active = 0 WHERE job_id = ? AND id <> ?").bind(job.id, id).run(); // the newest bid is the job's active one until someone picks another
    if (src) { // copy the room tree and lines
      const map = {}, order = []; const byParent = {}; for (const rm of src.rooms) (byParent[rm.parent_id || 0] ||= []).push(rm);
      const walk = pid => { for (const rm of byParent[pid] || []) { order.push(rm); walk(rm.id); } }; walk(0);
      for (const rm of order) { const x = await env.DB.prepare("INSERT INTO bid_rooms (bid_id, parent_id, name, sort) VALUES (?, ?, ?, ?) RETURNING id").bind(id, rm.parent_id ? map[rm.parent_id] : null, rm.name, rm.sort).first(); map[rm.id] = x.id; }
      const stmts = src.lines.map(l => insLine(env, { ...l, bid_id: id, room_id: l.room_id ? map[l.room_id] || null : null }));
      for (let i = 0; i < stmts.length; i += 200) await env.DB.batch(stmts.slice(i, i + 200));
    }
    await touch(env, me, id);
    return json({ ok: true, id });
  }
  let m = p.match(/^\/api\/bids\/(\d+)(\/.*)?$/);
  if (m) {
    const id = Number(m[1]), sub = m[2] || "";
    const bid = await env.DB.prepare("SELECT * FROM bids WHERE id = ?").bind(id).first(); if (!bid) return bad("That bid is gone.", 404);
    if (!sub && M === "GET") { const d = await loadBid(env, id); return json({ ...d, job: await sisJob(env, bid.job_id), totals: bidTotals(d.bid, d.lines, await costCodes(env)) }); }
    if (!sub && M === "PUT") {
      const b = await body(), set = {};
      if ("name" in b) set.name = str(b.name, 120);
      if ("status" in b && BID_STATUS.includes(b.status)) set.status = b.status;
      if ("div" in b && DIVS.includes(b.div)) set.div = b.div;
      if ("margin_pct" in b) set.margin_pct = b.margin_pct === null || b.margin_pct === "" ? null : Math.min(95, Math.max(0, numOr(b.margin_pct)));
      if ("tax_pct" in b) set.tax_pct = Math.min(30, Math.max(0, numOr(b.tax_pct)));
      if ("notes" in b) set.notes = str(b.notes, 4000);
      if ("pay_id" in b) { const s = (await paySchedules(env)).find(x => x.id === b.pay_id); if (s) { set.pay_id = s.id; set.pay_steps = JSON.stringify(s.steps); } }
      if ("pay_steps" in b) { const st = (Array.isArray(b.pay_steps) ? b.pay_steps : []).slice(0, 20).map(x => ({ label: str(x.label, 80), pct: r2(numOr(x.pct)) }));
        const tot = r2(st.reduce((a, x) => a + x.pct, 0)); if (st.length && Math.abs(tot - 100) > 0.001) return bad(`The milestones add up to ${tot}%. They must total 100%.`); set.pay_steps = JSON.stringify(st); }
      if (b.active === true) { await env.DB.prepare("UPDATE bids SET active = 0 WHERE job_id = ?").bind(bid.job_id).run(); set.active = 1; }
      const ks = Object.keys(set); if (ks.length) await env.DB.prepare(`UPDATE bids SET ${ks.map(k => k + " = ?").join(", ")} WHERE id = ?`).bind(...ks.map(k => set[k]), id).run();
      await touch(env, me, id); return json({ ok: true });
    }
    if (!sub && M === "DELETE") {
      await env.DB.batch([env.DB.prepare("DELETE FROM bid_lines WHERE bid_id = ?").bind(id), env.DB.prepare("DELETE FROM bid_rooms WHERE bid_id = ?").bind(id), env.DB.prepare("DELETE FROM bids WHERE id = ?").bind(id)]);
      return json({ ok: true });
    }
    // rooms: {parent_id, name} or {parent_id, names: [...]} (paste a list, one per line)
    if (sub === "/rooms" && M === "POST") {
      const b = await body(), pid = b.parent_id ? Math.floor(numOr(b.parent_id)) : null;
      if (pid) { const par = await env.DB.prepare("SELECT id, parent_id FROM bid_rooms WHERE id = ? AND bid_id = ?").bind(pid, id).first(); if (!par) return bad("That room is gone.");
        if (par.parent_id) { const gp = await env.DB.prepare("SELECT parent_id FROM bid_rooms WHERE id = ?").bind(par.parent_id).first(); if (gp && gp.parent_id) return bad("Rooms go three levels deep: level, room, sub-room."); } }
      const names = (Array.isArray(b.names) ? b.names : [b.name]).map(x => str(x, 120)).filter(Boolean).slice(0, 200); if (!names.length) return bad("Enter a name.");
      const base = Date.now(); await env.DB.batch(names.map((n, i) => env.DB.prepare("INSERT INTO bid_rooms (bid_id, parent_id, name, sort) VALUES (?, ?, ?, ?)").bind(id, pid, n, base + i)));
      await touch(env, me, id); return json({ ok: true });
    }
    if (sub === "/lines" && M === "POST") {
      const b = await body(), items = Array.isArray(b.items) ? b.items : [b]; const stmts = [];
      for (const x of items.slice(0, 200)) {
        const o = await lineFromItem(env, Math.floor(numOr(x.item_id)), bid); if (!o) return bad("That catalog item is gone.");
        o.bid_id = id; o.room_id = x.room_id ? Math.floor(numOr(x.room_id)) : null; o.qty = Math.max(0, numOr(x.qty, 1)); if (x.system) o.system = str(x.system, 120);
        stmts.push(insLine(env, o));
      }
      await env.DB.batch(stmts); await touch(env, me, id); return json({ ok: true });
    }
    // several lines at once: {ids, room_id?, system?, delete?, qty?}
    if (sub === "/lines/bulk" && M === "POST") {
      const b = await body(), ids = (Array.isArray(b.ids) ? b.ids : []).map(x => Math.floor(numOr(x))).filter(x => x > 0).slice(0, 2000); if (!ids.length) return bad("Pick some lines.");
      const ph = ids.map(() => "?").join(",");
      if (b.delete) await env.DB.prepare(`DELETE FROM bid_lines WHERE bid_id = ? AND id IN (${ph})`).bind(id, ...ids).run();
      else { const set = []; const args = [];
        if ("room_id" in b) { set.push("room_id = ?"); args.push(b.room_id ? Math.floor(numOr(b.room_id)) : null); }
        if ("system" in b) { set.push("system = ?"); args.push(str(b.system, 120)); }
        if (b.copy_to_rooms) { // copy the picked lines into other rooms
          const rows = ((await env.DB.prepare(`SELECT * FROM bid_lines WHERE bid_id = ? AND id IN (${ph})`).bind(id, ...ids).all()).results || []).map(outLine), st = [];
          for (const rid of b.copy_to_rooms.slice(0, 200)) for (const l of rows) st.push(insLine(env, { ...l, room_id: Math.floor(numOr(rid)) || null, sort: Date.now(), source: "manual", src_key: "" }));
          for (let i = 0; i < st.length; i += 200) await env.DB.batch(st.slice(i, i + 200)); }
        if (set.length) await env.DB.prepare(`UPDATE bid_lines SET ${set.join(", ")} WHERE bid_id = ? AND id IN (${ph})`).bind(...args, id, ...ids).run(); }
      await touch(env, me, id); return json({ ok: true });
    }
    // pull current catalog prices and labor into every line that came from the catalog (or reprice at the bid's margin)
    if (sub === "/refresh" && M === "POST") {
      const b = await body(); if ("margin_pct" in b) await env.DB.prepare("UPDATE bids SET margin_pct = ? WHERE id = ?").bind(b.margin_pct === null || b.margin_pct === "" ? null : Math.min(95, Math.max(0, numOr(b.margin_pct))), id).run();
      const bid2 = await env.DB.prepare("SELECT * FROM bids WHERE id = ?").bind(id).first();
      const lines = (await env.DB.prepare("SELECT * FROM bid_lines WHERE bid_id = ? AND item_id IS NOT NULL").bind(id).all()).results || [], st = [];
      let n = 0;
      for (const l of lines) { const o = await lineFromItem(env, l.item_id, bid2); if (!o) continue; n++;
        if (b.at_margin && bid2.margin_pct != null && (o.kind === "product" || o.kind === "package") && o.unit_cost) { const s = r4(o.unit_cost / (1 - bid2.margin_pct / 100)); if (o.kind === "product" && o.tax_base) o.tax_base = s; else if (o.unit_price) o.tax_base = r4(o.tax_base * s / o.unit_price); o.unit_price = s; }
        st.push(env.DB.prepare("UPDATE bid_lines SET unit_cost = ?, unit_price = ?, tax_base = ?, labor = ?, contents = ? WHERE id = ?").bind(o.unit_cost, o.unit_price, o.tax_base, JSON.stringify(o.labor), JSON.stringify(o.contents), l.id)); }
      for (let i = 0; i < st.length; i += 200) await env.DB.batch(st.slice(i, i + 200));
      await touch(env, me, id); return json({ ok: true, updated: n });
    }
  }
  m = p.match(/^\/api\/rooms\/(\d+)$/);
  if (m) {
    const rid = Number(m[1]), rm = await env.DB.prepare("SELECT * FROM bid_rooms WHERE id = ?").bind(rid).first(); if (!rm) return bad("That room is gone.", 404);
    if (M === "PUT") { const b = await body();
      if ("name" in b) { const n = str(b.name, 120); if (!n) return bad("Enter a name."); await env.DB.prepare("UPDATE bid_rooms SET name = ? WHERE id = ?").bind(n, rid).run(); }
      if ("sort" in b) await env.DB.prepare("UPDATE bid_rooms SET sort = ? WHERE id = ?").bind(numOr(b.sort), rid).run();
      await touch(env, me, rm.bid_id); return json({ ok: true }); }
    if (M === "DELETE") { // the room, its sub-rooms and their lines
      const all = (await env.DB.prepare("SELECT id, parent_id FROM bid_rooms WHERE bid_id = ?").bind(rm.bid_id).all()).results || [], kill = new Set([rid]);
      for (let k = 0; k < 3; k++) for (const r of all) if (kill.has(r.parent_id)) kill.add(r.id);
      const ids = [...kill], ph = ids.map(() => "?").join(",");
      await env.DB.batch([env.DB.prepare(`DELETE FROM bid_lines WHERE room_id IN (${ph})`).bind(...ids), env.DB.prepare(`DELETE FROM bid_rooms WHERE id IN (${ph})`).bind(...ids)]);
      await touch(env, me, rm.bid_id); return json({ ok: true }); }
  }
  m = p.match(/^\/api\/lines\/(\d+)$/);
  if (m) {
    const lid = Number(m[1]), l = await env.DB.prepare("SELECT * FROM bid_lines WHERE id = ?").bind(lid).first(); if (!l) return bad("That line is gone.", 404);
    if (M === "PUT") { const b = await body(), set = {};
      if ("qty" in b) set.qty = Math.max(0, numOr(b.qty));
      if ("unit_price" in b) { const v = b.unit_price === null || b.unit_price === "" ? (l.kind === "labor" ? null : 0) : r4(Math.max(0, numOr(b.unit_price)));
        set.unit_price = v;
        if (l.kind === "product") { const it = l.item_id ? await env.DB.prepare("SELECT taxable FROM bid_catalog WHERE id = ?").bind(l.item_id).first() : null;
          set.tax_base = (l.tax_base > 0 || (it ? it.taxable : !l.item_id)) ? (v || 0) : 0; }
        else if (l.tax_base && l.unit_price) set.tax_base = v == null ? 0 : r4(l.tax_base * v / l.unit_price); }
      if ("unit_cost" in b) set.unit_cost = r4(Math.max(0, numOr(b.unit_cost)));
      if ("system" in b) set.system = str(b.system, 120);
      if ("room_id" in b) set.room_id = b.room_id ? Math.floor(numOr(b.room_id)) : null;
      if ("description" in b) set.description = str(b.description, 1000);
      if ("note" in b) set.note = str(b.note, 1000);
      if ("labor" in b) set.labor = JSON.stringify(cleanLabor(b.labor));
      const ks = Object.keys(set); if (ks.length) await env.DB.prepare(`UPDATE bid_lines SET ${ks.map(k => k + " = ?").join(", ")} WHERE id = ?`).bind(...ks.map(k => set[k]), lid).run();
      await touch(env, me, l.bid_id); return json({ ok: true }); }
    if (M === "DELETE") { await env.DB.prepare("DELETE FROM bid_lines WHERE id = ?").bind(lid).run(); await touch(env, me, l.bid_id); return json({ ok: true }); }
  }
  return null;
}

function msgPage(text, status) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SIS Bids</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f1f0ec;color:#1b2027;font:15px/1.45 system-ui,sans-serif;padding:16px}div{max-width:420px;background:#fff;border:1px solid #dedbd3;border-radius:12px;padding:20px}
@media (prefers-color-scheme:dark){body{background:#12151a;color:#e6e9ee}div{background:#191d23;border-color:#2c323b}}</style></head><body><div>${text}</div></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...SECURITY } });
}
function devPage(url) {
  const next = url.searchParams.get("next") || "/";
  return msgPage(`<form method="get" action="/__dev"><p><b>Local test sign-in</b></p><p><input name="email" placeholder="email" style="width:100%;padding:8px"></p><input type="hidden" name="next" value="${next.replace(/"/g, "")}"><button>Sign in</button></form>`, 200);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (devLocal(env, url) && url.pathname === "/__dev") {
        const e = url.searchParams.get("email"); if (!e) return devPage(url);
        return new Response(null, { status: 303, headers: { Location: url.searchParams.get("next") || "/", "Set-Cookie": `dev_email=${encodeURIComponent(e.toLowerCase())}; Path=/; SameSite=Lax` } });
      }
      if (!env.DB) return msgPage("Bind SIS Tools' D1 database to this Pages project as <b>DB</b>, then deploy again.", 501);
      const email = await accessEmail(req, env, url);
      if (!email) {
        if (devLocal(env, url) && !url.pathname.startsWith("/api/")) return new Response(null, { status: 303, headers: { Location: "/__dev?next=" + encodeURIComponent(url.pathname) } });
        return url.pathname.startsWith("/api/") ? bad("Sign in required", 401) : msgPage(`Sign-in didn't come through.<br><br><small style="opacity:.75">${String(req.signinWhy || "Reload the page to sign in again.").replace(/[<>&]/g, "")}</small>`, 401);
      }
      await init(env.DB);
      const me = await personOf(env, email);
      if (!me || me.level === "none") return url.pathname.startsWith("/api/") ? bad("No access", 403) : msgPage(`You don't have access to SIS Bids. It's open to Project Managers and up. Ask an admin if you need it.<br><br><a href="https://${env.SIS_TOOLS_HOST || "sistools.thefhouse.net"}">Back to SIS Tools</a>`, 403);
      if (url.pathname.startsWith("/api/")) {
        if (req.method !== "GET" && req.headers.get("Origin") && req.headers.get("Origin") !== url.origin) return bad("Bad origin", 403);
        if (url.pathname === "/api/me") return json({ me, sisTools: "https://" + (env.SIS_TOOLS_HOST || "sistools.thefhouse.net") });
        if (url.pathname.startsWith("/api/settings")) { const r = await settingsApi(req, env, url, me); if (r) return r; }
        if (url.pathname.startsWith("/api/catalog")) { const r = await catalogApi(req, env, url, me); if (r) return r; }
        if (/^\/api\/(jobs|bids|rooms|lines)(\/|$)/.test(url.pathname)) { const r = await bidsApi(req, env, url, me); if (r) return r; }
        return bad("Not found", 404);
      }
      const res = await env.ASSETS.fetch(req), out = new Response(res.body, res);
      for (const [k, v] of Object.entries(SECURITY)) out.headers.set(k, v);
      out.headers.set("Cache-Control", "private, no-cache");
      return out;
    } catch (e) {
      return bad("Server error: " + String(e && e.message || e).slice(0, 200), 500);
    }
  },
};
