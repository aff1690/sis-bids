// Plans workspace: sheet list, PDF viewer with takeoff markers, Claude analysis, device inspector.
import { revisionBanner, compareWithSelect } from "./revisions.js";
import { api, h, toast, loadPdf, pageText, describePage, canvasToB64, money } from "./lib.js";

const ui = {
  sheetId: null, zoom: null, selected: null, placeType: null,
  hidden: new Set(), showRooms: true, elecOnly: true, busy: null,
};
const pageCache = { key: null, canvas: null }; // last rendered page bitmap, reused across re-renders
ui.zoneMode = false;   // colour markers by zone instead of type
ui.activeZone = null;  // clicking a light adds/removes it from this zone

const ZONE_COLORS = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#42d4f4", "#f032e6", "#9a6324", "#469990", "#800000", "#808000", "#000075", "#bfef45", "#dcbeff", "#aaffc3", "#ffd8b1"];
const ZONE_CONTROL = { dpm: "DPM", dali: "DALI-2", ketra: "Ketra/RF", lumaris: "Lumaris", wall: "Wall" };
ui.showZoneCodes = true;
ui.placeEquip = null;   // elec_panel | dpm_panel | riser being placed
ui.selectedEquip = null;
// Drawing layers by system, so each can be reviewed without the clutter of the others.
// Layers by system. Receptacles share the power-circuit layer; smoke/CO are life safety (not lighting);
// fixtures are split by kind; anything else is "Other devices".
// Each system layer holds its devices AND their zoning / circuit wiring; home runs are separate layers per type.
const LAYERS = {
  power: { group: "Devices & wiring", label: "Power: receptacles + circuits", def: true, color: "#2563eb" },
  recessed: { group: "Devices & wiring", label: "Recessed cans + zoning", def: true, color: "#ca8a04" },
  decorative: { group: "Devices & wiring", label: "Decorative lights + zoning", def: true, color: "#f59e0b" },
  led: { group: "Devices & wiring", label: "LED tape & under-cabinet + zoning", def: true, color: "#0d9488" },
  fans: { group: "Devices & wiring", label: "Fans + zoning", def: true, color: "#059669" },
  life_safety: { group: "Devices & wiring", label: "Life safety: smoke/CO + circuit", def: true, color: "#dc2626" },
  other_devices: { group: "Devices & wiring", label: "Other devices (switches, keypads, data…)", def: true },
  hr_power: { group: "Home runs", label: "Power HR", def: true, color: "#2563eb" },
  hr_recessed: { group: "Home runs", label: "Recessed can HR", def: true, color: "#ca8a04" },
  hr_decorative: { group: "Home runs", label: "Decorative HR", def: true, color: "#f59e0b" },
  hr_led: { group: "Home runs", label: "LED HR", def: true, color: "#0d9488" },
  hr_fans: { group: "Home runs", label: "Fans HR", def: true, color: "#059669" },
  hr_life_safety: { group: "Home runs", label: "Life safety HR", def: true, color: "#dc2626" },
  hr_pd8: { group: "Home runs", label: "PD8 feeder HR", def: true, color: "#111827" },
  hr_equipment: { group: "Home runs", label: "Equipment HR", def: true, color: "#be123c" },
  hr_backup: { group: "Home runs", label: "Backup power HR", def: true, color: "#15803d" },
  code: { group: "Notes", label: "Code findings (NEC / IRC)", def: true },
  zone_codes: { group: "Notes", label: "Zone codes", def: true },
  rooms: { group: "Notes", label: "Room names", def: true },
  panels: { group: "Notes", label: "Panels, risers & backup units", def: true },
};
const FIXTURE_CATS = ["recessed", "decorative", "led", "fans"];
/** Layer for a zone or lighting circuit: the most common kind of fixture in it. */
function groupCategory(types, hasTape) {
  if (hasTape && !types.length) return "led";
  const n = {};
  for (const t of types) { const c = TYPE_LAYER[t]; if (FIXTURE_CATS.includes(c)) n[c] = (n[c] || 0) + 1; }
  const best = Object.entries(n).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : hasTape ? "led" : "decorative";
}
const TYPE_LAYER = {
  receptacle: "power", receptacle_gfci: "power", receptacle_afci: "power", receptacle_usb: "power", receptacle_floor: "power", receptacle_240: "power", receptacle_ceiling: "power",
  recessed: "recessed", recessed_directional: "recessed", recessed_wet: "recessed",
  pendant: "decorative", sconce: "decorative", ceiling_light: "decorative", track_light: "decorative", lit_mirror: "decorative", fluorescent: "decorative",
  under_cabinet: "led", ceiling_fan: "fans", exhaust_fan: "fans", smoke_co: "life_safety",
};
const CIRCUIT_COLOR = { power: "#2563eb", gfci: "#0891b2", c240: "#9333ea", lighting: "#d97706", safety: "#dc2626", pd8: "#7c3aed", feeder: "#111827", dedicated: "#be123c", backup: "#15803d" };
ui.layers = (() => {
  const d = Object.fromEntries(Object.entries(LAYERS).map(([k, v]) => [k, v.def]));
  try { return { ...d, ...JSON.parse(localStorage.getItem("takeoff.layers.v4") || "{}") }; } catch { return d; }
})();
const saveLayers = () => { try { localStorage.setItem("takeoff.layers.v4", JSON.stringify(ui.layers)); } catch { /* storage blocked */ } };
ui.layersOpen = false;

// ---------- undo ----------
// Each entry knows how to reverse one change (delete, add, move, edit). Ctrl+Z or the Undo button.
const undoStack = [];
export function pushUndo(label, fn) { undoStack.push({ label, fn }); if (undoStack.length > 100) undoStack.shift(); }
async function undoLast(ctx) {
  const u = undoStack.pop();
  if (!u) return toast("Nothing to undo.");
  try { await u.fn(); toast(`Undid: ${u.label}`); } catch (e) { toast(`Couldn't undo ${u.label}: ${e.message}`, true); }
  await ctx.reload();
}
/** Wrap the job's device patch once so every edit (move, type, zone, room, confirm) can be undone. */
function trackDevicePatches(ctx) {
  if (ctx._undoTracked) return;
  ctx._undoTracked = true;
  const orig = ctx.patchDevice.bind(ctx);
  ctx.patchDevice = async (id, body) => {
    const d = ctx.data.devices.find((x) => x.id === id);
    if (d) {
      const prev = Object.fromEntries(Object.keys(body).map((k) => [k, d[k] ?? null]));
      const what = body.x != null ? "move" : body.zone_id !== undefined ? "zone change" : body.status ? "confirm" : "edit";
      pushUndo(`${what} of ${ctx.types.find((t) => t.key === d.type)?.label || "device"}`, () => orig(id, prev));
    }
    return orig(id, body);
  };
}
const devicePayload = (d) => ({ item_id: d.item_id ?? null, type: d.type, sheet_id: d.sheet_id, x: d.x, y: d.y, room_id: d.room_id, zone_id: d.zone_id, status: d.status, source: d.source, confidence: d.confidence, note: d.note });
// ---- SIS Bids catalog on the plans (Tony, 2026-11-19): pick a product or package from the bid catalog and click (or drag it)
// onto the drawing. The marker counts as that exact item in the bid; its device type still drives circuits, zoning and layers.
const CAT = { q: "", kind: "", items: [], cats: [], open: new Set(), byCat: {}, cache: new Map(), typeFor: {}, loaded: false };
const KIND_LABEL = { product: "Product", labor: "Labor", service: "Service", package: "Package" };
const itemName = (it) => it ? [it.manufacturer, it.model].filter(Boolean).join(" ") : "";
async function bidApi(path, opts = {}) { // the bid site's own API (not the takeoff's /api/takeoff/…)
  const r = await fetch(path, { ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) } });
  const b = await r.json().catch(() => null); if (!r.ok) throw new Error(b?.error || `Something went wrong (${r.status}).`); return b;
}
// grouped by category (Tony, 2026-11-19): with no search the categories show closed and load when opened; a search shows matches grouped
async function catSearch() {
  const r = await bidApi(`/api/catalog?q=${encodeURIComponent(CAT.q)}&kind=${CAT.kind}&limit=${CAT.q.trim() ? 150 : 1}`);
  CAT.cats = r.cats || []; CAT.byCat = {}; CAT.items = CAT.q.trim() ? r.items : [];
  for (const it of CAT.items) { CAT.cache.set(it.id, it); (CAT.byCat[it.category || ""] ||= []).push(it); }
  CAT.loaded = true;
  await Promise.all([...CAT.open].filter((c) => !CAT.byCat[c] && CAT.cats.some((x) => x.category === c)).map(loadCat));
}
async function loadCat(c) {
  const r = await bidApi(`/api/catalog?kind=${CAT.kind}&cat=${encodeURIComponent(c)}&limit=300`);
  for (const it of r.items) CAT.cache.set(it.id, it);
  CAT.byCat[c] = r.items;
}
async function itemInfo(id) { if (!CAT.cache.has(id)) { try { CAT.cache.set(id, (await bidApi(`/api/catalog/${id}`)).item); } catch { CAT.cache.set(id, null); } } return CAT.cache.get(id); }
let revMap = null; // catalog item id -> the device type Settings links it to
async function typeFor(it, types) {
  if (CAT.typeFor[it.id]) return CAT.typeFor[it.id];
  if (!revMap) { revMap = {}; try { for (const t of (await bidApi("/api/takeoff-types")).types) if (t.item) revMap[t.item.id] ??= t.key; } catch { /* no access */ } }
  if (revMap[it.id]) return revMap[it.id];
  const txt = `${it.category} ${it.subcategory} ${it.system} ${it.short_desc} ${it.model}`.toLowerCase(), has = (k) => types.some((t) => t.key === k);
  const guess = [[/shower|wet/, "recessed_wet"], [/adjust|gimbal|direction/, "recessed_directional"], [/recess|downlight|can light|\bcan\b/, "recessed"], [/pendant|chandelier/, "pendant"],
    [/sconce/, "sconce"], [/ceiling fan/, "ceiling_fan"], [/exhaust|bath fan/, "exhaust_fan"], [/tape|strip|linear|under.?cabinet/, "under_cabinet"], [/track/, "track_light"],
    [/keypad/, "keypad"], [/dimmer/, "switch_dimmer"], [/3.?way/, "switch_3way"], [/switch/, "switch"], [/gfci|gfi/, "receptacle_gfci"], [/usb/, "receptacle_usb"],
    [/receptacle|outlet/, "receptacle"], [/smoke|co detector|carbon/, "smoke_co"], [/occupancy|vacancy|motion/, "motion_sensor"]].find(([re, k]) => re.test(txt) && has(k));
  return guess ? guess[1] : "other";
}
async function placeItem(ctx, sheet, pi, x, y) {
  try {
    const d = await api(`/api/jobs/${ctx.data.job.id}/devices`, { json: { type: pi.type, item_id: pi.id, sheet_id: sheet.id, x, y } });
    ctx.data.devices.push(d);
    pushUndo(`add ${pi.label}`, () => api(`/api/devices/${d.id}`, { method: "DELETE" }));
    ctx.rerender();
  } catch (err) { toast(err.message, true); }
}
function buildCatalogPanel(sheet, devices, types, ctx) {
  const list = h("div.catlist");
  const pick = async (it) => {
    if (ui.placeItem?.id === it.id) ui.placeItem = null;
    else { ui.placeItem = { id: it.id, label: itemName(it), kind: it.kind, type: await typeFor(it, types) }; ui.placeType = null; ui.placeEquip = null; ui.selected = null; }
    ctx.rerender();
  };
  const row = (it) => h("div.catrow" + (ui.placeItem?.id === it.id ? ".active" : ""), {
    draggable: "true", title: "Click it, then click the plan to place it. Or drag it onto the plan.",
    ondragstart: (e) => { e.dataTransfer.setData("application/x-sis-item", String(it.id)); e.dataTransfer.effectAllowed = "copy"; },
    onclick: () => pick(it),
  }, h("span.kpill." + it.kind, KIND_LABEL[it.kind] || it.kind), h("span.grow", h("b", itemName(it)), it.part_number ? h("span.muted", { style: { fontSize: ".75rem" } }, `  #${it.part_number}`) : null, it.short_desc ? h("div.muted", { style: { fontSize: ".75rem" } }, it.short_desc.slice(0, 80)) : null));
  const searching = () => !!CAT.q.trim();
  const draw = () => {
    if (!CAT.loaded) return list.replaceChildren(h("p.muted", "Loading…"));
    const cats = searching() ? CAT.cats.filter((c) => CAT.byCat[c.category]) : CAT.cats;
    if (!cats.length) return list.replaceChildren(h("p.muted", searching() ? "Nothing matches." : "The catalog is empty."));
    list.replaceChildren(...cats.flatMap((c) => {
      const open = searching() || CAT.open.has(c.category), items = CAT.byCat[c.category];
      return [h("div.cathead" + (open ? ".open" : ""), { onclick: async () => {
          if (searching()) return;
          if (CAT.open.has(c.category)) CAT.open.delete(c.category);
          else { CAT.open.add(c.category); if (!CAT.byCat[c.category]) { try { await loadCat(c.category); } catch (e) { toast(e.message, true); } } }
          draw();
        } }, h("span.caret", open ? "▾" : "▸"), h("span.grow", c.category || "No category"), h("span.muted", searching() ? `${items.length}` : `${c.n}`)),
        ...(open ? (items ? items.map(row) : [h("p.muted", "Loading…")]) : [])];
    }));
  };
  if (!CAT.loaded) catSearch().then(draw).catch((e) => list.replaceChildren(h("p.muted", e.message)));
  const q = h("input", { type: "search", placeholder: "Search products and packages…", value: CAT.q, style: { width: "100%" } });
  let t; q.addEventListener("input", () => { clearTimeout(t); t = setTimeout(async () => { CAT.q = q.value; try { await catSearch(); draw(); } catch (e) { toast(e.message, true); } }, 250); });
  const tab = (k, label) => h("button.small" + (CAT.kind === k ? ".active" : ""), { onclick: async () => { CAT.kind = k; await catSearch(); ctx.rerender(); } }, label);
  // what's placed from the catalog on this sheet
  const byItem = {}; for (const d of devices) if (d.item_id) byItem[d.item_id] = (byItem[d.item_id] || 0) + 1;
  const missing = Object.keys(byItem).map(Number).filter((id) => !CAT.cache.has(id));
  if (missing.length) Promise.all(missing.map(itemInfo)).then(() => ctx.rerender());
  draw();
  return h("div.section",
    h("h3", "Catalog & packages"),
    h("div.row", { style: { gap: "4px", marginBottom: "6px" } }, tab("", "All"), tab("product", "Products"), tab("package", "Packages")),
    q,
    ui.placeItem ? h("div.placing-item",
      h("div", "Placing ", h("b", ui.placeItem.label), ". Click the plan; Esc to stop."),
      h("label.muted", { style: { fontSize: ".75rem" } }, "Counts as (for circuits, zoning and layers)"),
      h("select", { style: { width: "100%" }, onchange: (e) => { ui.placeItem.type = CAT.typeFor[ui.placeItem.id] = e.target.value; } },
        types.map((x) => h("option", { value: x.key, selected: x.key === ui.placeItem.type }, x.label)))) : null,
    list,
    Object.keys(byItem).length ? [h("h4", { style: { margin: "10px 0 4px", fontSize: ".8rem" } }, "From the catalog on this sheet"),
      Object.entries(byItem).map(([id, n]) => h("div.typecount", h("span", itemName(CAT.cache.get(Number(id))) || `Item ${id}`), h("strong", n)))] : null);
}
// the selected marker's catalog item: search to set it, or clear it so the device type's default from Settings is used
function itemPicker(sel, ctx) {
  const cur = sel.item_id ? CAT.cache.get(sel.item_id) : null;
  if (sel.item_id && !CAT.cache.has(sel.item_id)) itemInfo(sel.item_id).then(() => ctx.rerender());
  const q = h("input", { type: "search", placeholder: cur ? "Change…" : "Search the catalog…", style: { width: "100%" } }), drop = h("div.catlist", { hidden: true });
  let t; q.addEventListener("input", () => { clearTimeout(t); t = setTimeout(async () => {
    if (!q.value.trim()) { drop.hidden = true; return; }
    const r = await bidApi(`/api/catalog?q=${encodeURIComponent(q.value)}&limit=12`).catch(() => ({ items: [] }));
    for (const it of r.items) CAT.cache.set(it.id, it);
    drop.replaceChildren(...(r.items.length ? r.items.map((it) => h("div.catrow", { onclick: () => ctx.patchDevice(sel.id, { item_id: it.id, status: "confirmed" }) },
      h("span.kpill." + it.kind, KIND_LABEL[it.kind] || it.kind), h("b.grow", itemName(it)))) : [h("p.muted", "Nothing matches.")]));
    drop.hidden = false; }, 250); });
  return [h("label.muted", { style: { fontSize: ".8rem" } }, "Catalog item in the bid"),
    h("div.row", { style: { gap: "6px", margin: "2px 0 4px" } }, cur ? h("span.grow", h("span.kpill." + cur.kind, KIND_LABEL[cur.kind]), " ", itemName(cur)) : h("span.grow.muted", "The default for this device type (Settings)"),
      sel.item_id ? h("button.small", { onclick: () => ctx.patchDevice(sel.id, { item_id: null }) }, "Clear") : null),
    q, drop];
}

async function deleteDevice(ctx, d) {
  await api(`/api/devices/${d.id}`, { method: "DELETE" });
  ctx.data.devices = ctx.data.devices.filter((x) => x.id !== d.id);
  pushUndo(`delete ${ctx.types.find((t) => t.key === d.type)?.label || "device"}`, () => api(`/api/jobs/${ctx.data.job.id}/devices`, { json: devicePayload(d) }));
}
async function deleteEquip(ctx, eq) {
  await api(`/api/equipment/${eq.id}`, { method: "DELETE" });
  ctx.data.equipment = ctx.data.equipment.filter((x) => x.id !== eq.id);
  pushUndo(`delete ${eq.name}`, () => api(`/api/jobs/${ctx.data.job.id}/equipment`, { json: { kind: eq.kind, sheet_id: eq.sheet_id, name: eq.name, x: eq.x, y: eq.y, serves: eq.serves, extra_ft: eq.extra_ft, target_id: eq.target_id, source: eq.source } }));
}
async function deleteTape(ctx, t) {
  await api(`/api/tape/${t.id}`, { method: "DELETE" });
  pushUndo("delete LED tape run", () => api(`/api/jobs/${ctx.data.job.id}/tape`, { json: { sheet_id: t.sheet_id, points: t.points, spec_id: t.spec_id, zone_id: ctx.data.zones.some((z) => z.id === t.zone_id) ? t.zone_id : null, note: t.note } }));
}
// Clicking anywhere outside the Layers popup saves the choices and closes it.
document.addEventListener("pointerdown", (e) => {
  // Same for the Tools menu and the sheet picker.
  if (ui.toolsOpen && !e.target.closest?.(".tools-menu, .tools-btn")) {
    ui.toolsOpen = false;
    document.querySelectorAll(".tools-menu").forEach((p) => (p.hidden = true));
    document.querySelectorAll(".tools-btn").forEach((b) => b.classList.remove("primary"));
  }
  if (ui.sheetsOpen && !e.target.closest?.(".sheet-panel, .sheets-btn")) {
    ui.sheetsOpen = false;
    document.querySelectorAll(".sheet-panel").forEach((p) => (p.hidden = true));
    document.querySelectorAll(".sheets-btn").forEach((b) => b.classList.remove("primary"));
  }
  if (!ui.layersOpen || e.target.closest?.(".layer-panel, .layers-btn")) return;
  ui.layersOpen = false;
  saveLayers();
  document.querySelectorAll(".layer-panel").forEach((p) => (p.hidden = true));
  document.querySelectorAll(".layers-btn").forEach((b) => b.classList.remove("primary"));
}, true);

/** Order points into a short chain starting nearest `from` (greedy nearest neighbour). */
function chain(points, from) {
  const left = points.slice(), out = [];
  let cur = from || left[0];
  while (left.length) {
    let bi = 0, bd = Infinity;
    left.forEach((p, i) => { const d = Math.abs(p.x - cur.x) + Math.abs(p.y - cur.y); if (d < bd) { bd = d; bi = i; } });
    cur = left.splice(bi, 1)[0];
    out.push(cur);
  }
  return out;
}
ui.drawTape = null;   // {points: [...]} while drawing an LED tape run
ui.selectedTape = null;
const TAPE_COLOR = { lucetta: "#0d9488", lumaris: "#c026d3" };
/** Snap the next point so the run stays at right angles to the previous point. */
function snapOrtho(prev, p) {
  if (!prev) return p;
  return Math.abs(p.x - prev.x) >= Math.abs(p.y - prev.y) ? { x: p.x, y: prev.y } : { x: prev.x, y: p.y };
}
const SVGNS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };

const EQUIP_LABEL = { elec_panel: "Electrical panel", dpm_panel: "Lighting panel (PD8)", riser: "Riser / chase to another floor", backup: "Backup unit (Powerwall / generator)" };
const EQUIP_CODE = { elec_panel: "EP", dpm_panel: "LP", riser: "↕", backup: "BU" };
const EQUIP_COLOR = { elec_panel: "#111827", dpm_panel: "#7c2d12", riser: "#475569", backup: "#15803d" };
/** Inspector section: NEC / IRC check and its findings (accepting one adds the device to the estimate). */
function buildCodeCheck(sheet, data, ctx) {
  const s = data.job.settings;
  const all = (data.findings || []).filter((f) => f.sheet_id === sheet.id);
  const open = all.filter((f) => f.status === "open");
  const done = all.filter((f) => f.status !== "open");
  const rooms = new Map(data.rooms.map((r) => [r.id, `${r.number} ${r.name}`]));
  const typeLabel = Object.fromEntries(ctx.types.map((t) => [t.key, t.label]));
  const setStatus = async (f, status, note) => { await api(`/api/findings/${f.id}`, { method: "PATCH", json: { status, note } }); await ctx.reload(); };
  const run = async () => {
    try {
      const r = await codeCheckSheet(sheet, (m) => { ui.busy = m; ctx.rerender(); });
      toast(`${r.findings} code finding${r.findings === 1 ? "" : "s"} against NEC ${r.nec} / IRC ${r.irc} (${money(r.usage.cost_usd)}).`);
    } catch (e) { toast(e.message, true); }
    ui.busy = null;
    await ctx.reload();
  };
  const row = (f) => h("div", {
    style: { borderLeft: `4px solid ${f.severity === "review" ? "#f59e0b" : "#dc2626"}`, padding: "5px 7px", marginBottom: "5px", borderRadius: "4px",
      background: f.id === ui.selectedFinding ? "var(--danger-soft)" : "var(--surface-2)", cursor: "pointer" },
    onclick: () => { ui.selectedFinding = f.id; if (f.x != null) { if (ui.zoom < 1) ui.zoom = 1.5; ui.scrollTo = f; } ctx.rerender(); },
  },
  h("div", h("strong", f.rule), " ", h("span.muted", { style: { fontSize: ".75rem" } }, f.code_ref)),
  h("div.muted", { style: { fontSize: ".78rem" } }, `${rooms.get(f.room_id) || ""} — ${f.message}`),
  f.status === "open" ? h("div.row", { style: { gap: "4px", marginTop: "4px" } },
    f.device_type ? h("button.small.primary", { onclick: (e) => { e.stopPropagation(); setStatus(f, "accepted"); } }, `Add ${typeLabel[f.device_type] || f.device_type}`)
      : h("button.small", { onclick: (e) => { e.stopPropagation(); setStatus(f, "accepted"); } }, "Mark reviewed"),
    h("button.small", { onclick: (e) => { e.stopPropagation(); const note = prompt("Why is this not needed? (kept with the job)"); if (note) setStatus(f, "dismissed", note); } }, "Dismiss"))
    : h("div.muted", { style: { fontSize: ".75rem" } }, f.status === "accepted" ? (f.device_type ? "✓ Added to the estimate" : "✓ Reviewed") : `Dismissed: ${f.note}`,
      " ", h("a", { onclick: (e) => { e.stopPropagation(); setStatus(f, "open", ""); } }, "undo")));

  return h("div.section",
    h("h3", `Code check (NEC ${s.code_nec} / IRC ${s.code_irc})`),
    h("button" + (all.length ? "" : ".primary"), { disabled: !!ui.busy || !ctx.meta.has_api_key, onclick: run }, all.length ? "Re-check sheet" : "Check sheet against code"),
    h("p.muted", { style: { fontSize: ".75rem", margin: "4px 0" } }, "Claude looks for code-required devices that aren't drawn (hallway and wall-spacing receptacles, bath basins, switched lighting, smoke/CO…). Adding one puts it in the estimate."),
    open.length ? h("div", { style: { marginTop: "6px" } }, open.map(row)) : all.length ? h("p.muted", "No open findings.") : null,
    done.length ? h("details", h("summary", `Resolved (${done.length})`), done.map(row)) : null);
}

async function finishTape(ctx, sheet) {
  const pts = ui.drawTape?.points || [];
  ui.drawTape = null;
  if (pts.length < 2) { ctx.rerender(); return; }
  try {
    const t = await api(`/api/jobs/${ctx.data.job.id}/tape`, { json: { sheet_id: sheet.id, points: pts, spec_id: ui.tapeSpec || null } });
    ui.selectedTape = t.id;
    pushUndo("add LED tape run", () => api(`/api/tape/${t.id}`, { method: "DELETE" }));
    toast("LED tape run added with its own zone. Change the spec or zone in the panel on the right.");
  } catch (e) { toast(e.message, true); }
  await ctx.reload();
}

/** Inspector section: draw LED tape, list runs, edit the selected run. */
function buildTape(sheet, data, ctx) {
  const tapeSpecs = (ctx.specList || []).filter((s) => s.category === "tape");
  ui.tapeSpec ??= data.job.settings.specs?.tape || tapeSpecs[0]?.id || null;
  const runs = (data.tape_runs || []).filter((r) => r.sheet_id === sheet.id);
  const calc = new Map((ctx.system?.tape?.runs || []).map((r) => [r.id, r]));
  const zones = (data.zones || []).filter((z) => z.sheet_id === sheet.id);
  const sel = runs.find((r) => r.id === ui.selectedTape);
  const c = sel && calc.get(sel.id);
  const patch = async (body) => { await api(`/api/tape/${sel.id}`, { method: "PATCH", json: body }); await ctx.reload(); };

  return h("div.section",
    h("h3", `LED tape (${runs.length})`),
    !tapeSpecs.length ? h("p.muted", "Add an LED tape spec in the Spec library first.") : [
      h("div.row", { style: { gap: "4px" } },
        h("select", { style: { flex: 1, fontSize: ".8rem" }, title: "Spec for new runs", onchange: (e) => (ui.tapeSpec = Number(e.target.value)) },
          tapeSpecs.map((s) => h("option", { value: s.id, selected: s.id === ui.tapeSpec }, s.name))),
        h("button.small" + (ui.drawTape ? ".primary" : ""), {
          onclick: () => { ui.drawTape = ui.drawTape ? null : { points: [] }; ui.placeType = null; ui.placeEquip = null; ui.activeZone = null; ctx.rerender(); },
        }, ui.drawTape ? "Cancel" : "Draw run")),
      h("p.muted", { style: { fontSize: ".75rem", margin: "4px 0" } }, "Click along the cove / cabinet / stair; the run snaps to right angles. Feeds every 16.4 ft, drivers at 80% load."),
    ],
    runs.map((r) => {
      const rc = calc.get(r.id);
      return h("div.typecount" + (r.id === ui.selectedTape ? ".active" : ""), { style: r.id === ui.selectedTape ? { background: "var(--accent-soft)" } : {}, onclick: () => { ui.selectedTape = r.id; ctx.rerender(); } },
        h("span.row", { style: { gap: "6px" } }, h("span.swatch", { style: { background: TAPE_COLOR[rc?.type] || TAPE_COLOR.lucetta } }),
          `${zones.find((z) => z.id === r.zone_id)?.code || "?"} ${rc ? `${rc.ft}'` : ""}`),
        h("span.muted", rc ? `${rc.segments} feed · ${rc.drivers}×${rc.driver_watts}W` : ""));
    }),
    sel && c ? h("div.card", { style: { padding: "10px", marginTop: "8px" } },
      h("strong", `${c.spec}`),
      h("div.muted", { style: { fontSize: ".8rem", margin: "4px 0" } },
        `${c.ft} ft · ${c.watts} W · ${c.segments} feed${c.segments > 1 ? "s" : ""} of ${c.seg_ft} ft · ${c.drivers ? `${c.drivers} × ${c.driver_watts}W ${c.type === "lumaris" ? "power interface" : "driver"}` : "driver shared with its zone"} · Class 2 ${c.class2_ft} ft, ${c.feed_gauge} AWG for ≤3% drop`),
      h("label.muted", { style: { fontSize: ".8rem" } }, "Tape spec"),
      h("select", { style: { width: "100%" }, onchange: (e) => patch({ spec_id: Number(e.target.value) }) },
        tapeSpecs.map((s) => h("option", { value: s.id, selected: s.id === sel.spec_id }, s.name))),
      h("label.muted", { style: { fontSize: ".8rem" } }, "Zone"),
      h("select", { style: { width: "100%" }, onchange: (e) => patch({ zone_id: e.target.value ? Number(e.target.value) : null }) },
        h("option", { value: "" }, "— Not zoned —"),
        zones.map((z) => h("option", { value: z.id, selected: z.id === sel.zone_id }, `${z.code} ${z.name}`))),
      h("div.row", { style: { marginTop: "8px" } },
        h("button.danger", { onclick: async () => { await deleteTape(ctx, sel); ui.selectedTape = null; await ctx.reload(); } }, "Delete run (Del)"))) : null,
  );
}

async function patchEquip(data, id, body) {
  try {
    const eq = await api(`/api/equipment/${id}`, { method: "PATCH", json: body });
    data.equipment = data.equipment.map((x) => (x.id === id ? eq : x));
  } catch (e) { toast(e.message, true); }
}
function zoneColors(zones) {
  const m = new Map();
  zones.slice().sort((a, b) => a.id - b.id).forEach((z, i) => m.set(z.id, ZONE_COLORS[i % ZONE_COLORS.length]));
  return m;
}

export function renderPlans(root, ctx) {
  trackDevicePatches(ctx);
  const { data, types } = ctx;
  const typeMap = Object.fromEntries(types.map((t) => [t.key, t]));
  const sheets = data.sheets;
  if (ui.sheetId && !sheets.some((s) => s.id === ui.sheetId)) ui.sheetId = null;
  if (!ui.sheetId && sheets.length) {
    ui.sheetId = (sheets.find((s) => s.kind === "electrical") || sheets[0]).id;
    ui.zoom = null;
  }
  const sheet = sheets.find((s) => s.id === ui.sheetId);
  const sheetDevices = sheet ? data.devices.filter((d) => d.sheet_id === sheet.id) : [];
  const roomsById = Object.fromEntries(data.rooms.map((r) => [r.id, r]));

  // ---------- sheets: popup grouped by discipline (keeps the screen for the drawing) ----------
  const fileInput = h("input", { type: "file", accept: "application/pdf", hidden: true, onchange: (e) => uploadPlan(e.target.files[0]) });
  const picker = buildSheetPicker(sheets, sheet, data, ctx, () => fileInput.click());

  // ---------- centre: viewer ----------
  const center = h("section.center");
  if (!sheet) {
    center.append(h("div.empty", h("h2", "Upload a plan set to start"),
      h("p", "Upload the PDF plans. The tool finds the electrical sheets; Claude then builds the room tree and places device markers for you to check."),
      h("button.primary", { onclick: () => fileInput.click(), disabled: !!ui.busy }, "Upload plan PDF"),
      ui.busy ? h("div.progress", { style: { marginTop: "10px" } }, ui.busy) : null));
  } else {
    center.append(...buildViewer(sheet, sheetDevices, data, typeMap, ctx, picker));
    const rb = revisionBanner(data); if (rb) center.prepend(rb); // same sheet in two uploads: compare and merge
  }
  center.append(fileInput);

  // ---------- tool windows: floating, movable, resizable (opened from the Tools menu) ----------
  const windows = sheet ? buildToolWindows(buildInspector(sheet, sheetDevices, data, types, typeMap, roomsById, ctx), ctx) : [];

  root.replaceChildren(h("div.workspace.full", center, ...windows));

  async function uploadPlan(file) {
    if (!file) return;
    try {
      ui.busy = `Uploading ${file.name}…`; ctx.rerender();
      const plan = await api(`/api/jobs/${data.job.id}/plans?filename=${encodeURIComponent(file.name)}`, {
        method: "POST", body: file, headers: { "Content-Type": "application/pdf" },
      });
      const doc = await loadPdf(plan.id);
      const out = [];
      for (let p = 1; p <= doc.numPages; p++) {
        ui.busy = `Reading sheet ${p} of ${doc.numPages}…`; ctx.rerender();
        out.push(await describePage(await doc.getPage(p), p));
      }
      await api(`/api/plans/${plan.id}/sheets`, { json: { sheets: out } });
      const el = out.filter((s) => s.kind === "electrical").length;
      toast(`${doc.numPages} sheets added, ${el} look like electrical plans.`);
    } catch (e) { toast(e.message, true); }
    ui.busy = null; ui.sheetId = null;
    await ctx.reload();
  }
}

// ======================================================================
// Tool windows: every inspector section opens as a floating window (Tools menu). Windows are dragged by their
// title bar, resized from the corner, and keep their position / size / open state between visits.
const TOOL_WINDOWS = [
  ["catalog & packages", "Catalog & packages"], ["panels & risers", "Panels & risers"], ["claude analysis", "Claude analysis"], ["code check", "Code check"],
  ["led tape", "LED tape"], ["lighting zones", "Lighting zones"], ["on this sheet", "On this sheet"],
  ["add devices by hand", "Add devices by hand"], ["sheet info", "Sheet info"],
];
ui.win = (() => { try { return JSON.parse(localStorage.getItem("takeoff.windows") || "{}"); } catch { return {}; } })();
ui.toolsOpen = false;
let zTop = 30;
const toolScroll = {};
const saveWin = () => { try { localStorage.setItem("takeoff.windows", JSON.stringify(ui.win)); } catch { /* storage blocked */ } };
function winState(key, i) {
  if (!ui.win[key]) ui.win[key] = key === "catalog & packages" ? { open: true, x: 10, y: 170, w: 340, h: 520 }
    : { open: key === "claude analysis", x: Math.max(10, innerWidth - 360 - i * 24), y: 110 + i * 28, w: 340, h: 440 };
  return ui.win[key];
}

/** Turn the inspector sections into floating windows. Sections without a heading are the current selection. */
function buildToolWindows(sections, ctx) {
  const out = [];
  const selection = sections.filter((el) => el && !el.querySelector?.(":scope > h3"));
  if (selection.length) out.push(toolWindow("selection", "Selected", selection, ctx, 0, true));
  sections.forEach((el) => {
    const head = el?.querySelector?.(":scope > h3");
    if (!head) return;
    const key = head.textContent.replace(/\(.*?\)/g, "").trim().toLowerCase();
    const i = TOOL_WINDOWS.findIndex(([k]) => k === key);
    const st = winState(key, Math.max(0, i));
    if (!st.open) return;
    const title = head.textContent;
    head.remove();
    out.push(toolWindow(key, title, [...el.childNodes], ctx, i));
  });
  return out;
}

function toolWindow(key, title, content, ctx, i, auto = false) {
  const st = winState(key, Math.max(0, i));
  if (auto) st.open = true;
  const clamp = () => {
    st.x = Math.min(Math.max(0, st.x), innerWidth - 120);
    st.y = Math.min(Math.max(48, st.y), innerHeight - 40);
  };
  clamp();
  const win = h("div.tool-window", { style: { left: `${st.x}px`, top: `${st.y}px`, width: `${st.w}px`, height: `${st.h}px`, zIndex: st.z || ++zTop } });
  const bar = h("div.tool-bar",
    h("strong.grow", title),
    h("button.small", { title: "Close", onclick: (e) => {
      e.stopPropagation();
      if (key === "selection") { ui.selected = null; ui.selectedEquip = null; ui.selectedTape = null; }
      else { st.open = false; saveWin(); }
      ctx.rerender();
    } }, "×"));
  // Keep each window's scroll position across redraws (e.g. while assigning lights to zones).
  const body = h("div.tool-body", { onscroll: (e) => { toolScroll[key] = e.target.scrollTop; } }, content);
  win.append(bar, body);
  requestAnimationFrame(() => { body.scrollTop = toolScroll[key] || 0; });
  win.addEventListener("pointerdown", () => { st.z = ++zTop; win.style.zIndex = st.z; });
  // Drag by the title bar.
  bar.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    e.preventDefault();
    bar.setPointerCapture(e.pointerId);
    const sx = e.clientX - st.x, sy = e.clientY - st.y;
    const move = (ev) => { st.x = ev.clientX - sx; st.y = ev.clientY - sy; clamp(); win.style.left = `${st.x}px`; win.style.top = `${st.y}px`; };
    const up = () => { bar.removeEventListener("pointermove", move); bar.removeEventListener("pointerup", up); saveWin(); };
    bar.addEventListener("pointermove", move); bar.addEventListener("pointerup", up);
  });
  // Resize from the corner (CSS resize); remember the size.
  let t;
  new ResizeObserver(() => {
    clearTimeout(t);
    t = setTimeout(() => { if (win.isConnected) { st.w = win.offsetWidth; st.h = win.offsetHeight; saveWin(); } }, 200);
  }).observe(win);
  return win;
}

/** Toolbar menu with a button for each tool window. */
function buildToolsMenu(ctx) {
  const menu = h("div.tools-menu", { hidden: !ui.toolsOpen },
    TOOL_WINDOWS.map(([key, label], i) => {
      const st = winState(key, i);
      return h("button.tool-item" + (st.open ? ".on" : ""), {
        onclick: () => { st.open = !st.open; if (st.open) st.z = ++zTop; saveWin(); ui.toolsOpen = false; ctx.rerender(); },
      }, h("span", st.open ? "✓" : ""), label);
    }),
    h("div.row", { style: { marginTop: "6px", gap: "4px" } },
      h("button.small", { onclick: () => { TOOL_WINDOWS.forEach(([k], i) => (winState(k, i).open = false)); saveWin(); ctx.rerender(); } }, "Close all"),
      h("button.small", { title: "Put every window back on the right side", onclick: () => { ui.win = {}; saveWin(); ui.toolsOpen = false; ctx.rerender(); } }, "Reset layout")));
  const btn = h("button.small.tools-btn" + (ui.toolsOpen ? ".primary" : ""), {
    onclick: () => { ui.toolsOpen = !ui.toolsOpen; menu.hidden = !ui.toolsOpen; btn.classList.toggle("primary", ui.toolsOpen); },
  }, "Tools ▾");
  return h("div", { style: { position: "relative" } }, btn, menu);
}

// ======================================================================
// Sheet picker: a toolbar button + popup with sheets grouped by discipline in collapsible sections.
const DISCIPLINES = [
  ["electrical", "Electrical"], ["floor", "Floor plans"], ["rcp", "Reflected ceiling"], ["mechanical", "Mechanical"],
  ["plumbing", "Plumbing"], ["elevations", "Elevations"], ["details", "Details & sections"], ["schedules", "Schedules"], ["other", "Other"],
];
function disciplineOf(s, plan) {
  const t = (s.title || "").toUpperCase();
  if (s.kind === "electrical") return "electrical";
  if (plan?.doc_type === "mechanical" || /MECHANICAL|HVAC/.test(t)) return "mechanical";
  if (/PLUMB/.test(t)) return "plumbing";
  if (/REFLECTED|CEILING PLAN|\bRCP\b/.test(t)) return "rcp";
  if (s.kind === "floor" || /FLOOR\s+PLAN/.test(t)) return "floor";
  if (/ELEVATION/.test(t)) return "elevations";
  if (/DETAIL|SECTION/.test(t)) return "details";
  if (/SCHEDULE/.test(t)) return "schedules";
  return "other";
}
ui.sheetsOpen = false;
ui.sheetQuery = "";
ui.sheetGroups = (() => { try { return new Set(JSON.parse(localStorage.getItem("takeoff.sheetGroups") || '["electrical"]')); } catch { return new Set(["electrical"]); } })();
const saveSheetGroups = () => { try { localStorage.setItem("takeoff.sheetGroups", JSON.stringify([...ui.sheetGroups])); } catch { /* storage blocked */ } };

function buildSheetPicker(sheets, current, data, ctx, onUpload) {
  const planById = new Map(data.plans.map((p) => [p.id, p]));
  const disc = new Map(sheets.map((s) => [s.id, disciplineOf(s, planById.get(s.plan_id))]));
  const go = (s) => { ui.sheetId = s.id; ui.selected = null; ui.zoom = null; ui.sheetsOpen = false; ctx.rerender(); };
  // ◀ ▶ step through sheets of the current discipline.
  const same = current ? sheets.filter((s) => disc.get(s.id) === disc.get(current.id)) : [];
  const idx = same.findIndex((s) => s.id === current?.id);

  const q = ui.sheetQuery.trim().toLowerCase();
  const match = (s) => !q || `${s.sheet_no} ${s.title} ${s.level}`.toLowerCase().includes(q);
  const row = (s) => {
    const devs = data.devices.filter((d) => d.sheet_id === s.id);
    const pend = devs.filter((d) => d.status === "pending").length;
    return h("div.sheet-item" + (s.id === current?.id ? ".active" : ""), { onclick: () => go(s), title: s.title },
      h("span.no", { style: s.replaced_by ? { opacity: 0.5, textDecoration: "line-through" } : null }, s.sheet_no || `p${s.page}`),
      h("div.grow", { style: { minWidth: 0 } },
        h("div.t", s.title || `Page ${s.page}`),
        devs.length || pend ? h("div.row", { style: { gap: "4px" } },
          devs.length ? h("span.badge.ai", `${devs.length} devices`) : null,
          pend ? h("span.badge.pending", `${pend} to check`) : null) : null,
        s.replaced_by ? h("span.badge", "Replaced by newer revision") : null));
  };
  const search = h("input", { placeholder: "Search sheets…", value: ui.sheetQuery, style: { flex: 1 },
    oninput: (e) => { ui.sheetQuery = e.target.value; const pos = e.target.selectionStart; ctx.rerender(); const s2 = document.querySelector(".sheet-panel input"); if (s2) { s2.focus(); s2.setSelectionRange(pos, pos); } } });

  const panel = h("div.sheet-panel", { hidden: !ui.sheetsOpen },
    h("div.row", { style: { gap: "6px", marginBottom: "6px" } }, search,
      h("button.small.primary", { onclick: onUpload, disabled: !!ui.busy }, "Upload PDF")),
    ui.busy ? h("div.progress", { style: { marginBottom: "6px" } }, ui.busy) : null,
    DISCIPLINES.map(([key, label]) => {
      const list = sheets.filter((s) => disc.get(s.id) === key && match(s));
      if (!list.length) return null;
      const open = q ? true : ui.sheetGroups.has(key);
      const devCount = data.devices.filter((d) => list.some((s) => s.id === d.sheet_id)).length;
      return h("div.sheet-group",
        h("div.sheet-group-head", { onclick: () => { open ? ui.sheetGroups.delete(key) : ui.sheetGroups.add(key); saveSheetGroups(); ctx.rerender(); } },
          h("span", open ? "▾" : "▸"), h("strong.grow", label), h("span.muted", `${list.length}`),
          devCount ? h("span.badge.ai", `${devCount} devices`) : null),
        open ? list.map(row) : null);
    }));

  const btn = h("button.small.sheets-btn" + (ui.sheetsOpen ? ".primary" : ""), {
    title: "Choose a sheet", onclick: () => { ui.sheetsOpen = !ui.sheetsOpen; panel.hidden = !ui.sheetsOpen; btn.classList.toggle("primary", ui.sheetsOpen); },
  }, `☰ Sheets (${sheets.length})`);
  return h("div.row", { style: { gap: "4px", position: "relative" } },
    btn,
    h("button.small", { title: "Previous sheet in this discipline", disabled: idx <= 0, onclick: () => go(same[idx - 1]) }, "◀"),
    h("button.small", { title: "Next sheet in this discipline", disabled: idx < 0 || idx >= same.length - 1, onclick: () => go(same[idx + 1]) }, "▶"),
    panel);
}

function buildViewer(sheet, devices, data, typeMap, ctx, picker) {
  const viewer = h("div.viewer");
  const stage = h("div.stage");
  const canvas = h("canvas");
  const overlay = h("div.overlay" + (ui.placeType || ui.placeItem || ui.placeEquip || ui.drawTape ? ".placing" : ""));
  stage.append(canvas, overlay);
  viewer.append(stage);

  // Fit = the whole sheet in view (width and height), so big screens use their space (Tony, 2026-11-19)
  const fitZoom = () => Math.max(0.1, Math.min((viewer.clientWidth - 40) / sheet.width, (viewer.clientHeight - 40) / sheet.height));
  const setZoom = (z, anchor, fit = false) => {
    const old = ui.zoom, ox = stage.offsetLeft, oy = stage.offsetTop;
    ui.zoom = Math.min(6, Math.max(0.1, z)); ui.fitted = fit;
    layout();
    if (anchor && old) {
      // keep the drawing point under the cursor fixed (the page is centred, so its offset changes with the zoom)
      const r = ui.zoom / old;
      viewer.scrollLeft = (viewer.scrollLeft + anchor.x - ox) * r + stage.offsetLeft - anchor.x;
      viewer.scrollTop = (viewer.scrollTop + anchor.y - oy) * r + stage.offsetTop - anchor.y;
    }
    scheduleRender();
  };
  // a fitted sheet stays fitted when the window is resized or maximised
  if (window.ResizeObserver) { let rt; new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => { if (ui.fitted && viewer.isConnected && viewer.clientWidth) setZoom(fitZoom(), null, true); }, 150); }).observe(viewer); }

  const pending = devices.filter((d) => d.status === "pending");
  const groups = [...new Set(Object.values(LAYERS).map((v) => v.group))];
  const setGroup = (g, on) => { for (const [k, v] of Object.entries(LAYERS)) if (v.group === g) ui.layers[k] = on; saveLayers(); ctx.rerender(); };
  const layerPanel = h("div.layer-panel", { hidden: !ui.layersOpen },
    groups.map((g) => [
      h("div.row", { style: { marginTop: g === groups[0] ? 0 : "8px", gap: "6px" } },
        h("strong.grow", { style: { fontSize: ".72rem", textTransform: "uppercase", letterSpacing: ".04em", color: "var(--muted)" } }, g),
        h("a", { style: { fontSize: ".72rem" }, onclick: () => setGroup(g, true) }, "all"),
        h("a", { style: { fontSize: ".72rem" }, onclick: () => setGroup(g, false) }, "none")),
      Object.entries(LAYERS).filter(([, v]) => v.group === g).map(([k, v]) => h("label", { style: { display: "flex", gap: "6px", alignItems: "center", whiteSpace: "nowrap" } },
        h("input", { type: "checkbox", checked: ui.layers[k], onchange: (e) => { ui.layers[k] = e.target.checked; saveLayers(); drawMarkers(); } }),
        v.color ? h("span.swatch", { style: { background: v.color, ...(k.startsWith("hr_") ? { borderRadius: "2px", height: "4px", width: "14px" } : {}) } }) : h("span", { style: { width: "12px" } }),
        v.label)),
    ]),
    h("div.row", { style: { marginTop: "6px", gap: "4px" } },
      h("button.small", { onclick: () => { for (const k of Object.keys(LAYERS)) ui.layers[k] = true; saveLayers(); ctx.rerender(); } }, "All"),
      h("button.small", { onclick: () => { for (const k of Object.keys(LAYERS)) ui.layers[k] = false; saveLayers(); ctx.rerender(); } }, "All off"),
      h("button.small", { onclick: () => { for (const [k, v] of Object.entries(LAYERS)) ui.layers[k] = v.def; saveLayers(); ctx.rerender(); } }, "Default")));
  const toolbar = h("div.toolbar",
    picker,
    h("strong", sheet.sheet_no || `Page ${sheet.page}`), h("span.muted", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "260px" }, title: sheet.title }, sheet.level || sheet.title || ""),
    h("span.grow"),
    ui.placeType ? h("span.badge.pending", `Placing: ${typeMap[ui.placeType].label} — click the plan (Esc to stop)`) : null,
    ui.placeEquip ? h("span.badge.pending", `Placing: ${EQUIP_LABEL[ui.placeEquip]} — click the plan (Esc to stop)`) : null,
    ui.drawTape ? h("span.badge.pending", "LED tape: click each corner (runs snap to right angles) · double-click or Enter to finish · Backspace undoes a point · Esc cancels") : null,
    ui.activeZone ? h("span.badge.pending", `Zoning: click lights to add/remove from “${(data.zones || []).find((z) => z.id === ui.activeZone)?.code || ""}” (Esc to stop)`) : null,
    h("div", { style: { position: "relative" } },
      h("button.small.layers-btn" + (ui.layersOpen ? ".primary" : ""), { onclick: () => { ui.layersOpen = !ui.layersOpen; layerPanel.hidden = !ui.layersOpen; } }, "Layers ▾"),
      layerPanel),
    h("button.small" + (ui.zoneMode ? ".primary" : ""), { title: "Colour markers by zone", onclick: () => { ui.zoneMode = !ui.zoneMode; if (!ui.zoneMode) ui.activeZone = null; ctx.rerender(); } }, ui.zoneMode ? "Colour: zones" : "Colour: types"),
    pending.length ? h("button.small", { onclick: () => nextPending(1) }, `Next to check (${pending.length})`) : null,
    h("button.small", { title: undoStack.length ? `Undo ${undoStack[undoStack.length - 1].label} (Ctrl+Z)` : "Nothing to undo", disabled: !undoStack.length, onclick: () => undoLast(ctx) }, `↶ Undo${undoStack.length ? ` (${undoStack.length})` : ""}`),
    h("button.small", { onclick: () => setZoom(ui.zoom / 1.25) }, "−"),
    h("button.small", { onclick: () => { setZoom(fitZoom(), null, true); } }, "Fit"),
    h("button.small", { onclick: () => setZoom(ui.zoom * 1.25) }, "+"),
    buildToolsMenu(ctx),
  );
  // Long-running work (analysis, zoning, code check) shows its progress in the toolbar, whatever windows are open.
  if (ui.busy) toolbar.append(h("div.progress", { style: { flexBasis: "100%", padding: "4px 8px" } }, ui.busy));

  // ---- layout & rendering ----
  function layout() {
    stage.style.width = `${sheet.width * ui.zoom}px`;
    stage.style.height = `${sheet.height * ui.zoom}px`;
    canvas.style.width = "100%"; canvas.style.height = "100%";
    drawMarkers();
  }
  let renderTask = null, renderTimer = null;
  function scheduleRender() { clearTimeout(renderTimer); renderTimer = setTimeout(render, 120); }
  async function render() {
    const doc = await loadPdf(sheet.plan_id);
    const page = await doc.getPage(sheet.page);
    let scale = ui.zoom * (window.devicePixelRatio || 1);
    const maxPx = 24e6;
    if (sheet.width * sheet.height * scale * scale > maxPx) scale = Math.sqrt(maxPx / (sheet.width * sheet.height));
    const key = `${sheet.id}@${scale.toFixed(3)}`;
    const paint = (src) => { canvas.width = src.width; canvas.height = src.height; canvas.getContext("2d").drawImage(src, 0, 0); };
    if (pageCache.key === key) return paint(pageCache.canvas);
    const vp = page.getViewport({ scale });
    renderTask?.cancel();
    const off = document.createElement("canvas");
    off.width = Math.floor(vp.width); off.height = Math.floor(vp.height);
    renderTask = page.render({ canvas: off, viewport: vp });
    try {
      await renderTask.promise;
      pageCache.key = key; pageCache.canvas = off;
      paint(off);
    } catch (e) { if (e?.name !== "RenderingCancelledException") console.error(e); }
  }

  // ---- markers ----
  function drawMarkers() {
    const z = ui.zoom;
    const nodes = [];
    const svg = drawWiring(z);
    if (svg) nodes.push(svg);
    nodes.push(...drawTapeRuns(z));
    if (ui.layers.rooms) {
      for (const r of data.rooms.filter((r) => r.sheet_id === sheet.id && r.x != null)) {
        nodes.push(h("div.room-label", { style: { left: `${r.x * z}px`, top: `${r.y * z - 18}px` } }, `${r.number ? r.number + " " : ""}${r.name}`));
      }
    }
    const zc = zoneColors(data.zones || []);
    const zoneName = new Map((data.zones || []).map((zz) => [zz.id, zz.name]));
    const fixtures = ctx.meta.fixture_types;
    // Each device sits on its system's layer (receptacles with power, fixtures by kind, smoke/CO with life safety).
    const deviceVisible = (d) => d.id === ui.selected || !!ui.layers[TYPE_LAYER[d.type] || "other_devices"];
    for (const d of devices) {
      if (d.x == null || ui.hidden.has(d.type) || !deviceVisible(d)) continue;
      const t = typeMap[d.type] || typeMap.other;
      let bg = t.color, opacity = null, label = t.code;
      if (ui.zoneMode) {
        if (!fixtures.includes(d.type)) opacity = 0.25;
        else if (d.zone_id && zc.has(d.zone_id)) { bg = zc.get(d.zone_id); if (ui.activeZone && d.zone_id !== ui.activeZone) opacity = 0.45; }
        else { bg = "#9ca3af"; label = "?"; }
      }
      const m = h("div.marker" + (d.status === "pending" ? ".pending" : "") + (d.source === "code" ? ".code" : "") + (d.item_id ? ".itm" : "") + (d.id === ui.selected ? ".selected" : ""), {
        style: { left: `${d.x * z}px`, top: `${d.y * z}px`, background: bg, ...(opacity != null ? { opacity } : {}) },
        title: `${d.item_id && CAT.cache.get(d.item_id) ? itemName(CAT.cache.get(d.item_id)) + " · " : ""}${t.label}${d.zone_id ? " · zone: " + (zoneName.get(d.zone_id) || "") : ""}${d.note ? " — " + d.note : ""}${d.confidence != null ? ` (${Math.round(d.confidence * 100)}%)` : ""}`,
      }, label);
      m.dataset.id = d.id;
      attachDrag(m, d);
      nodes.push(m);
    }
    // Zone codes (104.01, K104.02, D104.03) at the middle of each zone's fixtures.
    if (ui.layers.zone_codes) {
      for (const zn of (data.zones || []).filter((x) => x.sheet_id === sheet.id)) {
        const pts = devices.filter((d) => d.zone_id === zn.id && d.x != null);
        if (!pts.length) continue;
        const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length, cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
        nodes.push(h("div.zone-code", { style: { left: `${cx * z}px`, top: `${cy * z}px`, borderColor: zc.get(zn.id), color: zc.get(zn.id) }, title: zn.name }, zn.code || zn.name));
      }
    }
    // Open code findings: where a code-required device is missing.
    if (ui.layers.code) {
      for (const f of (data.findings || []).filter((x) => x.sheet_id === sheet.id && x.status === "open" && x.x != null)) {
        nodes.push(h("div.finding" + (f.severity === "review" ? ".review" : "") + (f.id === ui.selectedFinding ? ".selected" : ""), {
          style: { left: `${f.x * z}px`, top: `${f.y * z}px` }, title: `${f.rule} (${f.code_ref}): ${f.message}`,
          onclick: (e) => { e.stopPropagation(); ui.selectedFinding = f.id; ctx.rerender(); },
        }, "!"));
      }
    }
    // Panels and risers.
    for (const eq of (data.equipment || []).filter((x) => ui.layers.panels && x.sheet_id === sheet.id && x.x != null)) {
      const el = h("div.equip" + (eq.id === ui.selectedEquip ? ".selected" : "") + (eq.source === "ai" ? ".ai" : ""), {
        style: { left: `${eq.x * z}px`, top: `${eq.y * z}px`, background: EQUIP_COLOR[eq.kind] },
        title: `${eq.name}${eq.source === "ai" ? " (found by Claude: drag to the exact spot or edit to confirm)" : ""}`,
      }, EQUIP_CODE[eq.kind], h("span.equip-name", eq.name));
      attachEquipDrag(el, eq);
      nodes.push(el);
    }
    overlay.replaceChildren(...nodes);
  }

  /** LED tape runs: thick right-angle line, a tick at every feed point, and a clickable label. */
  function drawTapeRuns(z) {
    const out = [];
    const calc = new Map((ctx.system?.tape?.runs || []).map((r) => [r.id, r]));
    const zoneById = new Map((data.zones || []).map((x) => [x.id, x]));
    const svg = svgEl("svg", { class: "wiring", width: sheet.width * z, height: sheet.height * z });
    if (ui.layers.led) {
      for (const t of (data.tape_runs || []).filter((r) => r.sheet_id === sheet.id)) {
        const c = calc.get(t.id);
        const color = TAPE_COLOR[c?.type] || TAPE_COLOR.lucetta;
        const d = t.points.map((p, i) => `${i ? "L" : "M"}${(p.x * z).toFixed(1)},${(p.y * z).toFixed(1)}`).join(" ");
        svg.append(svgEl("path", { d, fill: "none", stroke: color, "stroke-width": t.id === ui.selectedTape ? 7 : 5, "stroke-linecap": "square", opacity: 0.75 }));
        // Feed points: start of each segment along the run.
        if (c) {
          const total = t.points.reduce((a, p, i) => (i ? a + Math.abs(p.x - t.points[i - 1].x) + Math.abs(p.y - t.points[i - 1].y) : 0), 0);
          for (let k = 0; k < c.segments; k++) {
            let target = (total * k) / c.segments, acc = 0;
            for (let i = 1; i < t.points.length; i++) {
              const a = t.points[i - 1], b = t.points[i], len = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
              if (acc + len >= target) {
                const f = len ? (target - acc) / len : 0;
                svg.append(svgEl("circle", { cx: (a.x + (b.x - a.x) * f) * z, cy: (a.y + (b.y - a.y) * f) * z, r: 4.5, fill: "#fff", stroke: color, "stroke-width": 2 }));
                break;
              }
              acc += len;
            }
          }
        }
        const mid = t.points[Math.floor((t.points.length - 1) / 2)];
        const zn = zoneById.get(t.zone_id);
        const label = c ? `${zn?.code || "?"} · ${c.ft}' · ${c.segments} feed${c.segments > 1 ? "s" : ""} · ${c.drivers ? `${c.drivers}×${c.driver_watts}W` : "shared driver"}` : "LED tape";
        const chip = h("div.tape-chip" + (t.id === ui.selectedTape ? ".selected" : ""), {
          style: { left: `${mid.x * z}px`, top: `${mid.y * z}px`, borderColor: color, color },
          onclick: (e) => { e.stopPropagation(); ui.selectedTape = t.id; ui.selected = null; ui.selectedEquip = null; ctx.rerender(); },
        }, label);
        out.push(chip);
      }
    }
    // Run being drawn.
    if (ui.drawTape?.points.length) {
      const pts = ui.drawTape.points;
      svg.append(svgEl("path", { d: pts.map((p, i) => `${i ? "L" : "M"}${p.x * z},${p.y * z}`).join(" "), fill: "none", stroke: "#0d9488", "stroke-width": 5, opacity: 0.6 }));
      const last = pts[pts.length - 1];
      svg.append(svgEl("line", { class: "tape-preview-next", x1: last.x * z, y1: last.y * z, x2: last.x * z, y2: last.y * z, stroke: "#0d9488", "stroke-width": 3, "stroke-dasharray": "6 4" }));
      for (const p of pts) svg.append(svgEl("circle", { cx: p.x * z, cy: p.y * z, r: 3, fill: "#0d9488" }));
    }
    if (svg.childNodes.length) out.unshift(svg);
    return out;
  }

  /** SVG layer with zone wiring and circuits: device-to-device runs plus a dashed home run to the panel. */
  function drawWiring(z) {
    const dr = ctx.system?.drawing;
    if (!dr) return null;
    const svg = svgEl("svg", { class: "wiring", width: sheet.width * z, height: sheet.height * z });
    const byId = new Map(devices.map((d) => [d.id, d]));
    const zc = zoneColors(data.zones || []);
    const zoneById = new Map((data.zones || []).map((x) => [x.id, x]));
    const P = (p) => `${(p.x * z).toFixed(1)},${(p.y * z).toFixed(1)}`;

    // Runs are drawn at right angles (across, then up/down), the way power and lighting are run.
    const ortho = (pts) => pts.map((p, i) => (i === 0 ? `M${(p.x * z).toFixed(1)},${(p.y * z).toFixed(1)}` : `H${(p.x * z).toFixed(1)} V${(p.y * z).toFixed(1)}`)).join(" ");
    /**
     * One zone or circuit: the device-to-device run sits on its system layer (chainLayer), the dashed
     * home run to the panel on that system's HR layer (hrLayer). Labels follow whichever part is visible.
     */
    const drawRun = (pts, end, color, name, hrFt, order, chainLayer, hrLayer, isCircuit = false) => {
      const showChain = chainLayer && ui.layers[chainLayer], showHr = hrLayer && ui.layers[hrLayer] && end;
      if (!showChain && !showHr) return;
      const cur = new Map(devices.map((d) => [d.id, d]));
      const ordered = order?.length
        ? order.map((o) => (o.id && cur.get(o.id)) || o).filter((p) => p.x != null)
        : chain(pts.filter((p) => p && p.x != null), end);
      if (!ordered.length) return;
      // zones are solid lines; branch circuits (several zones/rooms on one breaker) are dotted so they don't read as a zone (Tony, 2026-11-09)
      if (showChain && ordered.length > 1) svg.append(svgEl("path", { d: ortho(ordered), fill: "none", stroke: color, "stroke-width": isCircuit ? 1.3 : 1.8, "stroke-linejoin": "miter", opacity: 0.9, ...(isCircuit ? { "stroke-dasharray": "1.5 3.5", "stroke-linecap": "round" } : {}) }));
      const start = ordered[0];
      if (showHr) {
        // Home run drawn as an L (across, then down) the way it is routed, dashed, with a dot at the panel.
        svg.append(svgEl("polyline", { points: `${P(start)} ${P({ x: end.x, y: start.y })} ${P(end)}`, fill: "none", stroke: color, "stroke-width": 1.8, "stroke-dasharray": "6 4", opacity: 0.85 }));
        svg.append(svgEl("circle", { cx: end.x * z, cy: end.y * z, r: 3, fill: color }));
      }
      const label = showHr ? `${name} · HR ${hrFt}'` : name;
      if (!label) return;
      const lx = showHr ? (start.x + end.x) / 2 : start.x, ly = start.y;
      const t = svgEl("text", { x: lx * z, y: ly * z - 4, fill: color, "font-size": 11, "font-weight": 700, "text-anchor": "middle", "paint-order": "stroke", stroke: "#fff", "stroke-width": 3 });
      t.textContent = label;
      svg.append(t);
    };

    // Lighting zones: the layer follows the kind of fixtures in the zone (recessed, decorative, LED, fans).
    const tapeZones = new Set((data.tape_runs || []).map((t) => t.zone_id));
    for (const zr of dr.zones.filter((x) => x.sheet_id === sheet.id)) {
      const zn = zoneById.get(zr.zone_id);
      const pts = devices.filter((d) => d.zone_id === zr.zone_id);
      const cat = groupCategory(pts.map((d) => d.type), tapeZones.has(zr.zone_id));
      drawRun(pts, zr.end, zc.get(zr.zone_id) || "#555", zn?.code || "", zr.ft, zr.order, cat, `hr_${cat}`);
    }
    // Circuits: power / life safety by class; lighting and Ketra/DALI circuits by their fixtures; HR-only for feeds.
    for (const c of dr.circuits.filter((x) => x.sheet_id === sheet.id)) {
      const pts = [...(c.device_ids || []).map((id) => byId.get(id)), ...(c.points || [])];
      const types = (c.device_ids || []).map((id) => byId.get(id)?.type).filter(Boolean);
      const cat = { power: "power", gfci: "power", c240: "power", safety: "life_safety" }[c.cls] || (c.cls === "lighting" || c.cls === "pd8" ? groupCategory(types, false) : null);
      const hr = { feeder: "hr_pd8", dedicated: "hr_equipment", backup: "hr_backup" }[c.cls] || (cat ? `hr_${cat}` : null);
      drawRun(pts, c.end, CIRCUIT_COLOR[c.cls], `${c.cls === "lighting" ? "Circuit " : ""}${c.label}${c.cable ? ` ${c.cable}` : ""}`, c.ft, c.order, cat, hr, true);
    }
    return svg.childNodes.length ? svg : null;
  }

  function attachEquipDrag(el, eq) {
    el.addEventListener("pointerdown", (e) => {
      e.stopPropagation(); e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const start = { x: e.clientX, y: e.clientY }; let moved = false;
      const move = (ev) => {
        const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
        if (Math.hypot(dx, dy) > 3) moved = true;
        if (moved) { el.style.left = `${eq.x * ui.zoom + dx}px`; el.style.top = `${eq.y * ui.zoom + dy}px`; }
      };
      const up = async (ev) => {
        el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up);
        if (moved) {
          const prev = { x: eq.x, y: eq.y };
          await patchEquip(data, eq.id, { x: eq.x + (ev.clientX - start.x) / ui.zoom, y: eq.y + (ev.clientY - start.y) / ui.zoom });
          pushUndo(`move ${eq.name}`, () => api(`/api/equipment/${eq.id}`, { method: "PATCH", json: prev }));
        }
        ui.selectedEquip = eq.id; ui.selected = null;
        if (moved) return ctx.refreshSystem(); // home runs follow the panel
        ctx.rerender();
      };
      el.addEventListener("pointermove", move); el.addEventListener("pointerup", up);
    });
  }

  function attachDrag(el, d) {
    el.addEventListener("pointerdown", (e) => {
      e.stopPropagation(); e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const start = { x: e.clientX, y: e.clientY }; let moved = false;
      const move = (ev) => {
        const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
        if (Math.hypot(dx, dy) > 3) moved = true;
        if (moved) { el.style.left = `${d.x * ui.zoom + dx}px`; el.style.top = `${d.y * ui.zoom + dy}px`; }
      };
      const up = async (ev) => {
        el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up);
        if (moved) {
          const nx = d.x + (ev.clientX - start.x) / ui.zoom, ny = d.y + (ev.clientY - start.y) / ui.zoom;
          await ctx.patchDevice(d.id, { x: nx, y: ny });
        } else if (ui.activeZone && ctx.meta.fixture_types.includes(d.type)) {
          // zoning: toggle this light in/out of the active zone
          await ctx.patchDevice(d.id, { zone_id: d.zone_id === ui.activeZone ? null : ui.activeZone });
          return;
        }
        ui.selected = d.id; ctx.rerender();
      };
      el.addEventListener("pointermove", move); el.addEventListener("pointerup", up);
    });
  }

  // ---- pan: drag the drawing with the left button (on empty space) or the middle button (anywhere) ----
  let pan = null, justPanned = false;
  viewer.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    if (e.button === 0 && e.target.closest(".marker, .equip")) return; // markers handle their own drag
    // Stop the browser from starting its own image drag / text selection (the "no entry" cursor)
    // and, for the middle button, its autoscroll. Clicks still fire normally.
    e.preventDefault();
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    pan = { id: e.pointerId, x: e.clientX, y: e.clientY, l: viewer.scrollLeft, t: viewer.scrollTop, moved: false };
  });
  viewer.addEventListener("pointermove", (e) => {
    if (!pan || e.pointerId !== pan.id) return;
    const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
    if (!pan.moved && Math.hypot(dx, dy) < 4) return; // small jitter still counts as a click
    if (!pan.moved) { pan.moved = true; viewer.setPointerCapture(e.pointerId); viewer.classList.add("panning"); }
    viewer.scrollLeft = pan.l - dx;
    viewer.scrollTop = pan.t - dy;
  });
  const endPan = (e) => {
    if (!pan || e.pointerId !== pan.id) return;
    if (pan.moved) { justPanned = true; setTimeout(() => (justPanned = false), 0); }
    viewer.classList.remove("panning");
    pan = null;
  };
  viewer.addEventListener("pointerup", endPan);
  viewer.addEventListener("pointercancel", endPan);
  viewer.addEventListener("auxclick", (e) => e.button === 1 && e.preventDefault());
  viewer.addEventListener("dragstart", (e) => e.preventDefault());
  viewer.addEventListener("mousedown", (e) => e.preventDefault()); // belt and braces for native drag/select
  canvas.draggable = false;

  overlay.addEventListener("click", async (e) => {
    if (justPanned) return; // the drag was a pan, not a click to place/deselect
    if (e.target !== overlay && !(ui.drawTape && e.target.closest?.(".overlay"))) return;
    const rect = overlay.getBoundingClientRect();
    const x = (e.clientX - rect.left) / ui.zoom, y = (e.clientY - rect.top) / ui.zoom;
    if (ui.drawTape) {
      const pts = ui.drawTape.points;
      const p = snapOrtho(pts[pts.length - 1], { x, y });
      if (!pts.length || Math.hypot(p.x - pts[pts.length - 1].x, p.y - pts[pts.length - 1].y) > 2) pts.push(p);
      drawMarkers();
      return;
    }
    if (ui.placeEquip) {
      try {
        const eq = await api(`/api/jobs/${data.job.id}/equipment`, { json: { kind: ui.placeEquip, sheet_id: sheet.id, x, y } });
        data.equipment.push(eq);
        pushUndo(`add ${eq.name}`, () => api(`/api/equipment/${eq.id}`, { method: "DELETE" }));
        ui.placeEquip = null; ui.selectedEquip = eq.id; ui.selected = null;
        ctx.refreshSystem();
      } catch (err) { toast(err.message, true); }
      return;
    }
    if (ui.placeItem) { await placeItem(ctx, sheet, ui.placeItem, x, y); return; }
    if (!ui.placeType) { if (ui.selected || ui.selectedEquip) { ui.selected = null; ui.selectedEquip = null; ctx.rerender(); } return; }
    try {
      const d = await api(`/api/jobs/${data.job.id}/devices`, { json: { type: ui.placeType, sheet_id: sheet.id, x, y } });
      data.devices.push(d);
      pushUndo(`add ${typeMap[d.type]?.label || "device"}`, () => api(`/api/devices/${d.id}`, { method: "DELETE" }));
      ctx.rerender();
    } catch (err) { toast(err.message, true); }
  });

  // a catalog item dragged from the Catalog & packages window
  overlay.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("application/x-sis-item")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
  overlay.addEventListener("drop", async (e) => {
    const id = Number(e.dataTransfer.getData("application/x-sis-item")); if (!id) return;
    e.preventDefault();
    const rect = overlay.getBoundingClientRect(), x = (e.clientX - rect.left) / ui.zoom, y = (e.clientY - rect.top) / ui.zoom;
    const it = await itemInfo(id); if (!it) return toast("That catalog item is gone.", true);
    await placeItem(ctx, sheet, { id, label: itemName(it), type: await typeFor(it, ctx.types) }, x, y);
  });

  // LED tape drawing: live preview of the next segment, double-click to finish.
  overlay.addEventListener("pointermove", (e) => {
    if (!ui.drawTape?.points.length) return;
    const rect = overlay.getBoundingClientRect();
    const last = ui.drawTape.points[ui.drawTape.points.length - 1];
    const p = snapOrtho(last, { x: (e.clientX - rect.left) / ui.zoom, y: (e.clientY - rect.top) / ui.zoom });
    const line = overlay.querySelector(".tape-preview-next");
    if (line) { line.setAttribute("x2", p.x * ui.zoom); line.setAttribute("y2", p.y * ui.zoom); }
  });
  overlay.addEventListener("dblclick", (e) => { if (ui.drawTape) { e.preventDefault(); finishTape(ctx, sheet); } });

  // ---- zoom: mouse wheel zooms around the cursor (Shift + wheel scrolls instead) ----
  viewer.addEventListener("wheel", (e) => {
    if (e.shiftKey && !e.ctrlKey) return; // let Shift+wheel scroll sideways normally
    e.preventDefault();
    const rect = viewer.getBoundingClientRect();
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY; // lines -> pixels
    const factor = Math.exp(-Math.max(-300, Math.min(300, dy)) * 0.0015);
    setZoom(ui.zoom * factor, { x: e.clientX - rect.left, y: e.clientY - rect.top });
  }, { passive: false });

  function nextPending() {
    const list = devices.filter((d) => d.status === "pending" && d.x != null).sort((a, b) => a.y - b.y || a.x - b.x);
    if (!list.length) return;
    const i = list.findIndex((d) => d.id === ui.selected);
    const d = list[(i + 1) % list.length];
    ui.selected = d.id;
    if (ui.zoom < 1) ui.zoom = 1.5;
    ui.scrollTo = d;
    ctx.rerender();
  }

  // initial layout after mount
  requestAnimationFrame(() => {
    if (!ui.zoom) { ui.zoom = fitZoom(); ui.fitted = true; }
    layout(); render();
    if (ui.scrollTo) {
      viewer.scrollLeft = ui.scrollTo.x * ui.zoom - viewer.clientWidth / 2;
      viewer.scrollTop = ui.scrollTo.y * ui.zoom - viewer.clientHeight / 2;
      ui.scrollTo = null;
    } else if (ui.scroll) { viewer.scrollLeft = ui.scroll.l; viewer.scrollTop = ui.scroll.t; }
  });
  viewer.addEventListener("scroll", () => (ui.scroll = { l: viewer.scrollLeft, t: viewer.scrollTop }));

  return [toolbar, viewer];
}

// ======================================================================
function buildInspector(sheet, devices, data, types, typeMap, roomsById, ctx) {
  const out = [];
  const sel = devices.find((d) => d.id === ui.selected);

  if (sel) {
    const t = typeMap[sel.type];
    const sheetRooms = data.rooms.filter((r) => r.sheet_id === sheet.id || !r.sheet_id);
    out.push(h("div.section.card", { style: { padding: "12px" } },
      h("div.row", h("span.swatch", { style: { background: t.color } }), h("strong.grow", t.label),
        sel.status === "pending" ? h("span.badge.pending", "AI — check") : h("span.badge.ai", "Confirmed")),
      sel.confidence != null ? h("p.muted", { style: { fontSize: ".8rem" } }, `Claude confidence ${Math.round(sel.confidence * 100)}%`) : null,
      h("label.muted", { style: { fontSize: ".8rem" } }, "Type"),
      h("select", { style: { width: "100%" }, onchange: (e) => ctx.patchDevice(sel.id, { type: e.target.value, status: "confirmed" }) },
        types.map((x) => h("option", { value: x.key, selected: x.key === sel.type }, x.label))),
      itemPicker(sel, ctx),
      h("label.muted", { style: { fontSize: ".8rem" } }, "Room"),
      h("select", { style: { width: "100%" }, onchange: (e) => ctx.patchDevice(sel.id, { room_id: e.target.value ? Number(e.target.value) : null }) },
        h("option", { value: "" }, "— Unassigned —"),
        sheetRooms.map((r) => h("option", { value: r.id, selected: r.id === sel.room_id }, `${r.number ? r.number + " " : ""}${r.name}`))),
      ctx.meta.fixture_types.includes(sel.type) ? [
        h("label.muted", { style: { fontSize: ".8rem" } }, "Zone"),
        h("select", { style: { width: "100%" }, onchange: (e) => ctx.patchDevice(sel.id, { zone_id: e.target.value ? Number(e.target.value) : null }) },
          h("option", { value: "" }, "— Not zoned —"),
          (data.zones || []).filter((z) => z.sheet_id === sheet.id).map((z) => h("option", { value: z.id, selected: z.id === sel.zone_id }, `${z.code} ${z.name}`))),
      ] : null,
      h("label.muted", { style: { fontSize: ".8rem" } }, "Note"),
      h("input", { style: { width: "100%" }, value: sel.note || "", onchange: (e) => ctx.patchDevice(sel.id, { note: e.target.value }) }),
      h("div.row", { style: { marginTop: "10px" } },
        sel.status === "pending" ? h("button.primary", { onclick: () => ctx.patchDevice(sel.id, { status: "confirmed" }) }, "Confirm (Enter)") : null,
        h("button.danger", { onclick: async () => { await deleteDevice(ctx, sel); ui.selected = null; ctx.refreshSystem(); } }, "Delete (Del)")),
    ));
  }

  // --- selected panel / riser ---
  const selEq = (data.equipment || []).find((e) => e.id === ui.selectedEquip && e.sheet_id === sheet.id);
  if (selEq) {
    const panelsOf = (kinds) => (data.equipment || []).filter((e) => kinds.includes(e.kind));
    const save = async (body) => { await patchEquip(data, selEq.id, body); ctx.refreshSystem(); };
    out.push(h("div.section.card", { style: { padding: "12px" } },
      h("div.row", h("span.swatch", { style: { background: EQUIP_COLOR[selEq.kind], borderRadius: "2px" } }), h("strong.grow", EQUIP_LABEL[selEq.kind]),
        selEq.source === "ai" ? h("span.badge.pending", "Found by Claude") : null),
      h("label.muted", { style: { fontSize: ".8rem" } }, "Name"),
      h("input", { style: { width: "100%" }, value: selEq.name, onchange: (e) => save({ name: e.target.value }) }),
      selEq.kind === "riser" ? [
        h("label.muted", { style: { fontSize: ".8rem" } }, "Carries home runs to"),
        h("select", { style: { width: "100%" }, onchange: (e) => save({ serves: e.target.value }) },
          [["both", "Electrical and lighting panels"], ["elec", "Electrical panel only"], ["dpm", "Lighting (PD8) panel only"]].map(([v, l]) => h("option", { value: v, selected: selEq.serves === v }, l))),
        h("label.muted", { style: { fontSize: ".8rem" } }, "Leads to panel"),
        h("select", { style: { width: "100%" }, onchange: (e) => save({ target_id: e.target.value ? Number(e.target.value) : null }) },
          h("option", { value: "" }, "— the only panel of that type —"),
          panelsOf(["elec_panel", "dpm_panel"]).map((p) => h("option", { value: p.id, selected: selEq.target_id === p.id }, `${p.name} (${data.sheets.find((s) => s.id === p.sheet_id)?.sheet_no || ""})`))),
        h("label.muted", { style: { fontSize: ".8rem" } }, "Feet from this riser to that panel (vertical + run on the other floor)"),
        h("input", { type: "number", min: 0, style: { width: "100%" }, value: selEq.extra_ft || 0, onchange: (e) => save({ extra_ft: Number(e.target.value) }) }),
      ] : h("p.muted", { style: { fontSize: ".8rem" } }, {
        elec_panel: "Power and lighting circuit home runs on this sheet are measured to here.",
        dpm_panel: "Zone home runs and Ketra/DALI circuits on this sheet are measured to here.",
        backup: "Its feeder is measured from here to the nearest electrical panel (or a riser). Its exact spot usually isn't on the drawings, so place it where you expect it.",
      }[selEq.kind]),
      h("div.row", { style: { marginTop: "10px" } },
        selEq.source === "ai" ? h("button.primary", { onclick: () => save({}) }, "Confirm location") : null,
        h("button.danger", { onclick: async () => { await deleteEquip(ctx, selEq); ui.selectedEquip = null; ctx.refreshSystem(); } }, "Delete (Del)")),
    ));
  }

  // --- panels & risers (place before analysis so home runs are measured) ---
  const eqHere = (data.equipment || []).filter((e) => e.sheet_id === sheet.id);
  const has = (kind) => eqHere.some((e) => e.kind === kind || (e.kind === "riser" && (e.serves === "both" || e.serves === (kind === "elec_panel" ? "elec" : "dpm"))));
  out.push(h("div.section",
    h("h3", "Panels & risers"),
    h("p.muted", { style: { fontSize: ".78rem", margin: "0 0 6px" } }, "Place these before analysing. Home runs are measured from each zone or circuit to the panel (or a riser that leads to it on another floor)."),
    h("div.row", { style: { gap: "4px" } },
      Object.entries(EQUIP_LABEL).map(([k, l]) => h("button.small" + (ui.placeEquip === k ? ".primary" : ""), {
        onclick: () => { ui.placeEquip = ui.placeEquip === k ? null : k; ui.placeType = null; ui.activeZone = null; ctx.rerender(); },
      }, h("span.swatch", { style: { background: EQUIP_COLOR[k], borderRadius: "2px", display: "inline-block", marginRight: "4px" } }), l.replace(" / chase to another floor", "").replace(" (Powerwall / generator)", "")))),
    h("div", { style: { fontSize: ".8rem", marginTop: "6px" } },
      h("div", has("elec_panel") ? "✓ Electrical panel / riser on this sheet" : h("span", { style: { color: "var(--warn)" } }, "• No electrical panel or riser: circuit home runs use the default length")),
      h("div", has("dpm_panel") ? "✓ Lighting panel / riser on this sheet" : h("span", { style: { color: "var(--warn)" } }, "• No lighting panel or riser: zone home runs use the default length"))),
    eqHere.length ? h("div", { style: { marginTop: "6px" } }, eqHere.map((e) => h("div.typecount", { onclick: () => { ui.selectedEquip = e.id; ui.selected = null; ctx.rerender(); } },
      h("span.row", { style: { gap: "6px" } }, h("span.swatch", { style: { background: EQUIP_COLOR[e.kind], borderRadius: "2px" } }), e.name),
      e.source === "ai" ? h("span.badge.pending", "check") : null))) : null,
  ));

  // --- AI analysis ---
  const a = sheet.analysis;
  const pending = devices.filter((d) => d.status === "pending").length;
  out.push(h("div.section",
    h("h3", "Claude analysis"),
    !ctx.meta.has_api_key ? h("div.warn", "Add your Anthropic API key to the server's .env file to enable plan analysis.") : null,
    h("div.row",
      h("button.primary", { disabled: !!ui.busy || !ctx.meta.has_api_key, onclick: () => runAnalysis(sheet, data, ctx) },
        a ? "Re-analyze sheet" : "Analyze with Claude"),
      pending ? h("button", { onclick: async () => { await api(`/api/sheets/${sheet.id}/confirm-all`, { method: "POST" }); await ctx.reload(); } }, `Confirm all ${pending}`) : null),
    ui.busy ? h("div.progress", { style: { marginTop: "8px" } }, ui.busy) : null,
    a ? h("p.muted", { style: { fontSize: ".8rem" } },
      `${a.device_count} devices found · ${money(a.usage?.cost_usd)} API cost · ${new Date(sheet.analyzed_at + "Z").toLocaleString()}`) :
      h("p.muted", { style: { fontSize: ".8rem" } }, "Claude reads the legend and room labels, then marks every device. Re-analyzing replaces AI markers on this sheet; markers you added by hand are kept."),
    a?.notes?.length ? h("details", h("summary", `Plan notes (${a.notes.length})`), h("ul.notes", a.notes.map((n) => h("li", n)))) : null,
    a?.legend?.length ? h("details", h("summary", `Legend read (${a.legend.length})`), h("ul.notes", a.legend.map((l) => h("li", `${l.meaning} → ${typeMap[l.device_type]?.label || l.device_type}`)))) : null,
  ));

  // --- code check ---
  out.push(buildCodeCheck(sheet, data, ctx));

  // --- LED tape ---
  out.push(buildTape(sheet, data, ctx));

  // --- zones ---
  out.push(buildZones(sheet, devices, data, ctx));

  // --- counts on this sheet ---
  const counts = {};
  for (const d of devices) counts[d.type] = (counts[d.type] || 0) + 1;
  out.push(h("div.section",
    h("h3", `On this sheet (${devices.length})`),
    devices.length ? types.filter((t) => counts[t.key]).map((t) =>
      h("div.typecount" + (ui.hidden.has(t.key) ? ".hidden" : ""), {
        title: "Click to show/hide", onclick: () => { ui.hidden.has(t.key) ? ui.hidden.delete(t.key) : ui.hidden.add(t.key); ctx.rerender(); },
      }, h("span.row", { style: { gap: "6px" } }, h("span.swatch", { style: { background: t.color } }), t.label), h("strong", counts[t.key]))
    ) : h("p.muted", "No devices yet."),
  ));

  out.push(buildCatalogPanel(sheet, devices, types, ctx));
  // --- palette ---
  out.push(h("div.section",
    h("h3", "Add devices by hand"),
    h("div.palette", types.map((t) => h("button" + (ui.placeType === t.key ? ".active" : ""), {
      title: t.label, onclick: () => { ui.placeType = ui.placeType === t.key ? null : t.key; ui.placeItem = null; ui.selected = null; ctx.rerender(); },
    }, h("span.swatch", { style: { background: t.color } }), t.label))),
  ));

  // --- sheet info ---
  const field = (label, key, el) => h("label.muted", { style: { display: "block", fontSize: ".8rem", marginBottom: "6px" } }, label, el);
  out.push(h("div.section",
    h("h3", "Sheet info"),
    field("Sheet no.", "sheet_no", h("input", { style: { width: "100%" }, value: sheet.sheet_no, onchange: (e) => ctx.patchSheet(sheet.id, { sheet_no: e.target.value }) })),
    field("Title", "title", h("input", { style: { width: "100%" }, value: sheet.title, onchange: (e) => ctx.patchSheet(sheet.id, { title: e.target.value }) })),
    field("Level / area (room tree group)", "level", h("input", { style: { width: "100%" }, value: sheet.level, onchange: (e) => ctx.patchSheet(sheet.id, { level: e.target.value }) })),
    field("Sheet type", "kind", h("select", { style: { width: "100%" }, onchange: (e) => ctx.patchSheet(sheet.id, { kind: e.target.value }) },
      [["electrical", "Electrical / lighting plan"], ["floor", "Floor plan"], ["other", "Other"], ...(sheet.kind === "superseded" ? [["superseded", "Replaced (older revision)"]] : [])].map(([v, l]) => h("option", { value: v, selected: sheet.kind === v }, l)))),
    compareWithSelect(sheet, data),
  ));
  return out;
}

// ======================================================================
function buildZones(sheet, devices, data, ctx) {
  const zones = (data.zones || []).filter((z) => z.sheet_id === sheet.id)
    .sort((a, b) => (a.code || "").replace(/^[KD]/, "").localeCompare((b.code || "").replace(/^[KD]/, ""), undefined, { numeric: true }));
  const zc = zoneColors(data.zones || []);
  const lights = devices.filter((d) => ctx.meta.fixture_types.includes(d.type));
  const unzoned = lights.filter((d) => !d.zone_id).length;
  const rules = ctx.lightingRules;
  const counts = new Map(zones.map((z) => [z.id, lights.filter((d) => d.zone_id === z.id).length]));

  const newZone = async () => {
    const z = await api(`/api/jobs/${data.job.id}/zones`, { json: { sheet_id: sheet.id, name: `Zone ${zones.length + 1}`, control: rules?.default_zone_control || "dpm" } });
    data.zones.push(z);
    ui.zoneMode = true; ui.activeZone = z.id; ui.selected = null;
    ctx.rerender();
  };
  const autoZone = async () => {
    if (zones.some((z) => z.source === "ai") && !confirm("Replace the zones Claude made on this sheet? Zones you created by hand are kept.")) return;
    ui.busy = "Claude is grouping the lights into zones…"; ctx.rerender();
    try {
      const r = await api(`/api/sheets/${sheet.id}/auto-zone`, { method: "POST" });
      toast(`Claude made ${r.zones} zones covering ${r.zoned} lights${r.unzoned ? `; ${r.unzoned} left unzoned` : ""} (${money(r.usage.cost_usd)}).`);
      ui.zoneMode = true;
    } catch (e) { toast(e.message, true); }
    ui.busy = null;
    await ctx.reload();
  };

  return h("div.section",
    h("h3", `Lighting zones (${zones.length})`),
    rules?.zoning_required && unzoned ? h("div.warn", `${unzoned} light${unzoned === 1 ? "" : "s"} not zoned. The DPM count needs every light in a zone.`) : null,
    !rules?.zoning_required && !zones.length ? h("p.muted", { style: { fontSize: ".8rem" } }, "Zoning is optional with this job's lighting spec, but it is required for panelized (DPM) systems.") : null,
    h("div.row",
      h("button.primary", { disabled: !!ui.busy || !ctx.meta.has_api_key || !lights.length, onclick: autoZone }, "Auto-zone with Claude"),
      h("button", { onclick: newZone }, "+ New zone")),
    h("button.small", { style: { marginTop: "4px" }, disabled: !!ui.busy || !ctx.meta.has_api_key || !lights.length, title: "Claude re-checks which room each device is in (by the walls), then re-zones the sheet",
      onclick: async () => {
        try {
          ui.busy = "Rendering sheet…"; ctx.rerender();
          const overview = await sheetOverview(sheet);
          ui.busy = "Claude is checking which room each device is in…"; ctx.rerender();
          const r = await api(`/api/sheets/${sheet.id}/assign-rooms`, { json: { overview } });
          ui.busy = "Claude is re-zoning the lights…"; ctx.rerender();
          const z = await api(`/api/sheets/${sheet.id}/auto-zone`, { method: "POST" });
          toast(`${r.moved} device${r.moved === 1 ? "" : "s"} moved to the right room; ${z.zones} zones (${money(r.usage.cost_usd + z.usage.cost_usd)}).`);
        } catch (e) { toast(e.message, true); }
        ui.busy = null; await ctx.reload();
      } }, "Fix rooms & re-zone"),
    h("p.muted", { style: { fontSize: ".78rem" } }, unzoned ? `${unzoned} of ${lights.length} lights unzoned. ` : lights.length ? "All lights zoned. " : "", "Click “Assign” then click lights on the plan to add/remove them."),
    zones.map((z) => h("div", { style: { borderLeft: `4px solid ${zc.get(z.id)}`, padding: "4px 6px", marginBottom: "4px", background: z.id === ui.activeZone ? "#fef9c3" : "transparent", borderRadius: "4px" } },
      h("div.row", { style: { gap: "4px" } },
        h("strong", { style: { fontSize: ".85rem", color: zc.get(z.id), minWidth: "54px" } }, z.code || "—"),
        h("input", { value: z.name, style: { flex: 1, minWidth: "90px", fontSize: ".85rem" }, onchange: (e) => patchZone(z, { name: e.target.value }) }),
        h("span.badge", `${counts.get(z.id)} lights`)),
      h("div.row", { style: { gap: "4px", marginTop: "3px" } },
        h("select", { style: { fontSize: ".8rem" }, onchange: (e) => patchZone(z, { control: e.target.value }) },
          Object.entries(ZONE_CONTROL).map(([k, l]) => h("option", { value: k, selected: z.control === k }, l))),
        h("label", { style: { fontSize: ".75rem", whiteSpace: "nowrap" }, title: "Exterior lights on one wall face: one zone even across rooms" },
          h("input", { type: "checkbox", checked: !!z.exterior, onchange: (e) => patchZone(z, { exterior: e.target.checked }) }), " Exterior"),
        h("button.small" + (z.id === ui.activeZone ? ".primary" : ""), { onclick: () => { ui.activeZone = ui.activeZone === z.id ? null : z.id; ui.zoneMode = true; ui.selected = null; ctx.rerender(); } }, z.id === ui.activeZone ? "Done" : "Assign"),
        h("button.small.danger", { title: "Delete zone (lights become unzoned)", onclick: async () => {
          await api(`/api/zones/${z.id}`, { method: "DELETE" });
          if (ui.activeZone === z.id) ui.activeZone = null;
          await ctx.reload();
        } }, "✕")),
      z.note ? h("div.muted", { style: { fontSize: ".72rem", marginTop: "2px" } }, z.note) : null)),
  );

  async function patchZone(z, body) {
    try {
      const nz = await api(`/api/zones/${z.id}`, { method: "PATCH", json: body });
      data.zones = data.zones.map((x) => (x.id === z.id ? nz : x));
      if (body.control || body.exterior !== undefined) return ctx.reload(); // codes (K/D prefixes, EXT) are renumbered on the server
      ctx.rerender();
    } catch (e) { toast(e.message, true); }
  }
}

// ======================================================================
// Render the sheet in the browser and send Claude an overview + high-res tiles.
async function runAnalysis(sheet, data, ctx) {
  try {
    const res = await analyzeSheetInBrowser(sheet, (msg) => { ui.busy = msg; ctx.rerender(); });
    let zoned = "";
    if (ctx.lightingAutoZone && res.devices) { // Lutron spec: zone the lights in the same review (Tony, TO12)
      ui.busy = "Claude is grouping the lights into zones…"; ctx.rerender();
      const z = await api(`/api/sheets/${sheet.id}/auto-zone`, { method: "POST" }).catch((e) => ({ error: e.message }));
      if (z.error) zoned = ` Zoning didn't run (${z.error}).`;
      else { zoned = `, ${z.zones} lighting zones`; res.usage.cost_usd = +(res.usage.cost_usd + z.usage.cost_usd).toFixed(2); ui.zoneMode = true; }
    }
    toast(`Found ${res.rooms} rooms and ${res.devices} devices${zoned.startsWith(",") ? zoned : ""} (${money(res.usage.cost_usd)} API cost). Check the dashed markers.${zoned.startsWith(" ") ? zoned : ""}`);
  } catch (e) {
    toast(e.message, true);
  }
  ui.busy = null; ui.selected = null;
  await ctx.reload();
}

/** Whole-sheet image within Claude's 2576px / 3.75MP limit. */
export async function sheetOverview(sheet) {
  const doc = await loadPdf(sheet.plan_id);
  const page = await doc.getPage(sheet.page);
  const W = sheet.width, H = sheet.height;
  const scale = Math.min(2500 / Math.max(W, H), Math.sqrt(3.7e6 / (W * H)));
  const vp = page.getViewport({ scale });
  const c = document.createElement("canvas");
  c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
  await page.render({ canvas: c, viewport: vp }).promise;
  return { png: canvasToB64(c), w: c.width, h: c.height };
}

/** NEC / IRC check of one sheet; findings are saved on the server. */
export async function codeCheckSheet(sheet, progress = () => {}) {
  progress("Rendering sheet…");
  const overview = await sheetOverview(sheet);
  progress("Claude is checking the sheet against the NEC / IRC… (about a minute)");
  return api(`/api/sheets/${sheet.id}/code-check`, { json: { overview } });
}

/** Render a sheet (overview + 3x3 high-res tiles) and have Claude analyse it. Used by the Plans tab and project setup. */
export async function analyzeSheetInBrowser(sheet, progress = () => {}) {
  {
    progress("Rendering sheet…");
    const doc = await loadPdf(sheet.plan_id);
    const page = await doc.getPage(sheet.page);
    const W = sheet.width, H = sheet.height;

    const textItems = (await pageText(page)).filter((t) => t.s.length <= 40).slice(0, 1500).map((t, i) => ({ i, s: t.s, x: t.x, y: t.y }));

    const renderAt = async (scale) => {
      const vp = page.getViewport({ scale });
      const c = document.createElement("canvas");
      c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      await page.render({ canvas: c, viewport: vp }).promise;
      return c;
    };

    // Overview: whole sheet within Claude's 2576px / 3.75MP image limit.
    const ovScale = Math.min(2400 / Math.max(W, H), Math.sqrt(3.6e6 / (W * H)));
    const ovCanvas = await renderAt(ovScale);
    const overview = { png: canvasToB64(ovCanvas), w: ovCanvas.width, h: ovCanvas.height };

    // Tiles: 3x3 grid with 6% overlap, each rendered near the image limit.
    const COLS = 3, ROWS = 3, OV = 0.06;
    const tw = W / COLS, th = H / ROWS;
    const tileWpt = tw * (1 + 2 * OV), tileHpt = th * (1 + 2 * OV);
    const tScale = Math.min(2500 / Math.max(tileWpt, tileHpt), Math.sqrt(3.6e6 / (tileWpt * tileHpt)));
    progress("Rendering high-resolution tiles…");
    const big = await renderAt(tScale);
    const tiles = [];
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      const x0 = Math.max(0, c * tw - OV * tw), x1 = Math.min(W, (c + 1) * tw + OV * tw);
      const y0 = Math.max(0, r * th - OV * th), y1 = Math.min(H, (r + 1) * th + OV * th);
      const tc = document.createElement("canvas");
      tc.width = Math.round((x1 - x0) * tScale); tc.height = Math.round((y1 - y0) * tScale);
      const g = tc.getContext("2d");
      g.drawImage(big, x0 * tScale, y0 * tScale, tc.width, tc.height, 0, 0, tc.width, tc.height);
      if (isBlank(tc)) continue;
      tiles.push({
        png: canvasToB64(tc), w: tc.width, h: tc.height, x0, y0, x1, y1,
        cx0: c * tw, cy0: r * th, cx1: c === COLS - 1 ? W + 1 : (c + 1) * tw, cy1: r === ROWS - 1 ? H + 1 : (r + 1) * th,
      });
    }

    progress(`Claude is reading the sheet (legend, rooms, then ${tiles.length} tiles)… this takes 1–3 minutes.`);
    const res = await api(`/api/sheets/${sheet.id}/analyze`, { json: { overview, tiles, textItems } });
    // Then put every device in the room it is really in (by the walls, not the nearest label).
    progress("Claude is checking which room each device is in…");
    const rooms = await api(`/api/sheets/${sheet.id}/assign-rooms`, { json: { overview } }).catch(() => null);
    if (rooms) res.usage.cost_usd = +(res.usage.cost_usd + rooms.usage.cost_usd).toFixed(2);
    return res;
  }
}

function isBlank(canvas) {
  const s = document.createElement("canvas"); s.width = 120; s.height = 80;
  const g = s.getContext("2d"); g.drawImage(canvas, 0, 0, 120, 80);
  const px = g.getImageData(0, 0, 120, 80).data;
  let dark = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i + 3] > 0 && (px[i] + px[i + 1] + px[i + 2]) / 3 < 220) dark++;
  return dark / (120 * 80) < 0.003;
}

// Keyboard shortcuts for the verify loop.
export function handlePlanKeys(e, ctx) {
  if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName)) return;
  if (ui.drawTape) {
    if (e.key === "Enter") { const sheet = ctx.data.sheets.find((s) => s.id === ui.sheetId); if (sheet) finishTape(ctx, sheet); }
    else if (e.key === "Backspace") { ui.drawTape.points.pop(); ctx.rerender(); }
    else if (e.key === "Escape") { ui.drawTape = null; ctx.rerender(); }
    e.preventDefault();
    return;
  }
  const isDelete = e.key === "Delete" || e.key === "Backspace";
  if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) { e.preventDefault(); undoLast(ctx); }
  else if (e.key === "Escape") { ui.placeType = null; ui.placeItem = null; ui.placeEquip = null; ui.selected = null; ui.selectedEquip = null; ui.selectedTape = null; ui.activeZone = null; ctx.rerender(); }
  else if (isDelete && ui.selected) {
    // Delete removes whatever is selected; Ctrl+Z / Undo brings it back.
    e.preventDefault();
    const d = ctx.data.devices.find((x) => x.id === ui.selected);
    if (d) deleteDevice(ctx, d).then(() => { ui.selected = null; ctx.refreshSystem(); }).catch((err) => toast(err.message, true));
  } else if (isDelete && ui.selectedEquip) {
    e.preventDefault();
    const eq = ctx.data.equipment.find((x) => x.id === ui.selectedEquip);
    if (eq) deleteEquip(ctx, eq).then(() => { ui.selectedEquip = null; ctx.refreshSystem(); }).catch((err) => toast(err.message, true));
  } else if (isDelete && ui.selectedTape) {
    e.preventDefault();
    const t = (ctx.data.tape_runs || []).find((x) => x.id === ui.selectedTape);
    if (t) deleteTape(ctx, t).then(() => { ui.selectedTape = null; return ctx.reload(); }).catch((err) => toast(err.message, true));
  } else if (ui.selected && e.key === "Enter") {
    ctx.patchDevice(ui.selected, { status: "confirmed" });
  } else if (e.key === "n" || e.key === "N") {
    [...document.querySelectorAll(".toolbar button")].find((b) => b.textContent.startsWith("Next"))?.click();
  }
}

export function focusSheet(sheetId) { ui.sheetId = sheetId; ui.zoom = null; ui.selected = null; }
