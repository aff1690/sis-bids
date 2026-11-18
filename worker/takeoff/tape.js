// LED tape runs: length from the drawn right-angle polyline, feed segments (max run), drivers / power
// interfaces at the load limit, Class 2 feeds sized for voltage drop.
//   Lucetta: drivers on a dimmed DPM zone (one driver group per zone).
//   Lumaris: LU-PH3 power interfaces per run; wireless + constant power like Ketra (RF devices, PD8 circuits).
import { db } from "./db.js";
import { getSpec, DEFAULT_RULES } from "./specs.js";

const OHMS_PER_KFT = [[18, 6.385], [16, 4.016], [14, 2.525], [12, 1.588], [10, 0.999]]; // copper, per conductor

export function runLengthFt(points, ppf) {
  let pts = 0;
  for (let i = 1; i < points.length; i++) pts += Math.abs(points[i].x - points[i - 1].x) + Math.abs(points[i].y - points[i - 1].y);
  return pts / ppf;
}

/** Smallest Class 2 gauge that keeps voltage drop within the limit (24V tape). */
function feedGauge(amps, feetOneWay, vdropPct, volts = 24) {
  const allowed = volts * vdropPct / 100;
  for (const [g, ohm] of OHMS_PER_KFT) if (2 * feetOneWay * amps * ohm / 1000 <= allowed) return g;
  return 10;
}

/**
 * @param defaultSpecId job's default tape spec
 * @param ppfOf sheet id -> PDF points per foot
 */
export async function computeTape(jobId, defaultSpecId, ppfOf) {
  const runs = await db.prepare("SELECT * FROM tape_runs WHERE job_id = ?").all(jobId);
  const specs = new Map();
  const specOf = (id) => {
    const key = id || defaultSpecId;
    if (!key) return null;
    if (!specs.has(key)) specs.set(key, getSpec(key));
    return specs.get(key);
  };
  const details = [];
  const qtyBySpec = new Map();
  const pseudo = []; // stand-in devices so zones, PD8 circuits and RF counts include the tape
  const addQty = (specId, k, n) => {
    if (!qtyBySpec.has(specId)) qtyBySpec.set(specId, { tape_ft: 0, tape_segment: 0, tape_run: 0, tape_driver: 0, channel_piece: 0, class2_ft: 0 });
    qtyBySpec.get(specId)[k] += n;
  };

  // Lucetta drivers are shared per zone, so total watts by zone first.
  const zoneWatts = new Map();
  const rows = [];
  for (const r of runs) {
    const spec = specOf(r.spec_id);
    const rules = { ...DEFAULT_RULES, ...(spec?.data.rules || {}) };
    const points = JSON.parse(r.points || "[]");
    const ft = runLengthFt(points, ppfOf(r.sheet_id));
    let segments = Math.max(1, Math.ceil(ft / rules.max_run_ft - 1e-9));
    while ((ft / segments) * rules.watts_per_ft > rules.class2_max_watts) segments++; // each Class 2 output <= 100W
    const watts = ft * rules.watts_per_ft;
    const segAmps = (ft / segments) * rules.watts_per_ft / 24;
    const gauge = feedGauge(segAmps, rules.class2_feed_ft, rules.vdrop_pct);
    rows.push({ r, spec, rules, points, ft, segments, watts, gauge });
    if (rules.tape_type === "lucetta") {
      const key = r.zone_id ? `z${r.zone_id}` : `r${r.id}`;
      zoneWatts.set(key, (zoneWatts.get(key) || 0) + watts);
    }
  }
  const zoneDrivers = new Map();
  for (const { r, rules } of rows) {
    if (rules.tape_type !== "lucetta") continue;
    const key = r.zone_id ? `z${r.zone_id}` : `r${r.id}`;
    if (!zoneDrivers.has(key)) zoneDrivers.set(key, Math.max(1, Math.ceil(zoneWatts.get(key) / (rules.driver_watts * rules.driver_load_pct / 100))));
  }
  const counted = new Set();

  for (const { r, spec, rules, points, ft, segments, watts, gauge } of rows) {
    const specId = spec?.id ?? null;
    const lumaris = rules.tape_type === "lumaris";
    let drivers;
    if (lumaris) drivers = Math.max(1, Math.ceil(watts / (rules.driver_watts * rules.driver_load_pct / 100)));
    else {
      const key = r.zone_id ? `z${r.zone_id}` : `r${r.id}`;
      drivers = counted.has(key) ? 0 : zoneDrivers.get(key); // shared drivers counted once per zone
      counted.add(key);
    }
    const class2 = segments * rules.class2_feed_ft;
    const pieces = Math.ceil(ft / rules.channel_piece_ft - 1e-9);
    if (specId) {
      addQty(specId, "tape_ft", ft); addQty(specId, "tape_segment", segments); addQty(specId, "tape_run", 1);
      addQty(specId, "tape_driver", drivers); addQty(specId, "channel_piece", pieces); addQty(specId, "class2_ft", class2);
    }
    const p0 = points[0] || { x: null, y: null };
    if (lumaris) {
      const piWeight = (rules.driver_watts * rules.driver_load_pct / 100) / (DEFAULT_RULES.fixture_watts || 20);
      for (let k = 0; k < drivers; k++) pseudo.push({ id: `pi-${r.id}-${k}`, type: "tape_pi", zone_id: r.zone_id, room_id: r.room_id, sheet_id: r.sheet_id, x: p0.x, y: p0.y, weight: piWeight });
    } else {
      pseudo.push({ id: `tape-${r.id}`, type: "tape", zone_id: r.zone_id, room_id: r.room_id, sheet_id: r.sheet_id, x: p0.x, y: p0.y });
    }
    details.push({
      id: r.id, sheet_id: r.sheet_id, zone_id: r.zone_id, room_id: r.room_id, spec_id: specId, spec: spec?.name || "(no tape spec)",
      type: rules.tape_type, points, ft: Math.round(ft * 10) / 10, segments, seg_ft: Math.round((ft / segments) * 10) / 10,
      watts: Math.round(watts), drivers, driver_watts: rules.driver_watts, class2_ft: Math.round(class2), feed_gauge: gauge,
    });
  }
  return { runs: details, qtyBySpec, pseudo };
}
