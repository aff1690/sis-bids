// Storage, shared by the local server (Node's built-in SQLite) and the SIS Tools site (Cloudflare D1).
// Nothing here imports Node modules: the driver is plugged in with setDb() (see node/sqlite.js and d1.js).
// Every statement is async: db.prepare(sql).get / all / run, db.exec(sql), db.batch([db.prepare(sql).bind(...)]).
import { DEFAULT_ASSEMBLIES } from "./deviceTypes.js";

/** The active driver. ES module bindings are live, so modules that import `db` see the driver set here. */
export let db = null;
export function setDb(driver) { db = driver; }

/** Tables, newest columns included (older local databases get the columns from MIGRATIONS). */
export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT DEFAULT '',
  job_type TEXT DEFAULT 'new',            -- new | remodel
  settings TEXT DEFAULT '{}',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`,
  `CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  page_count INTEGER DEFAULT 0,
  doc_type TEXT DEFAULT 'plans',          -- plans | appliance | mechanical
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`,
  `CREATE TABLE IF NOT EXISTS sheets (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  page INTEGER NOT NULL,
  sheet_no TEXT DEFAULT '',
  title TEXT DEFAULT '',
  kind TEXT DEFAULT 'other',              -- electrical | floor | other
  level TEXT DEFAULT '',
  width REAL, height REAL,
  analysis TEXT,                          -- JSON from the last AI run (legend, notes, cost)
  analyzed_at TEXT,
  replaced_by INTEGER,                    -- set when a newer revision was merged in (kind becomes 'superseded')
  UNIQUE(plan_id, page)
)`,
  `CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  sheet_id INTEGER REFERENCES sheets(id) ON DELETE CASCADE,
  level TEXT DEFAULT '',
  number TEXT DEFAULT '',
  name TEXT NOT NULL,
  x REAL, y REAL,
  source TEXT DEFAULT 'manual',
  use_type TEXT DEFAULT '', length_ft REAL, width_ft REAL,
  bx0 REAL, by0 REAL, bx1 REAL, by1 REAL, -- room outline (PDF points)
  auto_number INTEGER DEFAULT 0           -- number assigned by the tool
)`,
  `CREATE TABLE IF NOT EXISTS zones (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  sheet_id INTEGER REFERENCES sheets(id) ON DELETE CASCADE,
  room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  control TEXT DEFAULT 'dpm',             -- dpm | dali | ketra | lumaris | wall
  source TEXT DEFAULT 'manual',
  note TEXT DEFAULT '',
  code TEXT DEFAULT '',
  exterior INTEGER DEFAULT 0
)`,
  `CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  sheet_id INTEGER REFERENCES sheets(id) ON DELETE CASCADE,
  room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  x REAL, y REAL,
  source TEXT DEFAULT 'manual',           -- ai | manual | code
  status TEXT DEFAULT 'confirmed',        -- pending | confirmed
  confidence REAL,
  note TEXT DEFAULT '',
  zone_id INTEGER REFERENCES zones(id) ON DELETE SET NULL
)`,
  `CREATE TABLE IF NOT EXISTS catalog (
  id INTEGER PRIMARY KEY,
  manufacturer TEXT DEFAULT '',
  model TEXT NOT NULL,
  part_number TEXT DEFAULT '',
  category TEXT DEFAULT '',
  subcategory TEXT DEFAULT '',
  phase TEXT DEFAULT '',
  description TEXT DEFAULT '',
  url TEXT DEFAULT '',
  image_url TEXT DEFAULT '',
  vendor TEXT DEFAULT '',
  unit_cost REAL DEFAULT 0,
  unit_price REAL DEFAULT 0,
  labor_hours REAL DEFAULT 0,
  source TEXT DEFAULT 'manual',           -- dtools | web | manual
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(manufacturer, model)
)`,
  `CREATE TABLE IF NOT EXISTS assemblies (
  device_type TEXT PRIMARY KEY,
  items TEXT NOT NULL DEFAULT '[]'
)`,
  `CREATE TABLE IF NOT EXISTS specs (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,                 -- devices | lighting | panels | tape | backup
  data TEXT NOT NULL DEFAULT '{}',
  seed_key TEXT UNIQUE,                   -- set on starter specs so they are only seeded once
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
)`,
  `CREATE TABLE IF NOT EXISTS equipment (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  sheet_id INTEGER REFERENCES sheets(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                     -- elec_panel | dpm_panel | riser | backup
  name TEXT NOT NULL,
  x REAL, y REAL,
  serves TEXT DEFAULT 'both',             -- riser only: elec | dpm | both
  extra_ft REAL DEFAULT 0,                -- riser only: feet from the riser to the panel on another floor
  source TEXT DEFAULT 'manual',
  target_id INTEGER                       -- riser -> the panel it leads to
)`,
  `CREATE TABLE IF NOT EXISTS loads (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  doc_id INTEGER REFERENCES plans(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  tag TEXT DEFAULT '',
  category TEXT DEFAULT 'other',
  location TEXT DEFAULT '',
  room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
  volts INTEGER DEFAULT 120,
  amps REAL DEFAULT 0,
  breaker INTEGER DEFAULT 20,
  poles INTEGER DEFAULT 1,
  neutral INTEGER DEFAULT 0,
  connection TEXT DEFAULT 'hardwired',
  disconnect INTEGER DEFAULT 0,
  include INTEGER DEFAULT 1,
  note TEXT DEFAULT '',
  page INTEGER,
  source TEXT DEFAULT 'manual'
)`,
  `CREATE TABLE IF NOT EXISTS tape_runs (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  sheet_id INTEGER REFERENCES sheets(id) ON DELETE CASCADE,
  room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
  zone_id INTEGER REFERENCES zones(id) ON DELETE SET NULL,
  spec_id INTEGER REFERENCES specs(id) ON DELETE SET NULL,
  points TEXT NOT NULL DEFAULT '[]',
  note TEXT DEFAULT ''
)`,
  `CREATE TABLE IF NOT EXISTS code_findings (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  sheet_id INTEGER REFERENCES sheets(id) ON DELETE CASCADE,
  room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
  rule TEXT NOT NULL,
  code_ref TEXT DEFAULT '',
  severity TEXT DEFAULT 'required',       -- required | review
  message TEXT DEFAULT '',
  device_type TEXT,
  x REAL, y REAL,
  status TEXT DEFAULT 'open',             -- open | accepted | dismissed
  note TEXT DEFAULT '',
  device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`,
  // Every Claude call: who, which job, what it cost. Feeds the daily cap and the spend shown on the Projects page.
  `CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY,
  day TEXT NOT NULL,
  email TEXT DEFAULT '',
  job_id INTEGER,
  kind TEXT DEFAULT '',
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`,
  "CREATE INDEX IF NOT EXISTS idx_devices_job ON devices(job_id)",
  "CREATE INDEX IF NOT EXISTS idx_rooms_job ON rooms(job_id)",
  "CREATE INDEX IF NOT EXISTS idx_usage_day ON usage(day)",
];

/** Columns added after a table first shipped: [table, column, definition]. */
const MIGRATIONS = [
  ["devices", "zone_id", "INTEGER REFERENCES zones(id) ON DELETE SET NULL"],
  ["zones", "code", "TEXT DEFAULT ''"],
  ["plans", "doc_type", "TEXT DEFAULT 'plans'"],
  ["rooms", "use_type", "TEXT DEFAULT ''"], ["rooms", "length_ft", "REAL"], ["rooms", "width_ft", "REAL"],
  ["rooms", "bx0", "REAL"], ["rooms", "by0", "REAL"], ["rooms", "bx1", "REAL"], ["rooms", "by1", "REAL"],
  ["rooms", "auto_number", "INTEGER DEFAULT 0"],
  ["equipment", "target_id", "INTEGER"],
  ["sheets", "replaced_by", "INTEGER"],
  ["zones", "exterior", "INTEGER DEFAULT 0"],      // exterior wall-face zone (2026-11-09): may span rooms, never split by room          // revision merge (2026-11-09): the newer sheet that replaced this one
];

/** Create tables, add missing columns, seed the default assemblies. Safe to run on every start. */
export async function ensureSchema() {
  await db.batch(SCHEMA.map((sql) => db.prepare(sql).bind()));
  const have = new Map();
  for (const [t, col, def] of MIGRATIONS) {
    if (!have.has(t)) have.set(t, new Set((await db.prepare(`PRAGMA table_info(${db.table(t)})`).all()).map((c) => c.name)));
    if (!have.get(t).has(col)) { await db.exec(`ALTER TABLE ${t} ADD COLUMN ${col} ${def}`); have.get(t).add(col); }
  }
  const ins = db.prepare("INSERT OR IGNORE INTO assemblies (device_type, items) VALUES (?, ?)");
  await db.batch(Object.entries(DEFAULT_ASSEMBLIES).map(([type, items]) => ins.bind(type, JSON.stringify(items))));
}

/** Find a catalog row from a line's `match`: {part_number} or {manufacturer, model (prefix)}. Returns {id} or undefined. */
export async function findCatalog(manufacturerOrMatch, model) {
  const m = typeof manufacturerOrMatch === "object" ? manufacturerOrMatch : { manufacturer: manufacturerOrMatch, model };
  if (m.part_number) {
    return db.prepare("SELECT id FROM catalog WHERE part_number = ? OR model = ? ORDER BY (part_number = ?) DESC LIMIT 1")
      .get(m.part_number, m.part_number, m.part_number);
  }
  return db.prepare("SELECT id FROM catalog WHERE manufacturer = ? AND model LIKE ? || '%' ORDER BY length(model) LIMIT 1")
    .get(m.manufacturer, m.model);
}

/** Link assembly lines that name a catalog item by manufacturer+model to the real catalog row. */
export async function linkAssembliesToCatalog() {
  const rows = await db.prepare("SELECT device_type, items FROM assemblies").all();
  const upd = db.prepare("UPDATE assemblies SET items = ? WHERE device_type = ?");
  const writes = [];
  let linked = 0;
  for (const r of rows) {
    const items = JSON.parse(r.items);
    let changed = false;
    for (const it of items) {
      if (!it.catalog_id && it.match) {
        const hit = await findCatalog(it.match.manufacturer, it.match.model);
        if (hit) { it.catalog_id = hit.id; changed = true; linked++; }
      }
    }
    if (changed) writes.push(upd.bind(JSON.stringify(items), r.device_type));
  }
  await db.batch(writes);
  return linked;
}

export const DEFAULT_SETTINGS = {
  labor_rate: 95,          // $/hr billed
  markup_pct: 0,           // old: extra markup on top of catalog sell price (only used when margin_pct is empty)
  margin_pct: null,        // material margin on cost (Tony, 2026-11-09): sell = cost / (1 - margin). Empty = catalog sell prices
  tax_pct: 0,              // material sales tax (set per job)
  waste_pct: 10,           // wire waste / slack
  remodel_labor_factor: 1.35,
  homerun_route_factor: 1.2, // plan distance (along X then Y) x this factor for routing around obstacles
  homerun_vertical_ft: 10,   // added to every home run for drops/rises in walls
  default_homerun_ft: 50,    // used when a sheet has no panel or riser placed
  code_nec: "2026",          // code editions for the code check (default: most current)
  code_irc: "2024",
};

export function jobSettings(job) {
  return { ...DEFAULT_SETTINGS, ...JSON.parse(job?.settings || "{}") };
}

export const getJob = (id) => db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
