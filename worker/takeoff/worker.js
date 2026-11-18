// SIS Bids: the Electrical Takeoff moved here from SIS Tools (Tony, 2026-11-18). Its tables are bto_* (a clean start, so
// SIS Tools' old takeoff_* jobs are left alone) and plan PDFs go to the R2 bucket bound as FILES, under takeoff/.
// Originally the SIS Tools site entry. build_hub.mjs bundles this file (and everything it imports) into takeoff-api.js, which the
// hub appends to its _worker.js as TOOL_TAKEOFF. The hub calls handle(req, env, url, me, { level }) after sign-in for
// paths under /api/takeoff/ and serves the page itself from /takeoff/ (static files).
//
// Site settings it uses:
//   DB                  D1 database (already bound for every tool); Takeoff tables are named takeoff_*.
//   ANTHROPIC_API_KEY   secret, the same one Panels / SOP / AV use.
//   TAKEOFF_FILES       R2 bucket for plan PDFs (optional: without it the PHOTOS bucket is used, under takeoff/).
//   TAKEOFF_DAILY_USD   optional daily Claude spend cap for Takeoff in dollars (default: no cap).
//   TAKEOFF_MODEL       optional model override (default claude-opus-5-5).
import { setDb } from "./db.js";
import { d1Driver } from "./d1.js";
import { configureClaude } from "./analyze.js";
import { handleApi } from "./api.js";

export const prefixes = ["/api/takeoff/"];

function r2Files(bucket, prefix) {
  const need = () => { if (!bucket) throw Object.assign(new Error("Plan storage isn't connected yet. Create the R2 bucket sis-bids-files in Cloudflare, then it gets bound as FILES."), { status: 503 }); };
  const key = (name) => `${prefix}${name}`;
  return {
    async put(name, bytes) { need(); await bucket.put(key(name), bytes, { httpMetadata: { contentType: "application/pdf" } }); },
    async get(name) { need(); const o = await bucket.get(key(name)); return o ? { body: o.body, size: o.size } : null; },
    async bytes(name) { need(); const o = await bucket.get(key(name)); return o ? new Uint8Array(await o.arrayBuffer()) : new Uint8Array(); },
    async size(name) { need(); const o = await bucket.head(key(name)); return o ? o.size : null; },
    async delete(name) { if (bucket) await bucket.delete(key(name)); },
  };
}

// ---- SIS projects (Tony, 2026-11-09): the New project page picks a project from the SIS Tools project list (Crew Board jobs,
// coll "jobs" in the shared docs table) and fills its name, address and sales tax. Read only; Takeoff never changes a project.
const docsAll = async (env, coll) => {
  const { results } = await env.DB.prepare("SELECT id, data FROM docs WHERE coll = ?").bind(coll).all();
  const out = {}; for (const r of results || []) { try { out[r.id] = JSON.parse(r.data); } catch (e) {} } return out;
};
async function sisProjects(env) {
  const emps = await docsAll(env, "employees").catch(() => ({}));
  return Object.entries(await docsAll(env, "jobs").catch(() => ({}))).filter(([, j]) => j && !j.deleted && (j.no || j.name)).map(([id, j]) => {
    const e = j.foreman && emps[j.foreman];
    return { id, no: String(j.no || ""), name: String(j.name || ""), address: String(j.addr || ""), state: String(j.state || ""), div: String(j.div || ""),
      wo: j.kind === "wo", status: String(j.status || ""), pm: e ? String(e.name || "") : "" };
  }).sort((a, b) => (a.wo - b.wo) || (a.status === "complete") - (b.status === "complete") || (b.no + " " + b.name).localeCompare(a.no + " " + a.name, undefined, { numeric: true }));
}
// Sales tax: Nevada charges one rate per county; California rates come from the CDTFA rate-by-address service. Any rate typed on
// the New project page is remembered for that county (D1 setting "takeoffTax") and wins over the built-in list next time.
// Built-in Nevada county rates (combined state + county, %): check them against the Nevada Department of Taxation table.
const NV_TAX = { Washoe: 8.265, "Carson City": 7.6, Douglas: 7.1, Lyon: 7.1, Storey: 7.6, Clark: 8.375 };
const ZIP_RE = /\b(\d{5})(?:-\d{4})?\s*$/;
const getSet = async (env, k) => { try { const r = await env.DB.prepare("SELECT v FROM settings WHERE k = ?").bind(k).first(); return r ? JSON.parse(r.v) : null; } catch (e) { return null; } };
const putSet = (env, k, v) => env.DB.prepare("INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").bind(k, JSON.stringify(v)).run();
async function countyOf(address) {
  const r = await fetch("https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress?" + new URLSearchParams({ address, benchmark: "Public_AR_Current", vintage: "Current_Current", layers: "Counties", format: "json" }), { cf: { cacheTtl: 86400 } });
  if (!r.ok) return null;
  const m = (await r.json())?.result?.addressMatches?.[0]; if (!m) return null;
  const c = m.geographies?.Counties?.[0] || {}, st = m.addressComponents?.state || "";
  const county = String(c.BASENAME || c.NAME || "").replace(/ County$/i, "");
  return county ? { county, state: st, matched: m.matchedAddress || "" } : null;
}
async function caRate(address) {
  // CDTFA: GetRateByAddress?address=&city=&zip= ; the address is "street, city, CA zip"
  const parts = address.split(",").map((x) => x.trim()), zip = (address.match(ZIP_RE) || [])[1] || "";
  const r = await fetch("https://services.maps.cdtfa.ca.gov/api/taxrate/GetRateByAddress?" + new URLSearchParams({ address: parts[0] || "", city: parts[1] || "", zip }), { cf: { cacheTtl: 86400 } });
  if (!r.ok) return null;
  const d = await r.json(), info = (d.taxRateInfo || d.TaxRateInfo || [])[0];
  const rate = info ? Number(info.rate ?? info.Rate) : NaN;
  return isFinite(rate) && rate > 0 ? { rate: Math.round((rate < 1 ? rate * 100 : rate) * 1000) / 1000, place: String(info.jurisdiction || info.city || "") } : null;
}
async function sisTax(env, address, state) {
  const saved = (await getSet(env, "takeoffTax")) || {};
  let where = null; try { where = await countyOf(address); } catch (e) {}
  const st = (where?.state || state || (/\bCA\b/.test(address) ? "CA" : /\bNV\b/.test(address) ? "NV" : "")).toUpperCase();
  const key = where ? `${st}:${where.county}` : "";
  if (key && saved[key] != null) return { rate: saved[key], county: where.county, state: st, source: "saved" };
  if (st === "CA") { try { const c = await caRate(address); if (c) return { rate: c.rate, county: where?.county || "", state: st, source: "cdtfa", place: c.place }; } catch (e) {} }
  if (st === "NV" && where && NV_TAX[where.county] != null) return { rate: NV_TAX[where.county], county: where.county, state: st, source: "nv" };
  return { rate: null, county: where?.county || "", state: st, source: "none" };
}
async function sisRoutes(req, env, p, url, level) {
  if (p === "/api/takeoff/sis-projects" && req.method === "GET") return Response.json({ projects: await sisProjects(env) });
  if (p === "/api/takeoff/sis-tax" && req.method === "GET") {
    const address = (url.searchParams.get("address") || "").trim().slice(0, 200);
    if (!address) return Response.json({ rate: null, source: "none" });
    return Response.json(await sisTax(env, address, url.searchParams.get("state") || ""));
  }
  if (p === "/api/takeoff/sis-tax" && req.method === "PUT") {
    if (level !== "edit") return Response.json({ error: "View only." }, { status: 403 });
    const b = await req.json().catch(() => ({})), st = String(b.state || "").toUpperCase().slice(0, 2), county = String(b.county || "").trim().slice(0, 60), rate = Number(b.rate);
    if (!/^[A-Z]{2}$/.test(st) || !county || !isFinite(rate) || rate < 0 || rate > 20) return Response.json({ error: "Bad tax rate" }, { status: 400 });
    const saved = (await getSet(env, "takeoffTax")) || {}; saved[`${st}:${county}`] = Math.round(rate * 1000) / 1000; await putSet(env, "takeoffTax", saved);
    return Response.json({ ok: true });
  }
  return null;
}

export async function handle(req, env, url, me, opts = {}) {
  const p = url.pathname;
  if (!p.startsWith("/api/takeoff/")) return null;
  if (!env.DB) return Response.json({ error: "The site's D1 database (DB) isn't bound." }, { status: 503 });
  setDb(d1Driver(env.DB, "bto_"));
  configureClaude({ apiKey: env.ANTHROPIC_API_KEY, model: env.TAKEOFF_MODEL });
  const bucket = env.FILES || null;
  const ctx = {
    files: r2Files(bucket, "takeoff/"),
    me, level: opts.level || (me ? "none" : "edit"),
    dailyCapUsd: Number(env.TAKEOFF_DAILY_USD) || 0, // no cap unless the site sets one
  };
  if (ctx.level === "none") return Response.json({ error: "You don't have access to Takeoff. Ask an Admin." }, { status: 403 });
  if (p.startsWith("/api/takeoff/sis-")) { const r = await sisRoutes(req, env, p, url, ctx.level); if (r) return r; }
  return handleApi(req, p.slice("/api/takeoff".length), ctx);
}
