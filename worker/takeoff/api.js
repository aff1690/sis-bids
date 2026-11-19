// Takeoff API: one fetch-style handler used by the local server (node/index.js) and the SIS Tools site (worker.js).
//   handleApi(req, path, ctx) -> Response
//   path: the part after the API prefix ("/jobs/1"); ctx: { files, me, level, dailyCapUsd }
// Storage is the shared `db` driver (db.js); plan PDFs go through ctx.files (local disk or Cloudflare R2).
import { db, DEFAULT_SETTINGS, jobSettings, getJob, ensureSchema } from "./db.js";
import { DEVICE_TYPES, TYPE_KEYS } from "./deviceTypes.js";
import { importDTools, searchCatalog, upsertItem } from "./catalog.js";
import { analyzeSheet, autoZone, extractLoads, extractFixtures, codeCheck, assignRooms, hasApiKey } from "./analyze.js";
import { sizeLoad, dedupeLoads, reconcileLoads } from "./loads.js";
import { buildEstimate, estimateCsv, loadAssemblies, jobAssemblies, resolveLines } from "./estimate.js";
import { seedSpecs, loadSpecs, relinkSpecs, listSpecs, getSpec, specPrompt, sizeSystem, jobSpecs, pointsPerFoot, renumberZones,
  splitCrossRoomZones, mergeLoneFixtureZones, mergeExteriorWallZones, BASES, DEFAULT_RULES, FIXTURE_TYPES, CONTROL_TYPES, ZONE_CONTROLS } from "./specs.js";

// ---------------------------------------------------------------- responses
const HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: HEADERS });
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };
const notFound = () => fail(404, "Not found");

function errorMessage(e) {
  if (e.type === "authentication_error") return "Anthropic rejected the API key (ANTHROPIC_API_KEY).";
  if (e.type === "rate_limit_error") return "Anthropic rate limit reached. Wait a minute and try again.";
  if (e.type === "overloaded_error") return "Claude is busy right now. Try again in a minute.";
  if (e.type === "invalid_request_error") return `Claude request error: ${e.message}`;
  return e.message || String(e);
}

/**
 * Claude calls can run for minutes. The SIS site sits behind Cloudflare, which drops a request that sends nothing for
 * 100 seconds, so these answers stream: a space every 10 s while Claude works, then the JSON (always status 200;
 * failures come back as {"error": ...}). The browser's api() reads both the same way.
 */
function longJob(work) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    async start(ctrl) {
      const beat = setInterval(() => { try { ctrl.enqueue(enc.encode(" ")); } catch { /* closed */ } }, 10000);
      ctrl.enqueue(enc.encode(" "));
      let out;
      try { out = JSON.stringify(await work()); } catch (e) { console.error(e); out = JSON.stringify({ error: errorMessage(e) }); }
      clearInterval(beat);
      ctrl.enqueue(enc.encode(out));
      ctrl.close();
    },
  });
  return new Response(body, { headers: { ...HEADERS, "Cache-Control": "no-store, no-transform", "X-Long-Job": "1" } });
}

// ---------------------------------------------------------------- small helpers
const readJson = async (req) => { try { return await req.json(); } catch { return {}; } };

function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function nearestRoomId(sheetId, x, y) {
  // Inside a room's outline wins (smallest room if they overlap); otherwise the nearest room label.
  const inside = await db.prepare(`SELECT id, (bx1 - bx0) * (by1 - by0) AS area FROM rooms WHERE sheet_id = ? AND bx0 IS NOT NULL
    AND ? BETWEEN bx0 AND bx1 AND ? BETWEEN by0 AND by1 ORDER BY area LIMIT 1`).get(sheetId, x, y);
  if (inside) return inside.id;
  let best = null, bestD = Infinity;
  for (const r of await db.prepare("SELECT id, x, y FROM rooms WHERE sheet_id = ? AND x IS NOT NULL").all(sheetId)) {
    const d = Math.hypot(r.x - x, r.y - y);
    if (d < bestD) { bestD = d; best = r.id; }
  }
  return best;
}

// ---------------------------------------------------------------- Claude spend: log every call, daily cap
const today = () => new Date().toISOString().slice(0, 10);
async function spend() {
  const d = today(), m = d.slice(0, 7);
  const t = await db.prepare("SELECT COALESCE(SUM(cost_usd), 0) c, count(*) n FROM usage WHERE day = ?").get(d);
  const mo = await db.prepare("SELECT COALESCE(SUM(cost_usd), 0) c FROM usage WHERE day LIKE ?").get(`${m}%`);
  return { today: +Number(t.c).toFixed(2), calls_today: t.n, month: +Number(mo.c).toFixed(2) };
}
async function checkCap(ctx) {
  if (!(ctx.dailyCapUsd > 0)) return;
  const s = await spend();
  if (s.today >= ctx.dailyCapUsd) fail(429, `Today's Claude limit for Takeoff ($${ctx.dailyCapUsd}) is used up ($${s.today} spent). It resets at midnight UTC; an Admin can raise TAKEOFF_DAILY_USD.`);
}
async function logUsage(ctx, jobId, kind, usage) {
  if (!usage) return;
  await db.prepare("INSERT INTO usage (day, email, job_id, kind, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(today(), ctx.me?.email || "", jobId ?? null, kind, usage.input || 0, usage.output || 0, usage.cost_usd || 0);
}
/** Run a Claude job: cap check first, usage logged after, streamed to the browser. */
const claudeJob = (ctx, jobId, kind, work) => longJob(async () => {
  await checkCap(ctx);
  const out = await work();
  await logUsage(ctx, jobId, kind, out.usage);
  return out;
});

// ---------------------------------------------------------------- router
const routes = [];
const on = (method, pattern, fn) => {
  const keys = [];
  const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (m, k) => { keys.push(k); return "([^/]+)"; }) + "/?$");
  routes.push({ method, re, keys, fn });
};

let ready = null;
/** Tables, starter specs: once per server process (or per Cloudflare isolate). */
export function prepare() {
  ready ??= (async () => { await ensureSchema(); await seedSpecs(); })().catch((e) => { ready = null; throw e; });
  return ready;
}

export async function handleApi(req, path, ctx) {
  try {
    const url = new URL(req.url);
    const r = routes.find((x) => x.method === req.method && x.re.test(path));
    if (!r) return json({ error: "Not found" }, 404);
    if (req.method !== "GET" && ctx.level && ctx.level !== "edit") return json({ error: "View only: ask an Admin for Edit access to Takeoff." }, 403);
    await prepare();
    await loadSpecs();
    const m = path.match(r.re);
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    const out = await r.fn({ req, params, query: url.searchParams, ctx });
    return out instanceof Response ? out : json(out);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    return json({ error: errorMessage(e) }, e.status && e.status >= 400 && e.status < 600 ? e.status : 500);
  }
}

// ---------------------------------------------------------------- meta
on("GET", "/meta", async ({ ctx }) => ({
  device_types: DEVICE_TYPES, default_settings: DEFAULT_SETTINGS,
  spec_bases: BASES, default_rules: DEFAULT_RULES, fixture_types: FIXTURE_TYPES, control_types: CONTROL_TYPES, zone_controls: ZONE_CONTROLS,
  has_api_key: hasApiKey(),
  catalog_count: (await db.prepare("SELECT count(*) n FROM catalog").get()).n,
  me: ctx.me ? { email: ctx.me.email, name: ctx.me.name } : null, level: ctx.level || "edit",
  spend: { ...(await spend()), cap: ctx.dailyCapUsd || 0 },
}));
on("GET", "/usage", async ({ ctx }) => ({
  ...(await spend()), cap: ctx.dailyCapUsd || 0,
  by_job: await db.prepare(`SELECT u.job_id, j.name, ROUND(SUM(u.cost_usd), 2) cost, count(*) calls FROM usage u LEFT JOIN jobs j ON j.id = u.job_id
    GROUP BY u.job_id ORDER BY MAX(u.id) DESC LIMIT 50`).all(),
}));

// ---------------------------------------------------------------- jobs
on("GET", "/jobs", () => db.prepare(`
  SELECT j.*, (SELECT count(*) FROM devices d WHERE d.job_id = j.id) AS device_count,
    (SELECT ROUND(COALESCE(SUM(cost_usd), 0), 2) FROM usage u WHERE u.job_id = j.id) AS claude_cost
  FROM jobs j ORDER BY j.id DESC`).all());

on("POST", "/jobs", async ({ req }) => {
  const { name, address = "", job_type = "new" } = await readJson(req);
  if (!name) fail(400, "Job name is required");
  return db.prepare("INSERT INTO jobs (name, address, job_type) VALUES (?, ?, ?) RETURNING *").get(name, address, job_type);
});

on("GET", "/jobs/:id", async ({ params }) => {
  const job = await getJob(params.id);
  if (!job) notFound();
  const id = job.id;
  const q = (sql) => db.prepare(sql).all(id);
  const [plans, sheets, rooms, devices, zones, equipment, loads, findings, tape, hrs, circuits] = await Promise.all([
    q("SELECT * FROM plans WHERE job_id = ? ORDER BY id"),
    q("SELECT * FROM sheets WHERE job_id = ? ORDER BY plan_id, page"),
    q("SELECT * FROM rooms WHERE job_id = ? ORDER BY level, number, name"),
    q("SELECT * FROM devices WHERE job_id = ?"),
    q("SELECT * FROM zones WHERE job_id = ? ORDER BY sheet_id, code"),
    q("SELECT * FROM equipment WHERE job_id = ? ORDER BY id"),
    q("SELECT * FROM loads WHERE job_id = ? ORDER BY category, name"),
    q("SELECT * FROM code_findings WHERE job_id = ? ORDER BY sheet_id, status, id"),
    q("SELECT * FROM tape_runs WHERE job_id = ?"),
    q("SELECT * FROM homeruns WHERE job_id = ?"),
    q("SELECT * FROM circuits WHERE job_id = ? ORDER BY id"),
  ]);
  return {
    job: { ...job, settings: jobSettings(job) }, plans,
    sheets: sheets.map((s) => ({ ...s, analysis: s.analysis ? JSON.parse(s.analysis) : null })),
    rooms, devices, zones, equipment, loads, findings,
    tape_runs: tape.map((t) => ({ ...t, points: JSON.parse(t.points || "[]") })),
    homeruns: hrs.map((r) => ({ ...r, points: JSON.parse(r.points || "[]") })),
    circuits,
  };
});

on("PATCH", "/jobs/:id", async ({ req, params }) => {
  const job = await getJob(params.id);
  if (!job) notFound();
  const b = await readJson(req);
  const settings = b.settings ? { ...jobSettings(job), ...b.settings } : jobSettings(job);
  await db.prepare("UPDATE jobs SET name = ?, address = ?, job_type = ?, settings = ? WHERE id = ?")
    .run(b.name ?? job.name, b.address ?? job.address, b.job_type ?? job.job_type, JSON.stringify(settings), job.id);
  return { ok: true };
});

on("DELETE", "/jobs/:id", async ({ params, ctx }) => {
  for (const p of await db.prepare("SELECT stored_name FROM plans WHERE job_id = ?").all(params.id)) await ctx.files.delete(p.stored_name);
  await db.prepare("DELETE FROM jobs WHERE id = ?").run(params.id);
  return { ok: true };
});

// ---------------------------------------------------------------- plans & sheets
on("POST", "/jobs/:id/plans", async ({ req, params, query, ctx }) => {
  if (!(await getJob(params.id))) notFound();
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (!bytes.length || String.fromCharCode(...bytes.subarray(0, 5)) !== "%PDF-") fail(400, "Upload a PDF file");
  const stored = `${crypto.randomUUID()}.pdf`;
  await ctx.files.put(stored, bytes);
  const filename = String(query.get("filename") || "plans.pdf").slice(0, 200);
  const docType = ["plans", "appliance", "mechanical", "lighting"].includes(query.get("doc_type")) ? query.get("doc_type") : "plans";
  return db.prepare("INSERT INTO plans (job_id, filename, stored_name, doc_type) VALUES (?, ?, ?, ?) RETURNING *").get(params.id, filename, stored, docType);
});

on("GET", "/plans/:id/file", async ({ params, ctx }) => {
  const p = await db.prepare("SELECT * FROM plans WHERE id = ?").get(params.id);
  if (!p) notFound();
  const f = await ctx.files.get(p.stored_name);
  if (!f) fail(404, "The PDF file is missing from storage.");
  return new Response(f.body, { headers: { "Content-Type": "application/pdf", "Cache-Control": "private, max-age=86400", ...(f.size ? { "Content-Length": String(f.size) } : {}) } });
});

on("DELETE", "/plans/:id", async ({ params, ctx }) => {
  const p = await db.prepare("SELECT * FROM plans WHERE id = ?").get(params.id);
  if (!p) notFound();
  await ctx.files.delete(p.stored_name);
  await db.prepare("DELETE FROM plans WHERE id = ?").run(p.id);
  return { ok: true };
});

// Browser parses the PDF with pdf.js and posts page info (sheet no., title, kind).
on("POST", "/plans/:id/sheets", async ({ req, params }) => {
  const plan = await db.prepare("SELECT * FROM plans WHERE id = ?").get(params.id);
  if (!plan) notFound();
  const sheets = (await readJson(req)).sheets || [];
  const ins = db.prepare(`INSERT INTO sheets (plan_id, job_id, page, sheet_no, title, kind, level, width, height)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(plan_id, page) DO NOTHING`);
  await db.batch([
    ...sheets.map((s) => ins.bind(plan.id, plan.job_id, s.page, s.sheet_no || "", s.title || "", s.kind || "other", s.level || "", s.width, s.height)),
    db.prepare("UPDATE plans SET page_count = ? WHERE id = ?").bind(sheets.length, plan.id),
  ]);
  return { ok: true };
});

on("PATCH", "/sheets/:id", async ({ req, params }) => {
  const s = await db.prepare("SELECT * FROM sheets WHERE id = ?").get(params.id);
  if (!s) notFound();
  const b = await readJson(req);
  await db.prepare("UPDATE sheets SET sheet_no = ?, title = ?, kind = ?, level = ? WHERE id = ?")
    .run(b.sheet_no ?? s.sheet_no, b.title ?? s.title, b.kind ?? s.kind, b.level ?? s.level, s.id);
  if (b.level != null) await db.prepare("UPDATE rooms SET level = ? WHERE sheet_id = ?").run(b.level, s.id);
  return { ok: true };
});

on("POST", "/sheets/:id/analyze", async ({ req, params, ctx }) => {
  const sheet = await db.prepare("SELECT * FROM sheets WHERE id = ?").get(params.id);
  if (!sheet) notFound();
  const { overview, tiles, textItems } = await readJson(req);
  if (!overview?.png || !Array.isArray(tiles) || !tiles.length) fail(400, "Missing sheet images");
  const job = await getJob(sheet.job_id);
  return claudeJob(ctx, job.id, "analyze", async () => {
    // The job's "Look for" list (Tony, 2026-11-19): only these device types are counted, each tagged with its catalog item.
    const lookfor = (jobSettings(job).lookfor || []).filter((l) => TYPE_KEYS.includes(l.type));
    const result = await analyzeSheet({ sheet, overview, tiles, textItems: textItems || [], specText: specPrompt(jobSettings(job)), lookfor });
    const itemFor = new Map(lookfor.filter((l) => Number(l.item_id) > 0).map((l) => [l.type, Math.floor(Number(l.item_id))]));
    if (lookfor.length) { const keep = new Set(lookfor.map((l) => l.type)); result.devices = result.devices.filter((d) => keep.has(d.type)); }
    const level = result.level_name || sheet.level;

    // Replace previous AI results on this sheet; keep anything entered by hand.
    await db.batch([
      db.prepare("DELETE FROM devices WHERE sheet_id = ? AND source = 'ai'").bind(sheet.id),
      db.prepare("DELETE FROM rooms WHERE sheet_id = ? AND source = 'ai'").bind(sheet.id),
      db.prepare("DELETE FROM equipment WHERE sheet_id = ? AND source = 'ai'").bind(sheet.id),
    ]);
    const insRoom = db.prepare("INSERT INTO rooms (job_id, sheet_id, level, number, name, x, y, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'ai') RETURNING id");
    const roomIdByNumber = new Map(), roomIdByName = new Map();
    const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
    for (const r of result.rooms) {
      const id = (await insRoom.get(sheet.job_id, sheet.id, level, r.number, r.name, r.x, r.y)).id;
      if (r.number) roomIdByNumber.set(norm(r.number), id);
      if (r.name) roomIdByName.set(norm(r.name), id); // names are unique on a sheet even without a number
    }
    const insDev = db.prepare(`INSERT INTO devices (job_id, sheet_id, room_id, type, x, y, source, status, confidence, note, item_id)
      VALUES (?, ?, ?, ?, ?, ?, 'ai', 'pending', ?, ?, ?)`);
    const writes = [];
    for (const d of result.devices) {
      // Number first, then the unique room name; the nearest label is only a last resort.
      const roomId = roomIdByNumber.get(norm(d.room_number)) ?? roomIdByName.get(norm(d.room_name)) ?? await nearestRoomId(sheet.id, d.x, d.y);
      writes.push(insDev.bind(sheet.job_id, sheet.id, roomId, d.type, d.x, d.y, d.confidence, d.note || "", itemFor.get(d.type) ?? null));
    }
    // Panels Claude found on the plan become suggested equipment markers (hand-placed ones win).
    const kindMap = { elec_panel: "elec_panel", subpanel: "elec_panel", lighting_panel: "dpm_panel" };
    const manualKinds = new Set((await db.prepare("SELECT kind FROM equipment WHERE sheet_id = ? AND source = 'manual'").all(sheet.id)).map((e) => e.kind));
    const insEq = db.prepare("INSERT INTO equipment (job_id, sheet_id, kind, name, x, y, source) VALUES (?, ?, ?, ?, ?, ?, 'ai')");
    for (const e of result.equipment) {
      const kind = kindMap[e.kind];
      if (!kind || e.x == null || manualKinds.has(kind)) continue;
      writes.push(insEq.bind(sheet.job_id, sheet.id, kind, e.label || kind, e.x, e.y));
    }
    // Generator evidence feeds the panel-spec recommendation.
    if (result.generator_evidence?.trim()) {
      const s = jobSettings(job);
      const hits = (s.generator?.hits || []).filter((h) => h.sheet !== (sheet.sheet_no || `p${sheet.page}`) || h.source !== "claude");
      hits.push({ sheet: sheet.sheet_no || `p${sheet.page}`, text: result.generator_evidence.trim().slice(0, 300), source: "claude" });
      writes.push(db.prepare("UPDATE jobs SET settings = ? WHERE id = ?").bind(JSON.stringify({ ...JSON.parse(job.settings || "{}"), generator: { ...(s.generator || {}), hits } }), job.id));
    }
    const analysis = { legend: result.legend, notes: result.notes, scale_text: result.scale_text, is_electrical_plan: result.is_electrical_plan, usage: result.usage, device_count: result.devices.length, equipment: result.equipment, generator_evidence: result.generator_evidence };
    writes.push(db.prepare("UPDATE sheets SET analysis = ?, analyzed_at = CURRENT_TIMESTAMP, level = ?, title = CASE WHEN title = '' THEN ? ELSE title END WHERE id = ?")
      .bind(JSON.stringify(analysis), level, result.sheet_title || "", sheet.id));
    await db.batch(writes);
    await renumberZones(sheet.job_id); // number any unnumbered rooms, refresh zone codes
    return { rooms: result.rooms.length, devices: result.devices.length, usage: result.usage, level };
  });
});

// ---------------------------------------------------------------- rooms
on("POST", "/jobs/:id/rooms", async ({ req, params }) => {
  const b = await readJson(req);
  if (!b.name) fail(400, "Room name is required");
  return db.prepare("INSERT INTO rooms (job_id, sheet_id, level, number, name, x, y) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *")
    .get(params.id, b.sheet_id ?? null, b.level || "", b.number || "", b.name, b.x ?? null, b.y ?? null);
});
on("PATCH", "/rooms/:id", async ({ req, params }) => {
  const r = await db.prepare("SELECT * FROM rooms WHERE id = ?").get(params.id);
  if (!r) notFound();
  const b = await readJson(req);
  await db.prepare("UPDATE rooms SET name = ?, number = ?, level = ?, auto_number = ? WHERE id = ?")
    .run(b.name ?? r.name, b.number ?? r.number, b.level ?? r.level, b.number != null ? 0 : r.auto_number, r.id);
  await renumberZones(r.job_id); // a typed number replaces the tool-assigned one; zone codes follow
  return { ok: true };
});
on("DELETE", "/rooms/:id", async ({ params }) => { await db.prepare("DELETE FROM rooms WHERE id = ?").run(params.id); return { ok: true }; });

// ---------------------------------------------------------------- devices
on("POST", "/jobs/:id/devices", async ({ req, params }) => {
  const b = await readJson(req);
  if (!TYPE_KEYS.includes(b.type)) fail(400, "Unknown device type");
  const roomId = b.room_id ?? (b.sheet_id && b.x != null ? await nearestRoomId(b.sheet_id, b.x, b.y) : null);
  const zoneOk = b.zone_id && await db.prepare("SELECT 1 FROM zones WHERE id = ?").get(b.zone_id);
  // source / status / confidence / zone are accepted so an undo can restore a deleted device as it was.
  return db.prepare(`INSERT INTO devices (job_id, sheet_id, room_id, zone_id, type, x, y, source, status, confidence, note, item_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`).get(params.id, b.sheet_id ?? null, roomId, zoneOk ? b.zone_id : null,
    b.type, b.x ?? null, b.y ?? null, ["ai", "manual", "code"].includes(b.source) ? b.source : "manual", b.status === "pending" ? "pending" : "confirmed",
    b.confidence ?? null, b.note || "", Number(b.item_id) > 0 ? Math.floor(Number(b.item_id)) : null);
});
on("PATCH", "/devices/:id", async ({ req, params }) => {
  const d = await db.prepare("SELECT * FROM devices WHERE id = ?").get(params.id);
  if (!d) notFound();
  const b = await readJson(req);
  if (b.type && !TYPE_KEYS.includes(b.type)) fail(400, "Unknown device type");
  const moved = b.x != null && (b.x !== d.x || b.y !== d.y);
  const roomId = b.room_id !== undefined ? b.room_id : moved && d.sheet_id ? await nearestRoomId(d.sheet_id, b.x, b.y) : d.room_id;
  let zoneId = b.zone_id !== undefined ? b.zone_id : d.zone_id;
  // Company rule: a zone never crosses rooms.
  const zone = zoneId ? await db.prepare("SELECT * FROM zones WHERE id = ?").get(zoneId) : null;
  if (zone?.room_id && roomId && zone.room_id !== roomId) {
    if (b.zone_id !== undefined && b.zone_id !== d.zone_id) {
      const rn = async (id) => { const r = await db.prepare("SELECT number, name FROM rooms WHERE id = ?").get(id); return r ? `${r.number} ${r.name}` : "another room"; };
      fail(400, `Zones never cross rooms: ${zone.code || zone.name} is in ${await rn(zone.room_id)}, this light is in ${await rn(roomId)}. Fix the light's room or use a zone in its own room.`);
    }
    zoneId = null; // moved into another room: it leaves the old room's zone
  }
  const itemId = b.item_id !== undefined ? (Number(b.item_id) > 0 ? Math.floor(Number(b.item_id)) : null) : d.item_id ?? null;
  const circuitId = b.circuit_id !== undefined ? (Number(b.circuit_id) > 0 ? Math.floor(Number(b.circuit_id)) : null) : d.circuit_id ?? null;
  await db.prepare("UPDATE devices SET type = ?, x = ?, y = ?, status = ?, note = ?, room_id = ?, zone_id = ?, item_id = ?, circuit_id = ? WHERE id = ?")
    .run(b.type ?? d.type, b.x ?? d.x, b.y ?? d.y, b.status ?? d.status, b.note ?? d.note, roomId, zoneId, itemId, circuitId, d.id);
  if (zoneId && zone && !zone.room_id && roomId) { // a new zone takes the room of its first light
    await db.prepare("UPDATE zones SET room_id = ? WHERE id = ?").run(roomId, zoneId);
    await renumberZones(d.job_id);
  }
  return db.prepare("SELECT * FROM devices WHERE id = ?").get(d.id);
});
// Attach a catalog product or package to Claude's counts of one device type (Tony, 2026-11-19): every device of that
// type that Claude found, or that has no item yet, counts as that item in the bid. Markers placed from the catalog keep
// theirs. item_id null goes back to the Settings default. all_sheets does the whole job instead of this sheet.
on("POST", "/sheets/:id/attach-item", async ({ req, params }) => {
  const sheet = await db.prepare("SELECT * FROM sheets WHERE id = ?").get(params.id);
  if (!sheet) notFound();
  const b = await readJson(req);
  if (!TYPE_KEYS.includes(b.type)) fail(400, "Unknown device type");
  const itemId = Number(b.item_id) > 0 ? Math.floor(Number(b.item_id)) : null;
  const where = b.all_sheets ? "job_id = ?" : "sheet_id = ?";
  const r = await db.prepare(`UPDATE devices SET item_id = ? WHERE ${where} AND type = ? AND (source = 'ai' OR item_id IS NULL OR item_id = ?)`)
    .run(itemId, b.all_sheets ? sheet.job_id : sheet.id, b.type, Number(b.prev_item_id) > 0 ? Math.floor(Number(b.prev_item_id)) : -1);
  return { ok: true, changed: r?.meta?.changes ?? r?.changes ?? null };
});
on("DELETE", "/devices/:id", async ({ params }) => { await db.prepare("DELETE FROM devices WHERE id = ?").run(params.id); return { ok: true }; });
on("POST", "/sheets/:id/confirm-all", async ({ params }) => {
  const r = await db.prepare("UPDATE devices SET status = 'confirmed' WHERE sheet_id = ? AND status = 'pending'").run(params.id);
  return { confirmed: r.changes };
});

// ---------------------------------------------------------------- catalog
on("GET", "/catalog", ({ query }) => searchCatalog(query.get("q"), Math.min(Number(query.get("limit")) || 50, 200)));
on("POST", "/catalog/import", async ({ req }) => {
  const r = await importDTools(await req.text());
  await relinkSpecs();
  return r;
});
on("POST", "/catalog", async ({ req }) => ({ id: await upsertItem({ source: "manual", ...(await readJson(req)) }) }));
on("DELETE", "/catalog/:id", async ({ params }) => { await db.prepare("DELETE FROM catalog WHERE id = ?").run(params.id); return { ok: true }; });

// ---------------------------------------------------------------- assemblies
on("GET", "/assemblies", () => loadAssemblies());
on("PUT", "/assemblies/:type", async ({ req, params }) => {
  if (!TYPE_KEYS.includes(params.type)) notFound();
  const items = ((await readJson(req)).items || []).map((it) => ({
    catalog_id: it.catalog_id || null, description: String(it.description || ""), qty: Number(it.qty) || 0,
    unit_cost: Number(it.unit_cost) || 0, labor_hours: it.labor_hours === "" || it.labor_hours == null ? null : Number(it.labor_hours),
    phase: it.phase === "Finish" ? "Finish" : "Rough",
  }));
  await db.prepare("INSERT INTO assemblies (device_type, items) VALUES (?, ?) ON CONFLICT(device_type) DO UPDATE SET items = excluded.items")
    .run(params.type, JSON.stringify(items));
  return { ok: true };
});

// ---------------------------------------------------------------- specs
const cleanLine = (it) => ({
  catalog_id: it.catalog_id || null, description: String(it.description || ""), qty: Number(it.qty) || 0,
  unit_cost: Number(it.unit_cost) || 0, labor_hours: it.labor_hours === "" || it.labor_hours == null ? null : Number(it.labor_hours),
  phase: ["Rough", "Finish", "System"].includes(it.phase) ? it.phase : "Rough",
  ...(it.basis ? { basis: Object.keys(BASES).includes(it.basis) ? it.basis : "job" } : {}),
});
function cleanSpecData(d = {}) {
  const overrides = {};
  for (const [type, lines] of Object.entries(d.overrides || {})) if (TYPE_KEYS.includes(type) && lines?.length) overrides[type] = lines.map(cleanLine);
  const rules = { ...DEFAULT_RULES };
  const numKeys = ["zones_per_dpm", "dpms_per_panel", "pd8_circuits_per_panel", "dpm_feeder_spaces", "dali_fixtures_per_module",
    "rf_devices_per_processor", "rf_range_ft", "receptacles_per_circuit", "panel_spaces", "fixture_watts", "lighting_circuit_amps",
    "continuous_load_pct", "kitchen_sa_circuits", "laundry_circuits",
    "watts_per_ft", "max_run_ft", "driver_watts", "driver_load_pct", "class2_max_watts", "class2_feed_ft", "channel_piece_ft", "vdrop_pct", "feeder_breaker"];
  for (const k of ["feeder_neutral", "feeder_disconnect"]) rules[k] = d.rules?.[k] != null ? !!d.rules[k] : DEFAULT_RULES[k];
  for (const k of numKeys) if (d.rules?.[k] != null) rules[k] = Math.max(0, Number(d.rules[k]) || 0) || DEFAULT_RULES[k];
  rules.tape_type = ["lucetta", "lumaris"].includes(d.rules?.tape_type) ? d.rules.tape_type : DEFAULT_RULES.tape_type;
  rules.breaker_family = ["eaton_br", "leviton"].includes(d.rules?.breaker_family) ? d.rules.breaker_family : DEFAULT_RULES.breaker_family;
  rules.rf_device_types = (d.rules?.rf_device_types || []).filter((t) => TYPE_KEYS.includes(t));
  rules.switched_types = (d.rules?.switched_types ?? DEFAULT_RULES.switched_types).filter((t) => TYPE_KEYS.includes(t));
  rules.default_zone_control = ZONE_CONTROLS.includes(d.rules?.default_zone_control) ? d.rules.default_zone_control : "wall";
  rules.zoning_required = !!d.rules?.zoning_required;
  return {
    control: ["standard", "rf", "panelized"].includes(d.control) ? d.control : "standard",
    description: String(d.description || ""), claude_notes: String(d.claude_notes || ""),
    overrides, system_items: (d.system_items || []).map((it) => cleanLine({ basis: "job", ...it })), rules,
    seed_version: d.seed_version, user_edited: true, // edited specs are never replaced by newer starter versions
  };
}
const withResolved = async (spec) => spec && ({
  ...spec,
  resolved: {
    overrides: Object.fromEntries(await Promise.all(Object.entries(spec.data.overrides || {}).map(async ([k, v]) => [k, await resolveLines(v)]))),
    system_items: await resolveLines(spec.data.system_items),
  },
});
on("GET", "/specs", () => listSpecs());
on("GET", "/specs/:id", async ({ params }) => { const s = getSpec(params.id); if (!s) notFound(); return withResolved(s); });
on("POST", "/specs", async ({ req }) => {
  const b = await readJson(req);
  const from = b.copy_from ? getSpec(b.copy_from) : null;
  const category = from?.category || (["devices", "lighting", "panels", "tape", "backup"].includes(b.category) ? b.category : "lighting");
  const name = String(b.name || (from ? `${from.name} (copy)` : "New spec"));
  const r = await db.prepare("INSERT INTO specs (name, category, data) VALUES (?, ?, ?) RETURNING id")
    .get(name, category, JSON.stringify(cleanSpecData(from?.data || b.data)));
  return { id: r.id };
});
on("PUT", "/specs/:id", async ({ req, params }) => {
  const s = getSpec(params.id);
  if (!s) notFound();
  const b = await readJson(req);
  await db.prepare("UPDATE specs SET name = ?, data = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(String(b.name || s.name), JSON.stringify(cleanSpecData(b.data)), s.id);
  return { ok: true };
});
on("DELETE", "/specs/:id", async ({ params }) => { await db.prepare("DELETE FROM specs WHERE id = ?").run(params.id); return { ok: true }; });

// The job's effective assemblies (base + specs) for display on the job Specs tab.
on("GET", "/jobs/:id/specs-summary", async ({ params }) => {
  const job = await getJob(params.id);
  if (!job) notFound();
  const s = jobSettings(job);
  const { asm, source } = await jobAssemblies(s);
  return {
    system: await sizeSystem(job.id, s),
    assemblies: Object.fromEntries(Object.entries(asm).map(([k, v]) => [k, { source: source[k], lines: v.map((l) => ({ description: l.resolved.description, qty: l.qty, part_number: l.catalog?.part_number || "" })) }])),
  };
});

// ---------------------------------------------------------------- circuits built by hand (Tony, 2026-11-19)
const CIRCUIT_CLS = ["power", "gfci", "lighting", "safety", "c240"];
on("POST", "/jobs/:id/circuits", async ({ req, params }) => {
  const b = await readJson(req);
  const n = (await db.prepare("SELECT COUNT(*) AS n FROM circuits WHERE job_id = ?").get(params.id))?.n || 0;
  const cls = CIRCUIT_CLS.includes(b.cls) ? b.cls : "power";
  const r = await db.prepare("INSERT INTO circuits (job_id, sheet_id, name, cls) VALUES (?, ?, ?, ?) RETURNING *")
    .get(params.id, b.sheet_id ?? null, String(b.name || `Circuit ${n + 1}`).slice(0, 80), cls);
  const ids = (Array.isArray(b.device_ids) ? b.device_ids : []).map(Number).filter((x) => x > 0);
  if (ids.length) await db.batch(ids.map((id) => db.prepare("UPDATE devices SET circuit_id = ? WHERE id = ? AND job_id = ?").bind(r.id, id, params.id)));
  return r;
});
on("PATCH", "/circuits/:id", async ({ req, params }) => {
  const c = await db.prepare("SELECT * FROM circuits WHERE id = ?").get(params.id);
  if (!c) notFound();
  const b = await readJson(req);
  await db.prepare("UPDATE circuits SET name = ?, cls = ? WHERE id = ?").run(b.name != null ? String(b.name).slice(0, 80) : c.name, CIRCUIT_CLS.includes(b.cls) ? b.cls : c.cls, c.id);
  return db.prepare("SELECT * FROM circuits WHERE id = ?").get(c.id);
});
on("DELETE", "/circuits/:id", async ({ params }) => {
  const c = await db.prepare("SELECT * FROM circuits WHERE id = ?").get(params.id);
  if (!c) return { ok: true };
  await db.batch([
    db.prepare("UPDATE devices SET circuit_id = NULL WHERE circuit_id = ?").bind(c.id),
    db.prepare("DELETE FROM homeruns WHERE job_id = ? AND key = ?").bind(c.job_id, `c:${c.id}`),
    db.prepare("DELETE FROM circuits WHERE id = ?").bind(c.id),
  ]);
  return { ok: true };
});

// ---------------------------------------------------------------- home runs (Tony, 2026-11-19)
// The tool suggests each home run; the estimator drags its bends to the real route and confirms it.
// The adjusted route's length replaces the estimate. reset:true goes back to the suggestion.
on("PUT", "/jobs/:id/homeruns", async ({ req, params }) => {
  const b = await readJson(req);
  const key = String(b.key || "");
  if (!/^[zc]:\d+$/.test(key)) fail(400, "Bad home run");
  if (b.reset) { await db.prepare("DELETE FROM homeruns WHERE job_id = ? AND key = ?").run(params.id, key); return { ok: true }; }
  const pts = (Array.isArray(b.points) ? b.points : []).slice(0, 40).map((p) => ({ x: Math.round(Number(p.x) * 10) / 10, y: Math.round(Number(p.y) * 10) / 10 })).filter((p) => isFinite(p.x) && isFinite(p.y));
  await db.prepare(`INSERT INTO homeruns (job_id, key, sheet_id, points, confirmed) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (job_id, key) DO UPDATE SET sheet_id = excluded.sheet_id, points = excluded.points, confirmed = excluded.confirmed`)
    .run(params.id, key, b.sheet_id ?? null, JSON.stringify(pts), b.confirmed ? 1 : 0);
  return db.prepare("SELECT * FROM homeruns WHERE job_id = ? AND key = ?").get(params.id, key).then((r) => ({ ...r, points: JSON.parse(r.points || "[]") }));
});

// ---------------------------------------------------------------- zones
on("POST", "/jobs/:id/zones", async ({ req, params }) => {
  const b = await readJson(req);
  // A zone made from lights takes their room (zones never cross rooms; split below if they do).
  const firstRoom = !b.room_id && b.device_ids?.length ? (await db.prepare("SELECT room_id FROM devices WHERE id = ?").get(b.device_ids[0]))?.room_id : null;
  const r = await db.prepare("INSERT INTO zones (job_id, sheet_id, room_id, name, control) VALUES (?, ?, ?, ?, ?) RETURNING *")
    .get(params.id, b.sheet_id ?? null, b.room_id ?? firstRoom ?? null, String(b.name || "New zone"), ZONE_CONTROLS.includes(b.control) ? b.control : "dpm");
  if (Array.isArray(b.device_ids) && b.device_ids.length) {
    const upd = db.prepare("UPDATE devices SET zone_id = ? WHERE id = ? AND job_id = ?");
    await db.batch(b.device_ids.map((id) => upd.bind(r.id, id, params.id)));
    await splitCrossRoomZones(r.job_id);
  }
  await renumberZones(r.job_id);
  return db.prepare("SELECT * FROM zones WHERE id = ?").get(r.id);
});
on("PATCH", "/zones/:id", async ({ req, params }) => {
  const z = await db.prepare("SELECT * FROM zones WHERE id = ?").get(params.id);
  if (!z) notFound();
  const b = await readJson(req);
  const ext = b.exterior !== undefined ? (b.exterior ? 1 : 0) : z.exterior ? 1 : 0;
  await db.prepare("UPDATE zones SET name = ?, control = ?, room_id = ?, exterior = ? WHERE id = ?")
    .run(b.name ?? z.name, ZONE_CONTROLS.includes(b.control) ? b.control : z.control, ext ? null : b.room_id !== undefined ? b.room_id : z.room_id, ext, z.id);
  if (!ext && z.exterior) await splitCrossRoomZones(z.job_id); // back to an interior zone: rooms split it again
  await renumberZones(z.job_id);
  return db.prepare("SELECT * FROM zones WHERE id = ?").get(z.id);
});
on("DELETE", "/zones/:id", async ({ params }) => {
  const z = await db.prepare("SELECT * FROM zones WHERE id = ?").get(params.id);
  await db.batch([
    db.prepare("UPDATE devices SET zone_id = NULL WHERE zone_id = ?").bind(params.id),
    db.prepare("DELETE FROM zones WHERE id = ?").bind(params.id),
  ]);
  if (z) await renumberZones(z.job_id);
  return { ok: true };
});

// ---------------------------------------------------------------- room assignment (by walls, not nearest label)
on("POST", "/sheets/:id/assign-rooms", async ({ req, params, ctx }) => {
  const sheet = await db.prepare("SELECT * FROM sheets WHERE id = ?").get(params.id);
  if (!sheet) notFound();
  const { overview } = await readJson(req);
  if (!overview?.png) fail(400, "Missing sheet image");
  const scale = overview.w / sheet.width;
  const rooms = await db.prepare("SELECT * FROM rooms WHERE sheet_id = ?").all(sheet.id);
  const label = Object.fromEntries(DEVICE_TYPES.map((t) => [t.key, t.label]));
  const devices = await db.prepare("SELECT * FROM devices WHERE sheet_id = ? AND x IS NOT NULL").all(sheet.id);
  if (!devices.length) return { moved: 0 };
  return claudeJob(ctx, sheet.job_id, "assign-rooms", async () => {
    const result = await assignRooms({
      sheet, overview,
      rooms: rooms.filter((r) => r.x != null).map((r) => ({ number: r.number, name: r.name, px: r.x * scale, py: r.y * scale })),
      devices: devices.map((d) => ({ id: d.id, label: label[d.type] || d.type, px: d.x * scale, py: d.y * scale })),
    });
    const byNumber = new Map(rooms.map((r) => [String(r.number).toLowerCase(), r]));
    const writes = [];
    for (const b of result.rooms) {
      const r = byNumber.get(String(b.room_number).toLowerCase());
      if (r) writes.push(db.prepare("UPDATE rooms SET bx0 = ?, by0 = ?, bx1 = ?, by1 = ? WHERE id = ?")
        .bind(Math.min(b.x0, b.x1) / scale, Math.min(b.y0, b.y1) / scale, Math.max(b.x0, b.x1) / scale, Math.max(b.y0, b.y1) / scale, r.id));
    }
    await db.batch(writes.splice(0)); // outlines first: tape runs below are placed by them
    // Exterior devices get an "Exterior" room so they can be zoned on their own.
    let exterior = rooms.find((r) => /^ext/i.test(r.number) || /^exterior$/i.test(r.name));
    const valid = new Set(devices.map((d) => d.id));
    let moved = 0;
    for (const a of result.devices) {
      if (!valid.has(a.id)) continue;
      let roomId;
      if (/^ext/i.test(a.room_number)) {
        exterior ??= await db.prepare("INSERT INTO rooms (job_id, sheet_id, level, number, name, source) VALUES (?, ?, ?, 'EXT', 'Exterior', 'ai') RETURNING *").get(sheet.job_id, sheet.id, sheet.level);
        roomId = exterior.id;
      } else roomId = byNumber.get(String(a.room_number).toLowerCase())?.id;
      if (!roomId) continue;
      const d = devices.find((x) => x.id === a.id);
      if (d.room_id !== roomId) { writes.push(db.prepare("UPDATE devices SET room_id = ? WHERE id = ?").bind(roomId, d.id)); moved++; }
    }
    for (const t of await db.prepare("SELECT * FROM tape_runs WHERE sheet_id = ?").all(sheet.id)) {
      const p = JSON.parse(t.points || "[]")[0];
      if (p) writes.push(db.prepare("UPDATE tape_runs SET room_id = ? WHERE id = ?").bind(await nearestRoomId(sheet.id, p.x, p.y), t.id));
    }
    await db.batch(writes);
    await splitCrossRoomZones(sheet.job_id);
    await renumberZones(sheet.job_id);
    return { moved, usage: result.usage };
  });
});

// ---------------------------------------------------------------- NEC / IRC code check
on("POST", "/sheets/:id/code-check", async ({ req, params, ctx }) => {
  const sheet = await db.prepare("SELECT * FROM sheets WHERE id = ?").get(params.id);
  if (!sheet) notFound();
  const { overview } = await readJson(req);
  if (!overview?.png) fail(400, "Missing sheet image");
  const job = await getJob(sheet.job_id);
  const s = jobSettings(job);
  const scale = overview.w / sheet.width; // image px per PDF point
  const rooms = await db.prepare("SELECT * FROM rooms WHERE sheet_id = ?").all(sheet.id);
  const roomName = new Map(rooms.map((r) => [r.id, `${r.number} ${r.name}`]));
  const label = Object.fromEntries(DEVICE_TYPES.map((t) => [t.key, t.label]));
  const devices = await db.prepare("SELECT * FROM devices WHERE sheet_id = ? AND x IS NOT NULL").all(sheet.id);
  const analysis = sheet.analysis ? JSON.parse(sheet.analysis) : {};
  // The estimator's dismissals (with reasons) so the check learns from them.
  const dismissed = (await db.prepare("SELECT * FROM code_findings WHERE job_id = ? AND status = 'dismissed'").all(job.id))
    .map((f) => ({ room: roomName.get(f.room_id) || "", rule: f.rule, note: f.note }));
  return claudeJob(ctx, job.id, "code-check", async () => {
    const result = await codeCheck({
      sheet: { ...sheet, scale_text: analysis.scale_text }, overview,
      rooms: rooms.filter((r) => r.x != null).map((r) => ({ number: r.number, name: r.name, px: r.x * scale, py: r.y * scale })),
      devices: devices.map((d) => ({ label: label[d.type] || d.type, room: roomName.get(d.room_id) || "", px: d.x * scale, py: d.y * scale, note: d.note })),
      specText: specPrompt(s), nec: s.code_nec, irc: s.code_irc, dismissed,
    });
    const byNumber = new Map(rooms.map((r) => [String(r.number).toLowerCase(), r]));
    const writes = [];
    for (const r of result.rooms) {
      const rm = byNumber.get(String(r.room_number).toLowerCase());
      if (rm) writes.push(db.prepare("UPDATE rooms SET use_type = ?, length_ft = ?, width_ft = ? WHERE id = ?").bind(r.use, r.length_ft, r.width_ft, rm.id));
    }
    // Re-checking replaces open findings; accepted / dismissed ones are kept.
    writes.push(db.prepare("DELETE FROM code_findings WHERE sheet_id = ? AND status = 'open'").bind(sheet.id));
    const ins = db.prepare(`INSERT INTO code_findings (job_id, sheet_id, room_id, rule, code_ref, severity, message, device_type, x, y)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const f of result.findings) {
      const rm = byNumber.get(String(f.room_number).toLowerCase());
      const type = TYPE_KEYS.includes(f.add_device_type) ? f.add_device_type : null;
      const x = f.x > 0 ? f.x / scale : rm?.x ?? null, y = f.y > 0 ? f.y / scale : rm?.y ?? null;
      writes.push(ins.bind(job.id, sheet.id, rm?.id ?? null, f.rule, f.code_ref, f.severity, f.message, type, x, y));
    }
    await db.batch(writes);
    return { findings: result.findings.length, usage: result.usage, nec: s.code_nec, irc: s.code_irc };
  });
});

on("PATCH", "/findings/:id", async ({ req, params }) => {
  const f = await db.prepare("SELECT * FROM code_findings WHERE id = ?").get(params.id);
  if (!f) notFound();
  const b = await readJson(req);
  const status = ["open", "accepted", "dismissed"].includes(b.status) ? b.status : f.status;
  let deviceId = f.device_id;
  if (status === "accepted" && f.status !== "accepted" && f.device_type) {
    // Accepted findings go straight into the estimate: contract requires code-compliant work either way.
    deviceId = (await db.prepare(`INSERT INTO devices (job_id, sheet_id, room_id, type, x, y, source, status, note)
      VALUES (?, ?, ?, ?, ?, ?, 'code', 'confirmed', ?) RETURNING id`)
      .get(f.job_id, f.sheet_id, f.room_id, f.device_type, f.x, f.y, `Code required: ${f.code_ref}. ${f.rule}`)).id;
  }
  if (status !== "accepted" && f.device_id) {
    await db.prepare("DELETE FROM devices WHERE id = ? AND source = 'code'").run(f.device_id);
    deviceId = null;
  }
  await db.prepare("UPDATE code_findings SET status = ?, note = ?, device_id = ? WHERE id = ?").run(status, b.note ?? f.note, deviceId, f.id);
  return db.prepare("SELECT * FROM code_findings WHERE id = ?").get(f.id);
});

// ---------------------------------------------------------------- LED tape runs
const tapeRow = async (id) => { const t = await db.prepare("SELECT * FROM tape_runs WHERE id = ?").get(id); return t && { ...t, points: JSON.parse(t.points || "[]") }; };
on("POST", "/jobs/:id/tape", async ({ req, params }) => {
  const b = await readJson(req);
  const pts = (b.points || []).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)).map((p) => ({ x: p.x, y: p.y }));
  if (pts.length < 2 || !b.sheet_id) fail(400, "A tape run needs at least two points on a sheet.");
  const job = await getJob(params.id);
  if (!job) notFound();
  const s = jobSettings(job);
  const specId = b.spec_id || s.specs?.tape || null;
  const spec = getSpec(specId);
  const roomId = await nearestRoomId(b.sheet_id, pts[0].x, pts[0].y);
  let zoneId = b.zone_id ?? null;
  if (zoneId == null) {
    // Each new run gets its own zone in its room: Lucetta = dimmed DPM zone, Lumaris = Lumaris (wireless) zone.
    const control = spec?.data.rules.tape_type === "lumaris" ? "lumaris" : "dpm";
    zoneId = (await db.prepare("INSERT INTO zones (job_id, sheet_id, room_id, name, control) VALUES (?, ?, ?, ?, ?) RETURNING id")
      .get(job.id, b.sheet_id, roomId, "LED tape", control)).id;
  }
  const r = (await db.prepare("INSERT INTO tape_runs (job_id, sheet_id, room_id, zone_id, spec_id, points, note) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id")
    .get(job.id, b.sheet_id, roomId, zoneId, specId, JSON.stringify(pts), String(b.note || ""))).id;
  await renumberZones(job.id);
  return tapeRow(r);
});
on("PATCH", "/tape/:id", async ({ req, params }) => {
  const t = await tapeRow(params.id);
  if (!t) notFound();
  const b = await readJson(req);
  const pts = b.points ? b.points.map((p) => ({ x: p.x, y: p.y })) : t.points;
  if (b.zone_id) {
    const z = await db.prepare("SELECT * FROM zones WHERE id = ?").get(b.zone_id);
    if (z?.room_id && t.room_id && z.room_id !== t.room_id) fail(400, "Zones never cross rooms: pick a zone in the tape run's own room.");
  }
  await db.prepare("UPDATE tape_runs SET points = ?, spec_id = ?, zone_id = ?, note = ? WHERE id = ?")
    .run(JSON.stringify(pts), b.spec_id !== undefined ? b.spec_id : t.spec_id, b.zone_id !== undefined ? b.zone_id : t.zone_id, b.note ?? t.note, t.id);
  if (b.spec_id !== undefined && t.zone_id) {
    // Switching Lucetta <-> Lumaris changes how the run's own zone is controlled.
    const z = await db.prepare("SELECT * FROM zones WHERE id = ?").get(t.zone_id);
    const control = getSpec(b.spec_id)?.data.rules.tape_type === "lumaris" ? "lumaris" : "dpm";
    if (z && z.name === "LED tape") await db.prepare("UPDATE zones SET control = ? WHERE id = ?").run(control, z.id);
    await renumberZones(t.job_id);
  }
  return tapeRow(t.id);
});
on("DELETE", "/tape/:id", async ({ params }) => {
  const t = await tapeRow(params.id);
  if (!t) notFound();
  await db.prepare("DELETE FROM tape_runs WHERE id = ?").run(t.id);
  // Remove the run's own zone if nothing else uses it.
  if (t.zone_id && !(await db.prepare("SELECT 1 FROM devices WHERE zone_id = ? UNION SELECT 1 FROM tape_runs WHERE zone_id = ?").get(t.zone_id, t.zone_id))) {
    await db.prepare("DELETE FROM zones WHERE id = ? AND name = 'LED tape'").run(t.zone_id);
  }
  await renumberZones(t.job_id);
  return { ok: true };
});

// ---------------------------------------------------------------- equipment: electrical panels, lighting (DPM) panels, risers, backup
const EQUIP_KINDS = ["elec_panel", "dpm_panel", "riser", "backup"];
on("POST", "/jobs/:id/equipment", async ({ req, params }) => {
  const b = await readJson(req);
  if (!EQUIP_KINDS.includes(b.kind)) fail(400, "Unknown equipment kind");
  const count = (await db.prepare("SELECT count(*) n FROM equipment WHERE job_id = ? AND kind = ?").get(params.id, b.kind)).n;
  const backupName = /generator/i.test(getSpec(jobSettings(await getJob(params.id)).specs?.backup)?.name || "") ? "Generator" : "Powerwall";
  const defName = { elec_panel: `Electrical panel ${count + 1}`, dpm_panel: `Lighting panel (PD8) ${count + 1}`, riser: `Riser ${count + 1}`, backup: `${backupName} ${count + 1}` }[b.kind];
  return db.prepare(`INSERT INTO equipment (job_id, sheet_id, kind, name, x, y, serves, extra_ft, target_id, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`).get(params.id, b.sheet_id ?? null, b.kind, String(b.name || defName),
    b.x ?? null, b.y ?? null, ["elec", "dpm", "both"].includes(b.serves) ? b.serves : "both", Number(b.extra_ft) || 0, b.target_id ?? null, b.source === "ai" ? "ai" : "manual");
});
on("PATCH", "/equipment/:id", async ({ req, params }) => {
  const e = await db.prepare("SELECT * FROM equipment WHERE id = ?").get(params.id);
  if (!e) notFound();
  const b = await readJson(req);
  await db.prepare("UPDATE equipment SET name = ?, x = ?, y = ?, serves = ?, extra_ft = ?, target_id = ?, source = 'manual' WHERE id = ?")
    .run(b.name ?? e.name, b.x ?? e.x, b.y ?? e.y, ["elec", "dpm", "both"].includes(b.serves) ? b.serves : e.serves,
      b.extra_ft != null ? Number(b.extra_ft) || 0 : e.extra_ft, b.target_id !== undefined ? b.target_id : e.target_id, e.id);
  return db.prepare("SELECT * FROM equipment WHERE id = ?").get(e.id);
});
on("DELETE", "/equipment/:id", async ({ params }) => { await db.prepare("DELETE FROM equipment WHERE id = ?").run(params.id); return { ok: true }; });

on("POST", "/sheets/:id/auto-zone", async ({ params, ctx }) => {
  const sheet = await db.prepare("SELECT * FROM sheets WHERE id = ?").get(params.id);
  if (!sheet) notFound();
  const job = await getJob(sheet.job_id);
  const s = jobSettings(job);
  const js = jobSpecs(s);
  const analysis = sheet.analysis ? JSON.parse(sheet.analysis) : {};
  const ppf = pointsPerFoot(analysis.scale_text);
  const typeLabel = Object.fromEntries(DEVICE_TYPES.map((t) => [t.key, t.label]));
  const rooms = await db.prepare("SELECT * FROM rooms WHERE sheet_id = ?").all(sheet.id);
  const roomName = Object.fromEntries(rooms.map((r) => [r.id, `${r.number ? r.number + " " : ""}${r.name}`]));
  const roomByNumber = new Map(rooms.filter((r) => r.number).map((r) => [r.number.toLowerCase(), r.id]));

  // Keep zones drawn by hand; re-zone everything else on this sheet.
  const manualZoneIds = new Set((await db.prepare("SELECT id FROM zones WHERE sheet_id = ? AND source = 'manual'").all(sheet.id)).map((z) => z.id));
  const all = await db.prepare("SELECT * FROM devices WHERE sheet_id = ? AND x IS NOT NULL").all(sheet.id);
  const lights = all.filter((d) => FIXTURE_TYPES.includes(d.type) && !manualZoneIds.has(d.zone_id));
  if (!lights.length) fail(400, "No unzoned light fixtures on this sheet.");
  const fmt = (d) => ({ id: d.id, type: d.type, label: typeLabel[d.type], room: roomName[d.room_id] || "", x: d.x / ppf, y: d.y / ppf, note: d.note });

  return claudeJob(ctx, job.id, "auto-zone", async () => {
    const result = await autoZone({
      sheet, rooms, lights: lights.map(fmt), controls: all.filter((d) => CONTROL_TYPES.includes(d.type)).map(fmt),
      specText: specPrompt(s), defaultControl: js.lighting?.data.rules.default_zone_control || "dpm", ketraTypes: js.ketra_types, daliTypes: js.dali_types, mixedTypes: js.kd_mixed,
    });
    const validIds = new Set(lights.map((d) => d.id));
    const oldAi = (await db.prepare("SELECT id FROM zones WHERE sheet_id = ? AND source = 'ai'").all(sheet.id)).map((z) => z.id);
    await db.batch(oldAi.flatMap((id) => [db.prepare("UPDATE devices SET zone_id = NULL WHERE zone_id = ?").bind(id), db.prepare("DELETE FROM zones WHERE id = ?").bind(id)]));
    const insZone = db.prepare("INSERT INTO zones (job_id, sheet_id, room_id, name, control, source, note, exterior) VALUES (?, ?, ?, ?, ?, 'ai', ?, ?) RETURNING id");
    const setZone = db.prepare("UPDATE devices SET zone_id = ? WHERE id = ?");
    const seen = new Set(), writes = [];
    let made = 0;
    for (const z of result.zones) {
      const ids = z.device_ids.filter((id) => validIds.has(id) && !seen.has(id));
      if (!ids.length) continue;
      const roomId = z.exterior ? null : roomByNumber.get((z.room_number || "").toLowerCase()) ?? lights.find((d) => d.id === ids[0])?.room_id ?? null;
      const zid = (await insZone.get(sheet.job_id, sheet.id, roomId, z.name, z.control, z.reason, z.exterior ? 1 : 0)).id;
      for (const id of ids) { writes.push(setZone.bind(zid, id)); seen.add(id); }
      made++;
    }
    await db.batch(writes);
    const split = await splitCrossRoomZones(sheet.job_id); // safety net: a zone never crosses rooms
    await mergeLoneFixtureZones(sheet.job_id);            // safety net: same type in the same room stays one zone
    await mergeExteriorWallZones(sheet.job_id, ppf);      // safety net: exterior lights on one wall face stay one zone
    await renumberZones(sheet.job_id);
    return { zones: made + split, split, zoned: seen.size, unzoned: lights.length - seen.size, usage: result.usage };
  });
});

// ---------------------------------------------------------------- appliance specs, mechanical drawings and the loads they power
const LOAD_CATS = ["kitchen", "laundry", "hvac", "water_heating", "pump", "ev", "pool_spa", "other"];
function cleanLoad(b, cur = {}) {
  const volts = [120, 208, 240].includes(Number(b.volts)) ? Number(b.volts) : cur.volts ?? 120;
  const amps = b.amps != null ? Number(b.amps) || 0 : cur.amps ?? 0;
  const sized = sizeLoad({ volts, amps, mocp: b.breaker != null ? Number(b.breaker) || 0 : (b.mocp ?? 0) });
  return {
    name: String(b.name ?? cur.name ?? "Equipment"), tag: String(b.tag ?? cur.tag ?? ""),
    category: LOAD_CATS.includes(b.category) ? b.category : cur.category ?? "other",
    location: String(b.location ?? cur.location ?? ""), room_id: b.room_id !== undefined ? b.room_id : cur.room_id ?? null,
    volts, amps,
    breaker: b.breaker != null || b.mocp != null || b.amps != null || b.volts != null ? sized.breaker : cur.breaker ?? sized.breaker,
    poles: b.volts != null ? sized.poles : cur.poles ?? sized.poles,
    neutral: b.neutral != null ? (b.neutral ? 1 : 0) : cur.neutral ?? 0,
    connection: ["hardwired", "receptacle"].includes(b.connection) ? b.connection : cur.connection ?? "hardwired",
    disconnect: b.disconnect != null ? (b.disconnect ? 1 : 0) : cur.disconnect ?? 0,
    include: b.include != null ? (b.include ? 1 : 0) : cur.include ?? 1,
    note: String(b.note ?? cur.note ?? ""),
  };
}
const INS_LOAD = `INSERT INTO loads (job_id, doc_id, name, tag, category, location, room_id, volts, amps, breaker, poles, neutral, connection, disconnect, include, note, page, source)
  VALUES (:job_id, :doc_id, :name, :tag, :category, :location, :room_id, :volts, :amps, :breaker, :poles, :neutral, :connection, :disconnect, :include, :note, :page, :source) RETURNING *`;
const loadRow = (jobId, l, extra = {}) => ({ job_id: jobId, doc_id: null, page: null, source: "manual", ...l, ...extra });

on("GET", "/jobs/:id/reconcile", ({ params }) => reconcileLoads(Number(params.id)));
on("POST", "/jobs/:id/loads", async ({ req, params }) => db.prepare(INS_LOAD).get(loadRow(Number(params.id), cleanLoad(await readJson(req)))));
on("PATCH", "/loads/:id", async ({ req, params }) => {
  const cur = await db.prepare("SELECT * FROM loads WHERE id = ?").get(params.id);
  if (!cur) notFound();
  const l = cleanLoad(await readJson(req), cur);
  await db.prepare(`UPDATE loads SET name=:name, tag=:tag, category=:category, location=:location, room_id=:room_id, volts=:volts, amps=:amps, breaker=:breaker,
    poles=:poles, neutral=:neutral, connection=:connection, disconnect=:disconnect, include=:include, note=:note WHERE id=:id`).run({ ...l, id: cur.id });
  return db.prepare("SELECT * FROM loads WHERE id = ?").get(cur.id);
});
on("DELETE", "/loads/:id", async ({ params }) => { await db.prepare("DELETE FROM loads WHERE id = ?").run(params.id); return { ok: true }; });

on("POST", "/plans/:id/extract-loads", async ({ req, params, ctx }) => {
  const plan = await db.prepare("SELECT * FROM plans WHERE id = ?").get(params.id);
  if (!plan) notFound();
  const job = await getJob(plan.job_id);
  const size = await ctx.files.size(plan.stored_name);
  const small = size != null && size <= 22 * 1024 * 1024;
  const pages = ((await readJson(req)).pages || []).filter((p) => p.text?.trim());
  if (!small && !pages.length) fail(400, "This PDF is too large to send whole and has no extractable text. Upload just the schedule pages.");
  const rooms = await db.prepare("SELECT * FROM rooms WHERE job_id = ? ORDER BY number").all(job.id);
  return claudeJob(ctx, job.id, "extract-loads", async () => {
    const result = await extractLoads({
      docType: plan.doc_type, filename: plan.filename, pdfB64: small ? toBase64(await ctx.files.bytes(plan.stored_name)) : null, pages,
      specText: specPrompt(jobSettings(job)), rooms,
    });
    const byNumber = new Map(rooms.filter((r) => r.number).map((r) => [r.number.toLowerCase(), r.id]));
    const byName = (loc) => rooms.find((r) => loc && (loc.toUpperCase().includes(r.name.toUpperCase()) || r.name.toUpperCase().includes(loc.toUpperCase())))?.id ?? null;
    const ins = db.prepare(INS_LOAD);
    await db.batch([
      db.prepare("DELETE FROM loads WHERE doc_id = ? AND source = 'ai'").bind(plan.id),
      ...result.loads.map((l) => ins.bind(loadRow(job.id, cleanLoad({
        name: l.name, tag: l.tag, category: l.category, location: l.location, volts: l.volts, amps: l.amps, mocp: l.mocp,
        neutral: l.needs_neutral, connection: l.connection, disconnect: l.needs_disconnect,
        room_id: byNumber.get(String(l.room_number || "").toLowerCase()) ?? byName(l.location),
        note: [l.gas_fired ? "Gas-fired (120V for controls/ignition)" : "", l.from_spec ? "" : "Typical value: not stated in the document", l.notes].filter(Boolean).join(". "),
      }), { doc_id: plan.id, page: l.page, source: "ai" }))),
    ]);
    const duplicates = await dedupeLoads(job.id);
    return { loads: result.loads.length, duplicates, notes: result.notes, usage: result.usage, sent: small ? "pdf" : "text" };
  });
});

on("GET", "/jobs/:id/system", async ({ params }) => {
  const job = await getJob(params.id);
  if (!job) notFound();
  return sizeSystem(job.id, jobSettings(job));
});

// ---------------------------------------------------------------- estimate
on("GET", "/jobs/:id/estimate", async ({ params }) => {
  const est = await buildEstimate(params.id);
  if (!est) notFound();
  return est;
});
on("GET", "/jobs/:id/material-list.csv", async ({ params }) => {
  const est = await buildEstimate(params.id);
  if (!est) notFound();
  const name = est.job.name.replace(/[^\w -]+/g, "").trim() || "job";
  return new Response(estimateCsv(est), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name} - material list.csv"`, "Cache-Control": "no-store" } });
});

/** One-time fix-ups for older local data (run by the local server at start; the site starts clean). */
export async function repairAllJobs() {
  await prepare();
  for (const j of await db.prepare("SELECT id FROM jobs").all()) {
    await splitCrossRoomZones(j.id); // company rule: a zone never crosses rooms
    await renumberZones(j.id);       // keep zone codes current (104.01, K104.02, D104.03)
    await dedupeLoads(j.id);         // equipment already drawn as plan devices is not a dedicated circuit
  }
}


// ---------------------------------------------------------------- drawing revisions (Tony, 2026-11-09)
// Two versions of the same sheet: the newer one has changes (e.g. added lighting) and is missing details from the older one.
// Compare lines the two sheets up, lists what is only on the new sheet and what is only on the old one; merge copies the old-only
// items the user keeps onto the new sheet, removes new-only items they drop, then retires the old sheet (its takeoff is removed so
// nothing is counted twice; the drawing stays viewable, marked superseded).
const normNo = (s) => String(s || "").toUpperCase().replace(/\s+/g, "").replace(/[-_.]/g, "");
const median = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : 0; };
async function sheetItems(sheetId) {
  const [devices, rooms, equipment, tape] = await Promise.all([
    db.prepare("SELECT * FROM devices WHERE sheet_id = ? AND x IS NOT NULL").all(sheetId),
    db.prepare("SELECT * FROM rooms WHERE sheet_id = ?").all(sheetId),
    db.prepare("SELECT * FROM equipment WHERE sheet_id = ?").all(sheetId),
    db.prepare("SELECT * FROM tape_runs WHERE sheet_id = ?").all(sheetId),
  ]);
  return { devices, rooms, equipment, tape: tape.map((t) => ({ ...t, points: JSON.parse(t.points || "[]") })) };
}
async function revisionCompare(newId, oldId) {
  const [nw, old] = await Promise.all([db.prepare("SELECT * FROM sheets WHERE id = ?").get(newId), db.prepare("SELECT * FROM sheets WHERE id = ?").get(oldId)]);
  if (!nw || !old) notFound();
  if (nw.job_id !== old.job_id || nw.id === old.id) fail(400, "Pick two different sheets from the same job.");
  if (old.replaced_by) fail(400, "That older sheet was already merged into a newer one.");
  const A = await sheetItems(old.id), B = await sheetItems(nw.id);
  // 1. scale (different paper sizes) then the shift that lines the most same-type devices up
  const sx = old.width && nw.width ? nw.width / old.width : 1, sy = old.height && nw.height ? nw.height / old.height : 1;
  const diag = Math.hypot(nw.width || 3000, nw.height || 2000);
  const dxs = [], dys = [];
  for (const o of A.devices) {
    let best = null, bd = diag * 0.08;
    for (const n of B.devices) if (n.type === o.type) { const d = Math.hypot(n.x - o.x * sx, n.y - o.y * sy); if (d < bd) { bd = d; best = n; } }
    if (best) { dxs.push(best.x - o.x * sx); dys.push(best.y - o.y * sy); }
  }
  const dx = dxs.length >= 3 ? median(dxs) : 0, dy = dys.length >= 3 ? median(dys) : 0;
  const T = (x, y) => (x == null ? x : [x * sx + dx, y * sy + dy]);
  // 2. match: devices and panels by type and position, rooms by number/name, tape by its start and length
  const tol = diag * 0.012;
  const matchPos = (olds, news, key, tolerance) => {
    const pairs = [];
    for (const o of olds) { const [x, y] = T(o.x, o.y); for (const n of news) if (key(n) === key(o)) { const d = Math.hypot(n.x - x, n.y - y); if (d <= tolerance) pairs.push([d, o, n]); } }
    pairs.sort((a, b) => a[0] - b[0]);
    const usedO = new Set(), usedN = new Set();
    for (const [, o, n] of pairs) if (!usedO.has(o.id) && !usedN.has(n.id)) { usedO.add(o.id); usedN.add(n.id); }
    return { onlyOld: olds.filter((o) => !usedO.has(o.id)), onlyNew: news.filter((n) => !usedN.has(n.id)), matched: usedO.size };
  };
  const dev = matchPos(A.devices, B.devices, (d) => d.type, tol);
  const eq = matchPos(A.equipment, B.equipment, (e) => e.kind, tol * 2.5);
  const roomKey = (r) => (normNo(r.number) || "") + "|" + String(r.name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const newRooms = new Set(B.rooms.map(roomKey)), oldRooms = new Set(A.rooms.map(roomKey));
  const tapeLen = (t) => t.points.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - t.points[i - 1][0], p[1] - t.points[i - 1][1]) : 0), 0);
  const tapeOld = A.tape.filter((t) => t.points.length), tapeNew = B.tape.filter((t) => t.points.length);
  const tm = matchPos(tapeOld.map((t) => ({ ...t, x: t.points[0][0], y: t.points[0][1], k: Math.round(tapeLen(t) * sx / (tol * 2)) })),
    tapeNew.map((t) => ({ ...t, x: t.points[0][0], y: t.points[0][1], k: Math.round(tapeLen(t) / (tol * 2)) })), (t) => t.k, tol * 2);
  const label = { device: (d) => d.type, room: (r) => `${r.number || ""} ${r.name}`.trim(), equipment: (e) => e.name || e.kind, tape: () => "LED tape run" };
  const item = (kind, it, fromOld) => {
    const p = kind === "tape" ? it.points[0] : [it.x, it.y], q = fromOld && p && p[0] != null ? T(p[0], p[1]) : p;
    return { kind, id: it.id, type: kind === "device" ? it.type : kind === "equipment" ? it.kind : kind, label: label[kind](it), x: q ? q[0] : null, y: q ? q[1] : null, status: it.status || "" };
  };
  return {
    old: { id: old.id, sheet_no: old.sheet_no, title: old.title, plan_id: old.plan_id, page: old.page },
    new: { id: nw.id, sheet_no: nw.sheet_no, title: nw.title, plan_id: nw.plan_id, page: nw.page, width: nw.width, height: nw.height },
    transform: { sx, sy, dx, dy, pairs: dxs.length },
    matched: { devices: dev.matched, equipment: eq.matched, rooms: A.rooms.filter((r) => newRooms.has(roomKey(r))).length, tape: tm.matched },
    only_new: [...dev.onlyNew.map((d) => item("device", d)), ...eq.onlyNew.map((e) => item("equipment", e)),
      ...B.rooms.filter((r) => !oldRooms.has(roomKey(r))).map((r) => item("room", r)), ...tm.onlyNew.map((t) => item("tape", t))],
    only_old: [...dev.onlyOld.map((d) => item("device", d, true)), ...eq.onlyOld.map((e) => item("equipment", e, true)),
      ...A.rooms.filter((r) => !newRooms.has(roomKey(r))).map((r) => item("room", r, true)), ...tm.onlyOld.map((t) => item("tape", t, true))],
  };
}
// sheets in a job that share a sheet number across two uploads and haven't been merged: the newer upload is the revision
on("GET", "/jobs/:id/revisions", async ({ params }) => {
  const sheets = await db.prepare("SELECT id, plan_id, page, sheet_no, title, kind, analyzed_at, replaced_by FROM sheets WHERE job_id = ? ORDER BY plan_id, page").all(params.id);
  const by = new Map();
  for (const s of sheets) { const k = normNo(s.sheet_no); if (!k || s.replaced_by || s.kind === "superseded") continue; (by.get(k) || by.set(k, []).get(k)).push(s); }
  const pairs = [];
  for (const list of by.values()) { const plans = [...new Set(list.map((s) => s.plan_id))]; if (plans.length < 2) continue;
    const newest = list.filter((s) => s.plan_id === Math.max(...plans))[0];
    for (const o of list) if (o.plan_id !== newest.plan_id) pairs.push({ new: newest, old: o }); }
  return { pairs, superseded: sheets.filter((s) => s.replaced_by).map((s) => ({ id: s.id, sheet_no: s.sheet_no, replaced_by: s.replaced_by })) };
});
on("GET", "/sheets/:id/compare", async ({ params, query }) => revisionCompare(Number(params.id), Number(query.get("old"))));
on("POST", "/sheets/:id/merge-revision", async ({ req, params }) => {
  const b = await readJson(req);
  const cmp = await revisionCompare(Number(params.id), Number(b.old_id));
  const newId = cmp.new.id, oldId = cmp.old.id, job = (await db.prepare("SELECT job_id FROM sheets WHERE id = ?").get(newId)).job_id;
  const { sx, sy, dx, dy } = cmp.transform, T = (x, y) => (x == null ? null : [x * sx + dx, y * sy + dy]);
  const want = (list, kind) => new Set((list || []).filter((c) => c.kind === kind).map((c) => Number(c.id)));
  const onlyOld = (kind) => new Set(cmp.only_old.filter((i) => i.kind === kind).map((i) => i.id));
  const onlyNew = (kind) => new Set(cmp.only_new.filter((i) => i.kind === kind).map((i) => i.id));
  const A = await sheetItems(oldId);
  let carried = 0, dropped = 0;
  // rooms first, so carried devices land in the right room
  const carryRooms = want(b.carry, "room"), okR = onlyOld("room");
  for (const r of A.rooms.filter((r) => carryRooms.has(r.id) && okR.has(r.id))) {
    const p = T(r.x, r.y), b0 = r.bx0 != null ? T(r.bx0, r.by0) : null, b1 = r.bx1 != null ? T(r.bx1, r.by1) : null;
    await db.prepare(`INSERT INTO rooms (job_id, sheet_id, level, number, name, x, y, source, use_type, length_ft, width_ft, bx0, by0, bx1, by1, auto_number)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?)`).run(job, newId, r.level || "", r.number || "", r.name, p?.[0] ?? null, p?.[1] ?? null, r.use_type || "",
      r.length_ft ?? null, r.width_ft ?? null, b0?.[0] ?? null, b0?.[1] ?? null, b1?.[0] ?? null, b1?.[1] ?? null, r.auto_number || 0);
    carried++;
  }
  const carryD = want(b.carry, "device"), okD = onlyOld("device");
  for (const d of A.devices.filter((d) => carryD.has(d.id) && okD.has(d.id))) {
    const [x, y] = T(d.x, d.y);
    await db.prepare(`INSERT INTO devices (job_id, sheet_id, room_id, type, x, y, source, status, confidence, note) VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?)`)
      .run(job, newId, await nearestRoomId(newId, x, y), d.type, x, y, d.status === "pending" ? "pending" : "confirmed", d.confidence ?? null,
        [d.note, `from ${cmp.old.sheet_no || "older"} revision`].filter(Boolean).join(" · ").slice(0, 300));
    carried++;
  }
  const carryE = want(b.carry, "equipment"), okE = onlyOld("equipment");
  for (const e of A.equipment.filter((e) => carryE.has(e.id) && okE.has(e.id))) {
    const [x, y] = T(e.x, e.y);
    await db.prepare("INSERT INTO equipment (job_id, sheet_id, kind, name, x, y, serves, extra_ft, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual')")
      .run(job, newId, e.kind, e.name, x, y, e.serves || "both", e.extra_ft || 0);
    carried++;
  }
  const carryT = want(b.carry, "tape"), okT = onlyOld("tape");
  for (const t of A.tape.filter((t) => carryT.has(t.id) && okT.has(t.id))) {
    await db.prepare("INSERT INTO tape_runs (job_id, sheet_id, room_id, spec_id, points, note) VALUES (?, ?, ?, ?, ?, ?)")
      .run(job, newId, t.points.length ? await nearestRoomId(newId, ...T(t.points[0][0], t.points[0][1])) : null, t.spec_id ?? null, JSON.stringify(t.points.map((p) => T(p[0], p[1]))), t.note || "");
    carried++;
  }
  // new-only items the user dropped
  const tables = { device: "devices", equipment: "equipment", room: "rooms", tape: "tape_runs" };
  for (const [kind, table] of Object.entries(tables)) {
    const ok = onlyNew(kind);
    for (const id of want(b.drop_new, kind)) if (ok.has(id)) { await db.prepare(`DELETE FROM ${table} WHERE id = ? AND sheet_id = ?`).run(id, newId); dropped++; }
  }
  // retire the old sheet: its takeoff goes, the drawing stays (marked superseded) so it can still be looked at
  const oldEq = A.equipment.map((e) => e.id);
  await db.batch([
    ...oldEq.map((id) => db.prepare("UPDATE equipment SET target_id = NULL WHERE target_id = ?").bind(id)),
    db.prepare("DELETE FROM code_findings WHERE sheet_id = ?").bind(oldId),
    db.prepare("DELETE FROM tape_runs WHERE sheet_id = ?").bind(oldId),
    db.prepare("DELETE FROM devices WHERE sheet_id = ?").bind(oldId),
    db.prepare("DELETE FROM zones WHERE sheet_id = ?").bind(oldId),
    db.prepare("DELETE FROM equipment WHERE sheet_id = ?").bind(oldId),
    db.prepare("DELETE FROM rooms WHERE sheet_id = ?").bind(oldId),
    db.prepare("UPDATE sheets SET kind = 'superseded', replaced_by = ? WHERE id = ?").bind(newId, oldId),
  ]);
  await renumberZones(job);
  return { ok: true, carried, dropped, old_id: oldId, new_id: newId };
});


// ---------------------------------------------------------------- lighting fixture schedule (Tony, 2026-11-09)
// Kept in the job's settings (fixture_schedule): typed by hand on the Specs tab, or read by Claude from an uploaded PDF
// (doc_type "lighting"). It goes into everything Claude is told about the job (specPrompt), so plan reading and zoning use the
// tags, fixture types and Ketra / DALI-2 control from it.
const cleanFixture = (f, extra = {}) => ({
  id: String(f.id || crypto.randomUUID()).slice(0, 40), tag: String(f.tag || "").trim().slice(0, 20), description: String(f.description || "").slice(0, 200),
  manufacturer: String(f.manufacturer || "").slice(0, 80), model: String(f.model || "").slice(0, 120),
  type: FIXTURE_TYPES.includes(f.type) ? f.type : "other", control: ["", "dpm", "ketra", "dali", "lumaris", "wall"].includes(f.control) ? f.control : "",
  watts: Math.max(0, Number(f.watts) || 0), volts: Math.max(0, Number(f.volts) || 0), location: String(f.location || "").slice(0, 120), notes: String(f.notes || "").slice(0, 300),
  source: f.source === "ai" ? "ai" : "manual", doc_id: f.doc_id ? Number(f.doc_id) : null, ...extra,
});
on("PUT", "/jobs/:id/fixture-schedule", async ({ req, params }) => {
  const job = await getJob(params.id); if (!job) notFound();
  const rows = ((await readJson(req)).fixtures || []).slice(0, 300).map((f) => cleanFixture(f));
  const s = jobSettings(job); s.fixture_schedule = rows;
  await db.prepare("UPDATE jobs SET settings = ? WHERE id = ?").run(JSON.stringify(s), job.id);
  return { fixtures: rows };
});
on("POST", "/plans/:id/extract-fixtures", async ({ req, params, ctx }) => {
  const plan = await db.prepare("SELECT * FROM plans WHERE id = ?").get(params.id);
  if (!plan) notFound();
  const job = await getJob(plan.job_id);
  const size = await ctx.files.size(plan.stored_name);
  const small = size != null && size <= 22 * 1024 * 1024;
  const pages = ((await readJson(req)).pages || []).filter((p) => p.text?.trim());
  if (!small && !pages.length) fail(400, "This PDF is too large to send whole and has no extractable text. Upload just the schedule pages.");
  return claudeJob(ctx, job.id, "extract-fixtures", async () => {
    const result = await extractFixtures({ filename: plan.filename, pdfB64: small ? toBase64(await ctx.files.bytes(plan.stored_name)) : null, pages, specText: specPrompt(jobSettings(job)) });
    const fresh = await getJob(job.id), s = jobSettings(fresh);
    // a re-read replaces what Claude read from this document before; rows typed by hand (or from other documents) stay
    const keep = (s.fixture_schedule || []).filter((f) => !(f.source === "ai" && Number(f.doc_id) === plan.id));
    const tags = new Set(keep.map((f) => f.tag.toUpperCase()).filter(Boolean));
    const add = result.fixtures.filter((f) => !f.tag || !tags.has(String(f.tag).trim().toUpperCase())).map((f) => cleanFixture({ ...f, source: "ai", doc_id: plan.id }));
    s.fixture_schedule = [...keep, ...add];
    await db.prepare("UPDATE jobs SET settings = ? WHERE id = ?").run(JSON.stringify(s), job.id);
    return { fixtures: add.length, skipped: result.fixtures.length - add.length, notes: result.notes, usage: result.usage, sent: small ? "pdf" : "text" };
  });
});
