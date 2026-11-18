// Expands counted devices through their assemblies into a priced material list and labor.
import { db, jobSettings } from "./db.js";
import { DEVICE_TYPES } from "./deviceTypes.js";
import { jobSpecs, sizeSystem, getSpec } from "./specs.js";
import { loadLines, reconcileLoads } from "./loads.js";

const isWire = (it) => /\(ft\)/i.test(it.description || "");

/** Conductor size (AWG) of a wire line, e.g. "14/2 NM-B" -> 14. */
export function wireGauge(text) {
  const m = String(text || "").match(/\b(\d{1,2})\s*\/\s*[2-4](?:-\d)?\b/) || String(text || "").match(/\b(\d{1,2})\s*AWG\b/i);
  const g = m ? Number(m[1]) : null;
  return g >= 6 && g <= 18 ? g : null; // ignore things like 1/2" connectors
}

/** Wire SOP: power items min 12 AWG (20A); lighting items 14 AWG (15A). */
export function sopIssues(assemblies) {
  const issues = [];
  for (const t of DEVICE_TYPES) {
    for (const it of assemblies[t.key] || []) {
      const text = `${it.description || ""} ${it.catalog?.model || ""}`;
      if (!isWire(it) && !/NM-B|Romex/i.test(text)) continue;
      const g = wireGauge(text);
      if (g == null) continue;
      if (t.circuit === "power" && g > 12) issues.push(`${t.label}: uses ${g} AWG wire. SOP is minimum 12/2 for power (20A).`);
      if (t.circuit === "lighting" && g < 14 && g !== null) issues.push(`${t.label}: uses ${g} AWG wire. SOP for lighting is 14 AWG (15A).`);
    }
  }
  return issues;
}

/** Catalog rows by id, fetched in a few queries (not one per line). */
async function catalogByIds(ids) {
  const want = [...new Set(ids.filter(Boolean).map(Number))];
  const out = new Map();
  for (let i = 0; i < want.length; i += 90) {
    const part = want.slice(i, i + 90);
    for (const r of await db.prepare(`SELECT * FROM catalog WHERE id IN (${part.map(() => "?").join(",")})`).all(...part)) out.set(r.id, r);
  }
  return out;
}

/** Attach catalog rows and resolved price/labor/phase to assembly or spec lines. */
export async function resolveLines(items) {
  const rows = await catalogByIds((items || []).map((it) => it.catalog_id));
  return (items || []).map((it) => {
    const c = it.catalog_id ? rows.get(Number(it.catalog_id)) : null;
    return {
      ...it,
      catalog: c || null,
      resolved: {
        description: c ? `${c.manufacturer} ${c.model}` : it.description,
        unit_cost: c ? c.unit_cost : Number(it.unit_cost || 0),
        unit_price: c ? (c.unit_price || c.unit_cost) : Number(it.unit_cost || 0),
        labor_hours: it.labor_hours != null && it.labor_hours !== "" ? Number(it.labor_hours) : (c ? c.labor_hours : 0),
        phase: it.phase || (c && /finish/i.test(c.phase) ? "Finish" : "Rough"),
      },
    };
  });
}

export async function loadAssemblies() {
  const rows = await db.prepare("SELECT * FROM assemblies").all();
  const resolved = await resolveLines(rows.flatMap((r) => JSON.parse(r.items))); // one catalog lookup for all of them
  const out = {};
  let i = 0;
  for (const r of rows) { const n = JSON.parse(r.items).length; out[r.device_type] = resolved.slice(i, i + n); i += n; }
  return out;
}

/** Base assemblies with the job's devices spec, then lighting-control spec, layered on top. */
export async function jobAssemblies(settings) {
  const asm = await loadAssemblies();
  const source = Object.fromEntries(Object.keys(asm).map((k) => [k, "Base assembly"]));
  const js = jobSpecs(settings);
  for (const spec of [js.devices, js.lighting]) {
    if (!spec) continue;
    for (const [type, lines] of Object.entries(spec.data.overrides || {})) {
      if (lines?.length) { asm[type] = await resolveLines(lines); source[type] = spec.name; }
    }
  }
  return { asm, source, specs: js };
}

export async function buildEstimate(jobId) {
  const job = await db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
  if (!job) return null;
  const s = jobSettings(job);
  const laborFactor = job.job_type === "remodel" ? Number(s.remodel_labor_factor) : 1;
  // SIS prices on margin, not markup (Tony, 2026-11-09): with a margin set, sell = cost / (1 - margin%). Without one, the catalog sell
  // price is used (plus the old markup %, for jobs priced before the change).
  const mg = s.margin_pct === null || s.margin_pct === undefined || s.margin_pct === "" ? null : Math.min(95, Math.max(0, Number(s.margin_pct)));
  const markup = 1 + Number(s.markup_pct || 0) / 100;
  const sellOf = (l) => (mg !== null && isFinite(mg) ? l.unit_cost / (1 - mg / 100) : l.unit_price * markup);
  const waste = 1 + Number(s.waste_pct) / 100;
  const { asm, source, specs } = await jobAssemblies(s);
  const system = await sizeSystem(job.id, s);

  const devices = await db.prepare(`
    SELECT d.id, d.type, d.status, r.name AS room_name, r.number AS room_number, COALESCE(r.level, sh.level, '') AS level
    FROM devices d LEFT JOIN rooms r ON r.id = d.room_id LEFT JOIN sheets sh ON sh.id = d.sheet_id
    WHERE d.job_id = ?`).all(jobId);

  const lines = new Map();
  const counts = {};
  const byRoom = new Map();
  let pending = 0;

  for (const d of devices) {
    counts[d.type] = (counts[d.type] || 0) + 1;
    if (d.status === "pending") pending++;
    const roomKey = `${d.level}||${d.room_number || ""}||${d.room_name || "Unassigned"}`;
    if (!byRoom.has(roomKey)) byRoom.set(roomKey, { level: d.level || "(no level)", room: d.room_name || "Unassigned", number: d.room_number || "", counts: {}, labor_hours: 0, material_price: 0 });
    const room = byRoom.get(roomKey);
    room.counts[d.type] = (room.counts[d.type] || 0) + 1;

    // Device-to-device cable comes from each device's assembly allotment; only home runs are measured.
    for (const it of asm[d.type] || []) addLine(it, Number(it.qty || 0), room);
  }

  // System equipment from the job's specs, sized by zones / RF devices.
  const systemLines = [];
  for (const spec of [specs.devices, specs.lighting, specs.panels]) {
    for (const it of await resolveLines(spec?.data.system_items)) {
      const mult = system.qty[it.basis] || 0;
      if (!mult) continue;
      addLine(it, Number(it.qty || 0) * mult, null);
      systemLines.push({ description: it.resolved.description, basis: it.basis, qty: Number(it.qty || 0) * mult });
    }
  }

  // LED tape: each tape spec priced from its own runs (tape ft, segments, drivers / power interfaces, channel, Class 2).
  for (const [specId, q] of Object.entries(system.tape?.qty_by_spec || {})) {
    const spec = getSpec(Number(specId));
    for (const it of await resolveLines(spec?.data.system_items)) {
      const mult = q[it.basis] || 0;
      if (!mult) continue;
      addLine(it, Number(it.qty || 0) * mult, null);
      systemLines.push({ description: it.resolved.description, basis: it.basis, qty: Number(it.qty || 0) * mult });
    }
  }
  // Backup power (Powerwall / generator): units and expansions set on the job.
  if (specs.backup) {
    const q = { job: 1, backup_unit: system.backup?.units || specs.backup_units, backup_expansion: specs.backup_expansions };
    // Feeders measured from each placed unit: breaker + cable (NM-B, or SER above 60A) by the panel's breaker family.
    const fam = specs.panels?.data.rules.breaker_family || "eaton_br";
    for (const f of system.backup?.feeders || []) {
      const { lines: ls } = await loadLines({ breaker: system.backup.breaker, poles: 2, neutral: system.backup.neutral, connection: "hardwired", disconnect: system.backup.disconnect }, f.ft, fam);
      for (const it of await resolveLines(ls)) addLine(it, Number(it.qty || 0), null);
    }
    for (const it of await resolveLines(specs.backup.data.system_items)) {
      const mult = q[it.basis] || 0;
      if (!mult) continue;
      addLine(it, Number(it.qty || 0) * mult, null);
      systemLines.push({ description: it.resolved.description, basis: it.basis, qty: Number(it.qty || 0) * mult });
    }
  }

  // Dedicated circuits for appliances / mechanical equipment.
  const loadRows = await db.prepare("SELECT * FROM loads WHERE job_id = ? AND include = 1").all(job.id);
  const family = specs.panels?.data.rules.breaker_family || "eaton_br";
  const loadSummary = [];
  for (const lc of system.load_circuits || []) {
    const l = loadRows.find((x) => x.id === lc.load_id);
    if (!l) continue;
    const { lines: ls, wire } = await loadLines(l, lc.ft, family);
    for (const it of await resolveLines(ls)) addLine(it, Number(it.qty || 0), null);
    loadSummary.push({ id: l.id, name: l.name, tag: l.tag, breaker: l.breaker, poles: l.poles, wire, ft: Math.round(lc.ft), circuit: lc.label });
  }

  function addLine(it, baseQty, room) {
    const r = it.resolved;
    const qty = baseQty * (isWire(it) ? waste : 1);
    const key = it.catalog_id ? `c${it.catalog_id}` : `g${r.description}`;
    if (!lines.has(key)) {
      lines.set(key, {
        description: r.description, manufacturer: it.catalog?.manufacturer || "", model: it.catalog?.model || "",
        part_number: it.catalog?.part_number || "", vendor: it.catalog?.vendor || "", phase: r.phase,
        unit: isWire(it) ? "ft" : "ea", qty: 0, unit_cost: r.unit_cost, unit_price: r.unit_price, labor_hours: 0,
        linked: !!it.catalog_id,
      });
    }
    const line = lines.get(key);
    line.qty += qty;
    const hrs = qty * r.labor_hours * laborFactor;
    line.labor_hours += hrs;
    if (room) { room.labor_hours += hrs; room.material_price += qty * sellOf(r); }
  }

  const out = [...lines.values()].map((l) => {
    const qty = l.unit === "ft" ? Math.ceil(l.qty) : Math.round(l.qty * 100) / 100;
    const unitSell = sellOf(l);
    return { ...l, qty, unit_price: unitSell, ext_cost: qty * l.unit_cost, ext_price: qty * unitSell };
  }).sort((a, b) => a.phase.localeCompare(b.phase) || b.ext_price - a.ext_price);

  const sum = (f) => out.reduce((a, l) => a + f(l), 0);
  const material_cost = sum((l) => l.ext_cost);
  const material_price = sum((l) => l.ext_price);
  const tax = material_price * Number(s.tax_pct) / 100;
  const labor_hours = sum((l) => l.labor_hours);
  const labor_price = labor_hours * Number(s.labor_rate);
  const phases = {};
  for (const l of out) {
    phases[l.phase] ??= { material_price: 0, labor_hours: 0 };
    phases[l.phase].material_price += l.ext_price;
    phases[l.phase].labor_hours += l.labor_hours;
  }

  return {
    job, settings: s, labor_factor: laborFactor,
    specs: Object.fromEntries(["devices", "lighting", "panels", "tape", "backup"].map((k) => [k, specs[k] ? { id: specs[k].id, name: specs[k].name } : null])),
    assembly_source: Object.fromEntries(Object.keys(counts).map((k) => [k, source[k]])),
    system: {
      ...system, lines: systemLines, drawing: undefined,
      warnings: [...system.warnings, ...(await reconcileLoads(job.id)).filter((r) => r.mismatch && r.complete)
        .map((r) => `Electrical plans show ${r.plans} ${r.label}s but the equipment documents list ${r.documents}. Review on the Equipment tab.`)],
    },
    loads: loadSummary,
    sop_warnings: sopIssues(Object.fromEntries(Object.entries(asm).filter(([k]) => counts[k]))),
    device_counts: DEVICE_TYPES.filter((t) => counts[t.key]).map((t) => ({ type: t.key, label: t.label, count: counts[t.key] })),
    device_total: devices.length, pending,
    lines: out, phases,
    rooms: [...byRoom.values()].sort((a, b) => a.level.localeCompare(b.level) || a.number.localeCompare(b.number, undefined, { numeric: true })),
    totals: {
      material_cost, material_price, tax, labor_hours, labor_price,
      total: material_price + tax + labor_price,
      margin: material_price + labor_price - material_cost,
      material_margin_pct: material_price > 0 ? Math.round((1 - material_cost / material_price) * 1000) / 10 : 0,
    },
  };
}

const esc = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export function estimateCsv(est) {
  const head = ["Phase", "Manufacturer", "Model", "Part Number", "Description", "Vendor", "Qty", "Unit", "Unit Cost", "Unit Price", "Ext Cost", "Ext Price", "Labor Hours"];
  const rows = est.lines.map((l) => [l.phase, l.manufacturer, l.model, l.part_number, l.description, l.vendor, l.qty, l.unit,
    l.unit_cost.toFixed(2), l.unit_price.toFixed(2), l.ext_cost.toFixed(2), l.ext_price.toFixed(2), l.labor_hours.toFixed(2)]);
  return [head, ...rows].map((r) => r.map(esc).join(",")).join("\r\n");
}
