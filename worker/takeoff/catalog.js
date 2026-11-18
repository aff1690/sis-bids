// Catalog: D-Tools SI CSV import, search, and manual/web upserts.
import { db, linkAssembliesToCatalog } from "./db.js";

/** RFC-4180 CSV parser (quoted fields, embedded commas/newlines, "" escapes). */
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift() || [];
  return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

const num = (v) => { const n = parseFloat(String(v ?? "").replace(/[$,]/g, "")); return Number.isFinite(n) ? n : 0; };
const clean = (v) => String(v ?? "").replace(/^'/, "").trim();

const UPSERT = `
INSERT INTO catalog (manufacturer, model, part_number, category, subcategory, phase, description, url, image_url, vendor, unit_cost, unit_price, labor_hours, source, updated_at)
VALUES (:manufacturer, :model, :part_number, :category, :subcategory, :phase, :description, :url, :image_url, :vendor, :unit_cost, :unit_price, :labor_hours, :source, CURRENT_TIMESTAMP)
ON CONFLICT(manufacturer, model) DO UPDATE SET
  part_number=excluded.part_number, category=excluded.category, subcategory=excluded.subcategory, phase=excluded.phase,
  description=excluded.description, url=excluded.url,
  image_url=CASE WHEN excluded.image_url <> '' THEN excluded.image_url ELSE catalog.image_url END,
  vendor=excluded.vendor, unit_cost=excluded.unit_cost, unit_price=excluded.unit_price,
  labor_hours=excluded.labor_hours, source=excluded.source, updated_at=CURRENT_TIMESTAMP
RETURNING id`;

function catalogRow(item) {
  const row = {
    manufacturer: clean(item.manufacturer), model: clean(item.model), part_number: clean(item.part_number),
    category: clean(item.category), subcategory: clean(item.subcategory), phase: clean(item.phase),
    description: clean(item.description), url: clean(item.url), image_url: clean(item.image_url),
    vendor: clean(item.vendor), unit_cost: num(item.unit_cost), unit_price: num(item.unit_price),
    labor_hours: num(item.labor_hours), source: item.source || "manual",
  };
  if (!row.model) throw new Error("Model is required");
  return row;
}

export async function upsertItem(item) {
  return (await db.prepare(UPSERT).get(catalogRow(item))).id;
}

/** Import a D-Tools SI "Full Catalog" export. Returns counts. Rows are written in batches (one round trip per 100). */
export async function importDTools(csvText) {
  const rows = parseCsv(csvText);
  if (!rows.length || !("Model" in rows[0]) || !("Unit Cost" in rows[0])) {
    throw new Error("This doesn't look like a D-Tools catalog export (missing Model / Unit Cost columns).");
  }
  let imported = 0, skipped = 0;
  const stmt = db.prepare(UPSERT), writes = [];
  for (const r of rows) {
    if (!clean(r.Model) || r.Discontinued === "True") { skipped++; continue; }
    writes.push(stmt.bind(catalogRow({
      manufacturer: r.Manufacturer, model: r.Model, part_number: r["Part Number"], category: r.Category,
      subcategory: r.Subcategory, phase: r.Phase, description: r["Short Description"] || r["Long Description"],
      url: r.URL, vendor: r["Preferred Vendor"], unit_cost: r["Unit Cost"], unit_price: r["Unit Price"],
      labor_hours: r["Unit Labor Hours"], source: "dtools",
    })));
    imported++;
  }
  await db.batch(writes);
  const linked = await linkAssembliesToCatalog();
  return { imported, skipped, linked };
}

export function searchCatalog(q, limit = 50) {
  const terms = String(q || "").trim().split(/\s+/).filter(Boolean).slice(0, 6);
  if (!terms.length) return db.prepare("SELECT * FROM catalog ORDER BY updated_at DESC LIMIT ?").all(limit);
  const where = terms.map(() => "(manufacturer || ' ' || model || ' ' || part_number || ' ' || description || ' ' || subcategory) LIKE ?").join(" AND ");
  return db.prepare(`SELECT * FROM catalog WHERE ${where} ORDER BY category, manufacturer, model LIMIT ?`)
    .all(...terms.map((t) => `%${t}%`), limit);
}
