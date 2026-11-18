// Dedicated circuits for appliances and mechanical equipment: breaker, cable, disconnect, connection.
import { db } from "./db.js";

const STD_BREAKERS = [15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100, 110, 125, 150, 175, 200];

/** Breaker size and poles for a load. MOCP from the spec wins; otherwise 125% of the amps, minimum 20A. */
export function sizeLoad({ volts = 120, amps = 0, mocp = 0 }) {
  const poles = volts >= 208 ? 2 : 1;
  let breaker = mocp > 0 ? mocp : Math.max(20, amps * 1.25);
  breaker = STD_BREAKERS.find((b) => b >= breaker) || 200;
  return { breaker, poles };
}

// Above 60A, equipment is run in aluminum SER (75°C column); sizes and allowance prices per foot.
const SER_AL = [[65, "4", 1.6], [90, "2", 2.1], [100, "1", 2.5], [120, "1/0", 2.9], [135, "2/0", 3.4], [155, "3/0", 4.1], [180, "4/0", 4.8], [999, "250", 6.2]];
export const SER_ABOVE = 60;

/** Cable for a circuit: NM-B by breaker (60°C column, 12 AWG minimum per SOP) up to 60A, aluminum SER above. */
export function wireFor(breaker, poles, neutral) {
  if (breaker > SER_ABOVE) {
    const [, size, price] = SER_AL.find(([amps]) => breaker <= amps);
    return { ser: true, size, price, label: `#${size} Al SER` };
  }
  const gauge = breaker <= 20 ? 12 : breaker <= 30 ? 10 : breaker <= 40 ? 8 : 6;
  const conductors = poles === 1 ? 2 : neutral ? 3 : 2;
  return { gauge, conductors, label: `${gauge}/${conductors} NM-B` };
}

const cat = (sql, ...args) => db.prepare(sql).get(...args);

// Equipment that the electrical plans show as devices: counted there (with its assembly), not as a dedicated circuit.
// Inline / booster fans and range hoods are not drawn as plan devices, so they stay.
const ON_PLAN = [
  { type: "exhaust_fan", label: "exhaust fan", re: /\b(bath(room)?\s+fan|exhaust\s+fan|vent(ilation)?\s+fan)\b/i, not: /inline|in-line|booster|hood|range|dryer|whole[- ]house/i },
  { type: "ceiling_fan", label: "ceiling fan", re: /\bceiling\s+fan\b/i, not: /cassette/i },
  { type: "smoke_co", label: "smoke/CO detector", re: /\b(smoke|carbon monoxide|co)\s+(detector|alarm)\b/i, not: null },
];
const DUP_NOTE = "Shown on the electrical plan as a device";

/**
 * Compare equipment the mechanical/appliance documents list against devices drawn on the electrical plans
 * (exhaust fans, ceiling fans, smoke/CO). Electrical plans win; a mismatch needs review.
 */
export async function reconcileLoads(jobId) {
  const loads = await db.prepare("SELECT * FROM loads WHERE job_id = ?").all(jobId);
  const devices = await db.prepare("SELECT d.type, d.room_id, d.sheet_id FROM devices d WHERE d.job_id = ?").all(jobId);
  const elecSheets = await db.prepare("SELECT id, sheet_no, analyzed_at FROM sheets WHERE job_id = ? AND kind = 'electrical'").all(jobId);
  const analyzed = elecSheets.filter((s) => s.analyzed_at);
  const rooms = new Map((await db.prepare("SELECT id, number, name FROM rooms WHERE job_id = ?").all(jobId)).map((r) => [r.id, `${r.number} ${r.name}`.trim()]));
  const out = [];
  for (const p of ON_PLAN) {
    const docItems = loads.filter((l) => p.re.test(`${l.name} ${l.tag}`) && !(p.not && p.not.test(`${l.name} ${l.tag}`)));
    if (!docItems.length) continue;
    const planItems = devices.filter((d) => d.type === p.type);
    const roomKeys = new Set([...docItems.map((l) => l.room_id), ...planItems.map((d) => d.room_id)].filter(Boolean));
    const byRoom = [...roomKeys].map((rid) => ({ room: rooms.get(rid) || "?", documents: docItems.filter((l) => l.room_id === rid).length, plans: planItems.filter((d) => d.room_id === rid).length }))
      .filter((r) => r.documents !== r.plans).sort((a, b) => a.room.localeCompare(b.room, undefined, { numeric: true }));
    out.push({
      type: p.type, label: p.label, documents: docItems.length, plans: planItems.length,
      documents_without_room: docItems.filter((l) => !l.room_id).length,
      sheets_analyzed: analyzed.length, sheets_total: elecSheets.length, complete: elecSheets.length > 0 && analyzed.length === elecSheets.length,
      mismatch: docItems.length !== planItems.length, rooms_differing: byRoom,
      not_analyzed: elecSheets.filter((s) => !s.analyzed_at).map((s) => s.sheet_no),
    });
  }
  return out;
}

/** Untick loads that duplicate plan devices. Returns how many were excluded. */
export async function dedupeLoads(jobId) {
  const upd = db.prepare("UPDATE loads SET include = 0, note = ? WHERE id = ?");
  const writes = [];
  for (const l of await db.prepare("SELECT * FROM loads WHERE job_id = ? AND include = 1").all(jobId)) {
    const text = `${l.name} ${l.tag}`;
    const hit = ON_PLAN.find((p) => p.re.test(text) && !(p.not && p.not.test(text)));
    if (!hit || (l.note || "").startsWith(DUP_NOTE)) continue;
    writes.push(upd.bind(`${DUP_NOTE} (${hit.label}): counted there, not as a dedicated circuit. Tick to add it anyway.${l.note ? ` ${l.note}` : ""}`, l.id));
  }
  await db.batch(writes);
  return writes.length;
}

export async function findWire(gauge, conductors) {
  const q = (c) => cat("SELECT * FROM catalog WHERE replace(model, '  ', ' ') LIKE ? ORDER BY unit_cost LIMIT 1", `${gauge}/${c} NM-B%`);
  return (await q(conductors)) || (conductors === 2 ? q(3) : null); // larger NM-B often only stocked as /3
}

function findBreaker(amps, poles, family) {
  if (family === "leviton") return cat("SELECT * FROM catalog WHERE part_number = ?", `LB${poles}${String(amps).padStart(2, "0")}-T`);
  return cat(`SELECT * FROM catalog WHERE manufacturer = 'Eaton' AND model LIKE ? AND model LIKE '%Type BR%'
    AND model NOT LIKE '%Ground%' AND model NOT LIKE '%Combo%' AND model NOT LIKE '%Equipment%' AND model NOT LIKE '%GF%' AND model NOT LIKE '%AF%'
    ORDER BY unit_cost LIMIT 1`, `Breaker, ${amps}A, ${poles}P,%`);
}

const line = (row, description, qty, unit_cost, phase, labor_hours = null) => ({
  catalog_id: row?.id || null, description: row ? `${row.manufacturer} ${row.model}${/\(ft\)/.test(description) ? " (ft)" : ""}` : description,
  qty, unit_cost: row ? row.unit_cost : unit_cost, labor_hours, phase,
});

/** Assembly lines for one dedicated circuit, with `ft` of home run. */
export async function loadLines(load, ft, family) {
  const w = wireFor(load.breaker, load.poles, !!load.neutral);
  const lines = [
    line(await findBreaker(load.breaker, load.poles, family), `${load.breaker}A ${load.poles}-pole breaker`, 1, load.poles === 2 ? 15 : 6, "Finish"),
    w.ser
      ? line(null, `${w.label} home run, allowance: add SER to the catalog (ft)`, Math.ceil(ft), w.price, "Rough", 0.06)
      : line(await findWire(w.gauge, w.conductors), `${w.label} home run (ft)`, Math.ceil(ft), w.gauge <= 6 ? 3.6 : 1.2, "Rough"),
  ];
  const part = (pn) => cat("SELECT * FROM catalog WHERE part_number = ?", pn);
  if (load.disconnect) {
    lines.push(load.breaker <= 60
      ? line(await part("0208915"), "AC disconnect, 60A pull-out, non-fused", 1, 20, "Rough", 0.75)
      : line(await part("0535074"), "Safety switch 100A, non-fused", 1, 326, "Rough", 1));
  }
  if (load.connection === "receptacle") {
    if (load.poles === 2 && load.breaker >= 40) lines.push(line(await part("0217484"), "50A 14-50R receptacle", 1, 5, "Finish"));
    else if (load.poles === 2) lines.push(line(await part("0217483"), "30A 14-30R receptacle", 1, 5, "Finish"));
    else lines.push(line(null, "Dedicated 20A receptacle, box and plate", 1, 8, "Finish", 0.35));
  } else {
    lines.push(line(null, "Hardwire connection / flex whip allowance", 1, 15, "Finish", 0.75));
  }
  return { lines, wire: w.label };
}
