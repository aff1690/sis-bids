// Spec library (global) and the job Specs tab.
import { api, h, toast, money, num, clickOff } from "./lib.js";
import { fixtureScheduleCard } from "./fixtures.js";

/** Ketra / DALI-2 choice (Tony, 2026-11-09): recessed types only, one control per type. Saves ketra_types and dali_types. */
export const KD_TYPES = ["recessed", "recessed_directional", "recessed_wet"];
export function kdChooser(js, meta, save) {
  const mixed = (js.kd_mixed || []).filter((t) => KD_TYPES.includes(t));
  const ketra = (js.ketra_types || []).filter((t) => KD_TYPES.includes(t) && !mixed.includes(t)), dali = (js.dali_types || []).filter((t) => KD_TYPES.includes(t) && !ketra.includes(t) && !mixed.includes(t));
  const put = (list, k, on) => (on ? [...list.filter((x) => x !== k), k] : list.filter((x) => x !== k));
  const set = (k, v) => save({ ketra_types: put(ketra, k, v === "ketra"), dali_types: put(dali, k, v === "dali"), kd_mixed: put(mixed, k, v === "both") });
  return h("div", { style: { display: "grid", gridTemplateColumns: "max-content max-content", gap: "6px 14px", alignItems: "center", marginTop: "6px" } },
    KD_TYPES.map((k) => {
      const cur = mixed.includes(k) ? "both" : ketra.includes(k) ? "ketra" : dali.includes(k) ? "dali" : "std";
      return [h("strong", { style: { fontSize: ".85rem" } }, meta.device_types.find((t) => t.key === k)?.label || k),
        h("div.row", { style: { gap: "12px" } }, [["std", "Standard (DPM)"], ["ketra", "Ketra"], ["dali", "DALI-2"], ["both", "Both (from the legend)"]].map(([v, l]) =>
          h("label", { style: { fontSize: ".85rem" } }, h("input", { type: "radio", name: "kd-" + k, checked: cur === v, onchange: () => set(k, v) }), " ", l)))];
    }),
    h("p.muted", { style: { gridColumn: "1 / -1", fontSize: ".8rem", margin: "4px 0 0" } }, "Both: the job has Ketra and DALI-2 fixtures of that type. Claude decides each fixture from the fixture schedule or legend and zones them separately. Any zone can also be switched between Ketra and DALI-2 by hand on Plans › Zones."));
}

const CONTROL_LABEL = { standard: "Standard switching", rf: "RF system", panelized: "Panelized (DPM)" };
const ZONE_CONTROL_LABEL = { dpm: "Wired to DPM", dali: "DALI-2", ketra: "Ketra / RF fixtures", lumaris: "Lumaris tape (wireless)", wall: "Wall switch / dimmer" };
const CATEGORY_LABEL = { devices: "Wiring devices", lighting: "Lighting control", panels: "Electrical panels", tape: "LED tape", backup: "Backup power" };
export { CATEGORY_LABEL };
export { ZONE_CONTROL_LABEL };

// ---------------------------------------------------------------- reusable line editor
/** Editable list of assembly/spec lines with catalog picker. `bases` adds a "per" column for system items. */
export function lineEditor(items, { bases = null, onChange = () => {} } = {}) {
  const root = h("div");
  const picker = clickOff(h("dialog"));
  const pick = (idx) => {
    const list = h("div.table-wrap", { style: { maxHeight: "50vh" } });
    const q = h("input", { placeholder: "Search catalog (part #, model, manufacturer)…", style: { width: "100%" } });
    const run = async () => {
      const res = await api(`/api/catalog?limit=60&q=${encodeURIComponent(q.value)}`);
      list.replaceChildren(h("table", res.map((c) => h("tr.clickable", { onclick: () => {
        const perFoot = /\(ft\)/i.test(items[idx].description || "");
        Object.assign(items[idx], { catalog_id: c.id, catalog: c, description: `${c.manufacturer} ${c.model}${perFoot ? " (ft)" : ""}`, unit_cost: c.unit_cost, labor_hours: null });
        picker.close(); draw(); onChange();
      } }, h("td", c.part_number), h("td", c.manufacturer), h("td", c.model), h("td.num", money(c.unit_cost)), h("td.num", num(c.labor_hours, 2))))));
    };
    let tm; q.addEventListener("input", () => { clearTimeout(tm); tm = setTimeout(run, 250); });
    picker.replaceChildren(h("h2", "Pick a catalog item"), q, list, h("div.row", { style: { justifyContent: "flex-end", marginTop: "10px" } }, h("button", { onclick: () => picker.close() }, "Close")));
    q.value = (items[idx].catalog?.part_number || items[idx].description || "").replace(/\(.*?\)/g, "").split(" ").slice(0, 3).join(" ");
    picker.showModal(); run();
  };
  function draw() {
    root.replaceChildren(
      h("table",
        h("tr", h("th", "Item"), h("th.num", "Qty"), bases ? h("th", "Per") : null, h("th.num", "Unit cost"), h("th.num", "Labor hrs/unit"), h("th", "Phase"), h("th", "")),
        items.map((it, i) => h("tr",
          h("td",
            it.catalog ? h("div", h("strong", `${it.catalog.manufacturer} ${it.catalog.model}`), h("div.muted", { style: { fontSize: ".8rem" } }, it.catalog.part_number || ""))
              : h("input", { value: it.description, style: { width: "100%" }, onchange: (e) => { it.description = e.target.value; onChange(); } }),
            h("div.row", { style: { gap: "4px", marginTop: "4px" } },
              h("button.small", { onclick: () => pick(i) }, it.catalog ? "Change part" : "Link catalog part"),
              it.catalog ? h("button.small", { onclick: () => { it.description = `${it.catalog.manufacturer} ${it.catalog.model}`; it.catalog = null; it.catalog_id = null; draw(); onChange(); } }, "Unlink") : null)),
          h("td.num", h("input", { type: "number", step: "any", value: it.qty, style: { width: "72px" }, onchange: (e) => { it.qty = Number(e.target.value); onChange(); } })),
          bases ? h("td", h("select", { onchange: (e) => { it.basis = e.target.value; onChange(); } },
            Object.entries(bases).map(([k, l]) => h("option", { value: k, selected: (it.basis || "job") === k }, l)))) : null,
          h("td.num", it.catalog ? money(it.catalog.unit_cost) : h("input", { type: "number", step: "any", value: it.unit_cost, style: { width: "84px" }, onchange: (e) => { it.unit_cost = Number(e.target.value); onChange(); } })),
          h("td.num", h("input", { type: "number", step: "any", value: it.labor_hours ?? "", placeholder: it.catalog ? num(it.catalog.labor_hours, 3) : "0", style: { width: "84px" }, onchange: (e) => { it.labor_hours = e.target.value === "" ? null : Number(e.target.value); onChange(); } })),
          h("td", h("select", { onchange: (e) => { it.phase = e.target.value; onChange(); } }, ["Rough", "Finish", "System"].map((p) => h("option", { selected: (it.phase || "Rough") === p }, p)))),
          h("td", h("button.small.danger", { onclick: () => { items.splice(i, 1); draw(); onChange(); } }, "✕"))))),
      h("button", { style: { marginTop: "8px" }, onclick: () => { items.push({ catalog_id: null, description: "New item", qty: 1, unit_cost: 0, labor_hours: null, phase: bases ? "System" : "Rough", ...(bases ? { basis: "job" } : {}) }); draw(); onChange(); } }, "Add line"),
    );
  }
  draw();
  return h("div", root, picker);
}

// ---------------------------------------------------------------- spec library
let currentSpecId = null;
export async function renderSpecLibrary(app, meta) {
  const specs = await api("/api/specs");
  if (!currentSpecId || !specs.some((s) => s.id === currentSpecId)) currentSpecId = specs[0]?.id;
  const spec = currentSpecId ? await api(`/api/specs/${currentSpecId}`) : null;
  const types = meta.device_types;

  const group = (cat, title) => h("div.section",
    h("h3", title),
    specs.filter((s) => s.category === cat).map((s) => h("div.sheet-item" + (s.id === currentSpecId ? ".active" : ""), { onclick: () => { currentSpecId = s.id; renderSpecLibrary(app, meta); } },
      h("span", s.name))),
    h("button.small", { onclick: async () => {
      const name = prompt(`Name for the new ${CATEGORY_LABEL[cat].toLowerCase()} spec:`);
      if (!name) return;
      const r = await api("/api/specs", { json: { name, category: cat, data: {} } });
      currentSpecId = r.id; renderSpecLibrary(app, meta);
    } }, "+ New"));

  const editor = spec ? specEditor(spec, meta, types, () => renderSpecLibrary(app, meta)) : h("p.muted", "No specs yet.");
  app.replaceChildren(h("div.page",
    h("h1", "Spec library"),
    h("p.muted", "Company standards you pick per job before the takeoff. A spec swaps the parts in each device's assembly, adds system equipment (processors, DPMs, panels), and tells Claude how to read the drawings."),
    h("div", { style: { display: "grid", gridTemplateColumns: "250px 1fr", gap: "16px", alignItems: "start" } },
      h("div.card", { style: { padding: "10px" } }, Object.entries(CATEGORY_LABEL).map(([k, l]) => group(k, l))),
      h("div.card", editor)),
  ));
}

function specEditor(spec, meta, types, reload) {
  const data = structuredClone(spec.data);
  // Work on resolved copies so catalog names show; strip `resolved/catalog` on save (server cleans).
  const overrides = Object.fromEntries(Object.entries(spec.resolved.overrides).map(([k, v]) => [k, v.map((l) => ({ ...l }))]));
  const system = spec.resolved.system_items.map((l) => ({ ...l }));
  let name = spec.name, dirty = false;
  const mark = () => { dirty = true; saveBtn.disabled = false; };
  const saveBtn = h("button.primary", { disabled: true, onclick: async () => {
    data.overrides = overrides; data.system_items = system;
    await api(`/api/specs/${spec.id}`, { method: "PUT", json: { name, data } });
    toast("Spec saved."); reload();
  } }, "Save spec");

  const r = data.rules;
  const typeChecks = (label, key, keys) => h("div", { style: { marginTop: "8px" } }, h("span.muted", label),
    keys.map((k) => h("label", { style: { marginRight: "10px", fontSize: ".85rem" } },
      h("input", { type: "checkbox", checked: (r[key] || []).includes(k), onchange: (e) => {
        r[key] = e.target.checked ? [...(r[key] || []), k] : (r[key] || []).filter((x) => x !== k); mark();
      } }), " ", types.find((t) => t.key === k)?.label)));
  const numRule =(label, key, help) => h("label", label, h("input", { type: "number", min: 1, value: r[key], onchange: (e) => { r[key] = Number(e.target.value); mark(); } }), help ? h("span.muted", { style: { fontSize: ".75rem" } }, help) : null);

  const overrideTypes = h("div");
  let openType = Object.keys(overrides)[0] || null;
  function drawOverrides() {
    overrideTypes.replaceChildren(
      h("div.row", { style: { marginBottom: "8px" } },
        h("span.muted", "Device types this spec changes:"),
        Object.keys(overrides).map((k) => h("button.small" + (k === openType ? ".primary" : ""), { onclick: () => { openType = k; drawOverrides(); } }, types.find((t) => t.key === k)?.label || k)),
        h("select", { onchange: (e) => {
          const k = e.target.value; if (!k) return;
          overrides[k] ??= [];
          openType = k; mark(); drawOverrides();
        } }, h("option", { value: "" }, "+ Add device type…"), types.filter((t) => !overrides[t.key]).map((t) => h("option", { value: t.key }, t.label)))),
      openType ? h("div",
        h("div.row", h("h3.grow", { style: { margin: "6px 0" } }, `${types.find((t) => t.key === openType)?.label}: parts used under this spec`),
          h("button.small.danger", { onclick: () => { delete overrides[openType]; openType = Object.keys(overrides)[0] || null; mark(); drawOverrides(); } }, "Use base assembly instead")),
        lineEditor(overrides[openType], { onChange: mark })) : h("p.muted", "This spec uses the base assemblies for every device type."),
    );
  }
  drawOverrides();

  return h("div",
    h("div.row", h("input", { value: name, style: { fontSize: "1.15rem", fontWeight: 600, flex: 1 }, onchange: (e) => { name = e.target.value; mark(); } }),
      h("span.badge", CATEGORY_LABEL[spec.category]),
      saveBtn,
      h("button", { onclick: async () => { const r2 = await api("/api/specs", { json: { copy_from: spec.id } }); currentSpecId = r2.id; reload(); } }, "Duplicate"),
      h("button.danger", { onclick: async () => { if (confirm(`Delete spec "${spec.name}"? Jobs using it will fall back to base assemblies.`)) { await api(`/api/specs/${spec.id}`, { method: "DELETE" }); currentSpecId = null; reload(); } } }, "Delete")),
    h("label.muted", { style: { display: "block", marginTop: "10px" } }, "Description",
      h("textarea", { rows: 2, style: { width: "100%" }, value: data.description || "", oninput: (e) => { data.description = e.target.value; mark(); } })),

    spec.category === "lighting" ? h("div.section",
      h("h3", { style: { marginTop: "14px" } }, "System rules"),
      h("div.form-grid",
        h("label", "System type", h("select", { onchange: (e) => { data.control = e.target.value; mark(); } },
          Object.entries(CONTROL_LABEL).map(([k, l]) => h("option", { value: k, selected: data.control === k }, l)))),
        h("label", "New zones default to", h("select", { onchange: (e) => { r.default_zone_control = e.target.value; mark(); } },
          Object.entries(ZONE_CONTROL_LABEL).map(([k, l]) => h("option", { value: k, selected: r.default_zone_control === k }, l)))),
        h("label", h("span", h("input", { type: "checkbox", checked: r.zoning_required, onchange: (e) => { r.zoning_required = e.target.checked; mark(); } }), " Lights must be zoned (DPM count)")),
        numRule("Zones per DPM", "zones_per_dpm"),
        numRule("Modules per PD8 panel", "dpms_per_panel"),
        numRule("Ketra/DALI circuits per PD8", "pd8_circuits_per_panel"),
        numRule("DALI-2 fixtures per module", "dali_fixtures_per_module"),
        numRule("Breaker spaces per PD8 feeder", "dpm_feeder_spaces"),
        numRule("RF devices per processor", "rf_devices_per_processor"),
        numRule("RF range (ft)", "rf_range_ft")),
      typeChecks("Device types that count as RF devices: ", "rf_device_types", meta.control_types),
      typeChecks("Loads on switching DPMs (LQSE-4S8) instead of dimming DPMs: ", "switched_types", meta.fixture_types),
      h("p.muted", { style: { fontSize: ".8rem" } }, "Fixtures in Ketra zones always count as RF devices. RF processors = the larger of (RF devices ÷ per-processor limit) and the number needed to keep every RF device within range on each sheet. PD8 panels = enough for the modules and enough distribution spots for the Ketra/DALI circuits.")) : null,

    spec.category === "tape" ? h("div.section",
      h("h3", { style: { marginTop: "14px" } }, "Tape rules"),
      h("div.form-grid",
        h("label", "Tape type", h("select", { onchange: (e) => { r.tape_type = e.target.value; mark(); } },
          [["lucetta", "Lucetta: driver on a DPM zone"], ["lumaris", "Lumaris: power interface, wireless"]].map(([v, l]) => h("option", { value: v, selected: r.tape_type === v }, l)))),
        numRule("Watts per foot", "watts_per_ft"),
        numRule("Max run per feed (ft)", "max_run_ft"),
        numRule(r.tape_type === "lumaris" ? "Power interface (W)" : "Driver size (W)", "driver_watts"),
        numRule("Driver load %", "driver_load_pct"),
        numRule("Class 2 max per output (W)", "class2_max_watts"),
        numRule("Class 2 feed per segment (ft)", "class2_feed_ft"),
        numRule("Voltage-drop limit %", "vdrop_pct"),
        numRule("Channel piece length (ft)", "channel_piece_ft")),
      h("p.muted", { style: { fontSize: ".8rem" } }, "Each run is fed again every max-run length (and sooner if a segment would exceed the Class 2 limit). Lucetta drivers are sized per zone; Lumaris power interfaces per run, each counting as an RF device on a PD8 constant-power circuit. The Class 2 feed gauge is chosen to stay within the voltage-drop limit at 24V.")) : null,

    spec.category === "backup" ? h("div.section",
      h("h3", { style: { marginTop: "14px" } }, "Feeder"),
      h("div.form-grid",
        numRule("Feeder breaker (A, 2-pole)", "feeder_breaker"),
        h("label", h("span", h("input", { type: "checkbox", checked: !!r.feeder_neutral, onchange: (e) => { r.feeder_neutral = e.target.checked; mark(); } }), " Needs a neutral")),
        h("label", h("span", h("input", { type: "checkbox", checked: !!r.feeder_disconnect, onchange: (e) => { r.feeder_disconnect = e.target.checked; mark(); } }), " Add a disconnect"))),
      h("p.muted", { style: { fontSize: ".8rem" } }, "Place each unit on the plan (Panels & risers → Backup unit). Its feeder is measured at right angles to the nearest electrical panel or riser: NM-B up to 60A, aluminum SER above. Units placed = units priced.")) : null,

    spec.category === "panels" ? h("div.section",
      h("h3", { style: { marginTop: "14px" } }, "Circuit rules"),
      h("div.form-grid",
        numRule("Receptacles per 20A circuit", "receptacles_per_circuit"),
        numRule("Fixtures per 15A lighting circuit", "lights_per_circuit"),
        numRule("Breaker spaces in panel", "panel_spaces")),
      h("p.muted", { style: { fontSize: ".8rem" } }, "Circuits are packed room by room on each sheet. GFCI receptacles get their own circuits per room. Lights fed from PD8 panels (DPM, Ketra and DALI zones) are not electrical-panel circuits.")) : null,

    h("div.section",
      h("h3", { style: { marginTop: "14px" } }, "Parts by device type"),
      h("p.muted", { style: { fontSize: ".8rem" } }, "These replace the base assembly for that device type on jobs using this spec. Device types not listed use the base assembly (or the other spec)."),
      overrideTypes),

    h("div.section",
      h("h3", "System equipment"),
      h("p.muted", { style: { fontSize: ".8rem" } }, "Added once per job, per DPM, per panel, per wired zone, or per RF processor, sized from the job's zones and RF devices."),
      lineEditor(system, { bases: meta.spec_bases, onChange: mark })),

    h("div.section",
      h("h3", "Instructions for Claude"),
      h("p.muted", { style: { fontSize: ".8rem" } }, "Added to Claude's instructions when it reads plans and proposes zones for jobs using this spec."),
      h("textarea", { rows: 3, style: { width: "100%" }, value: data.claude_notes || "", oninput: (e) => { data.claude_notes = e.target.value; mark(); } })),
  );
}

// ---------------------------------------------------------------- job Specs tab
export async function renderJobSpecs(app, ctx) {
  const [specs, summary] = await Promise.all([api("/api/specs"), api(`/api/jobs/${ctx.data.job.id}/specs-summary`)]);
  const js = ctx.data.job.settings.specs || {};
  const types = ctx.types;
  const save = async (patch) => {
    const next = { ...js, ...patch };
    await api(`/api/jobs/${ctx.data.job.id}`, { method: "PATCH", json: { settings: { specs: next } } });
    ctx.data.job.settings.specs = next;
    renderJobSpecs(app, ctx);
  };
  const pick = (cat, label) => {
    const list = specs.filter((s) => s.category === cat);
    const cur = list.find((s) => s.id === js[cat]);
    return h("div.card",
      h("h3", label),
      h("select", { style: { width: "100%" }, onchange: (e) => save({ [cat]: e.target.value ? Number(e.target.value) : null }) },
        h("option", { value: "" }, "— Base assemblies (no spec) —"),
        list.map((s) => h("option", { value: s.id, selected: s.id === js[cat] }, s.name))),
      cur ? h("p.muted", { style: { fontSize: ".85rem" } }, cur.data.description) : null);
  };
  const sys = summary.system;
  const fixtureTypes = ctx.meta.fixture_types;

  app.replaceChildren(h("div.page.narrow",
    h("div.row", h("h1.grow", "Job specifications"), h("a", { href: "#/specs" }, "Edit spec library →")),
    h("p.muted", "Set these before running the takeoff. They decide which parts each device uses, how lighting control is built, and what Claude is told when it reads the plans."),
    h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "12px" } },
      pick("devices", "Wiring devices"), pick("lighting", "Lighting control"), pick("panels", "Electrical panels"),
      pick("tape", "LED tape (default for new runs)"),
      h("div", pick("backup", "Backup power"),
        js.backup ? h("div.row", { style: { marginTop: "6px", fontSize: ".85rem" } },
          h("label", "Units ", h("input", { type: "number", min: 1, value: js.backup_units ?? 1, style: { width: "60px" }, onchange: (e) => save({ backup_units: Number(e.target.value) }) })),
          h("label", "Expansions ", h("input", { type: "number", min: 0, value: js.backup_expansions ?? 0, style: { width: "60px" }, onchange: (e) => save({ backup_expansions: Number(e.target.value) }) }))) : null)),

    h("div.card.section", { style: { marginTop: "12px" } },
      h("div.row",
        h("h3.grow", { style: { margin: 0 } }, "Code editions for the code check"),
        h("label", "NEC ", h("input", { value: ctx.data.job.settings.code_nec || "2026", style: { width: "70px" },
          onchange: async (e) => { await api(`/api/jobs/${ctx.data.job.id}`, { method: "PATCH", json: { settings: { code_nec: e.target.value } } }); ctx.data.job.settings.code_nec = e.target.value; toast("Saved."); } })),
        h("label", "IRC ", h("input", { value: ctx.data.job.settings.code_irc || "2024", style: { width: "70px" },
          onchange: async (e) => { await api(`/api/jobs/${ctx.data.job.id}`, { method: "PATCH", json: { settings: { code_irc: e.target.value } } }); ctx.data.job.settings.code_irc = e.target.value; toast("Saved."); } }))),
      h("p.muted", { style: { fontSize: ".8rem", margin: "4px 0 0" } }, "Defaults to the most current editions. Change them if the AHJ has adopted an earlier edition.")),

    generatorCard(ctx, js, save),

    h("div.card.section", { style: { marginTop: "12px" } },
      h("h3", "Ketra and DALI-2 fixtures"),
      h("p.muted", { style: { fontSize: ".85rem" } }, "Pick Ketra or DALI-2 for the recessed types that use it on this job (one or the other per type). Their zones get K/D codes, need constant-power circuits that land in the PD8 distribution section (4 per PD8), and Ketra fixtures count toward the RF processor limit. Recessed types left on Standard, and all other fixtures, stay wired to the DPMs."),
      kdChooser(js, ctx.meta, save)),

    fixtureScheduleCard({ jobId: ctx.data.job.id, settings: ctx.data.job.settings, plans: ctx.data.plans, meta: ctx.meta, reload: () => ctx.reload() }),

    sys.spec || sys.panel_spec ? h("div.card.section",
      h("h3", "System sizing"),
      h("div.stats",
        stat("Zones", sys.zones), stat("Dimming DPMs", sys.dpms), stat("Switching DPMs", sys.dpms_switching), stat("DALI-2 modules", sys.dali_modules),
        stat("PD8 panels", sys.panels), stat("Ketra/DALI circuits", sys.pd8_circuits), stat("RF devices", sys.rf_devices), stat("RF processors", sys.rf_processors)),
      sys.panel_spec ? h("div.stats",
        stat("20A power circuits", sys.circuits.power), stat("20A GFCI-area circuits", sys.circuits.gfci), stat("15A lighting circuits", sys.circuits.lighting), stat("240V circuits", sys.circuits.c240)) : null,
      h("p.muted", { style: { fontSize: ".8rem" } },
        `Home runs: zones ${sys.home_runs.zones_ft} ft · Ketra/DALI circuits ${sys.home_runs.pd8_ft} ft · DALI bus ${sys.home_runs.dali_bus_ft} ft · PD8 feeders ${sys.home_runs.feeder_ft} ft`
        + (sys.panel_spec ? ` · power ${sys.home_runs.power_ft} ft · lighting ${sys.home_runs.lighting_ft} ft` : "")
        + " (before wire waste). " + (sys.rf_reason || "")),
      panelScheduleTable(sys),
      sys.warnings.map((w) => h("div.warn", w))) : null,

    h("div.card.section",
      h("h3", "Parts each device will use"),
      h("table", h("tr", h("th", "Device"), h("th", "From"), h("th", "Parts")),
        types.filter((t) => summary.assemblies[t.key]).map((t) => {
          const a = summary.assemblies[t.key];
          return h("tr", h("td", h("span.row", { style: { gap: "6px" } }, h("span.swatch", { style: { background: t.color } }), t.label)),
            h("td", a.source === "Base assembly" ? h("span.muted", "Base") : h("span.badge.ai", a.source)),
            h("td.muted", { style: { fontSize: ".8rem" } }, a.lines.map((l) => `${l.qty} × ${l.part_number || l.description}`).join(" · ")));
        }))),
  ));
}

const stat = (l, v) => h("div.card.stat", h("div.v", num(v, 0)), h("div.l", l));

/** Circuits landing in each panel, with space / slot checks. */
export function panelScheduleTable(sys) {
  if (!sys.panel_schedule?.length) return null;
  const over = (n, cap) => (cap && n > cap ? { color: "var(--bad)", fontWeight: 700 } : {});
  return h("div", { style: { marginTop: "8px" } },
    h("h3", { style: { margin: "6px 0" } }, "Circuits per panel"),
    h("table",
      h("tr", h("th", "Panel"), h("th", "Sheet"), h("th.num", "Power"), h("th.num", "GFCI"), h("th.num", "Lighting"), h("th.num", "Life safety"), h("th.num", "240V / equip"), h("th.num", "PD8 feeds"),
        h("th.num", "Spaces"), h("th.num", "DPM zones"), h("th.num", "Modules"), h("th.num", "Ketra/DALI ckts")),
      sys.panel_schedule.map((p) => p.kind === "elec_panel"
        ? h("tr", h("td", p.name), h("td.muted", p.sheet), h("td.num", p.power), h("td.num", p.gfci), h("td.num", p.lighting), h("td.num", p.safety || 0),
          h("td.num", `${p.c240}${p.dedicated ? ` + ${p.dedicated} sp` : ""}`), h("td.num", p.feeders),
          h("td.num", { style: over(p.spaces, p.capacity) }, `${p.spaces}${p.capacity ? ` / ${p.capacity}` : ""}`), h("td"), h("td"), h("td"))
        : h("tr", h("td", p.name), h("td.muted", p.sheet), h("td"), h("td"), h("td"), h("td"), h("td"), h("td"), h("td"),
          h("td.num", p.dim_zones + p.switched_zones + (p.dali_fixtures ? ` (+${p.dali_fixtures} DALI fixtures)` : "")),
          h("td.num", { style: over(p.modules, p.module_capacity) }, `${p.modules} / ${p.module_capacity}`),
          h("td.num", { style: over(p.pd8_circuits, p.pd8_capacity) }, `${p.pd8_circuits} / ${p.pd8_capacity}`)))));
}

/** Generator check: free text scan of every sheet, plus anything Claude reported while analysing. */
function generatorCard(ctx, js, save) {
  const gen = ctx.data.job.settings.generator || {};
  const hits = gen.hits || [];
  const panelSpecName = ctx.data.job.settings.specs?.panels ? "" : "none chosen";
  const scan = async () => {
    const { loadPdf, pageText } = await import("./lib.js");
    toast("Scanning every sheet for generator notes…");
    const found = hits.filter((x) => x.source === "claude");
    const re = /\b(GENERATOR|GEN\.?\s*SET|STANDBY\s+(POWER|GEN)|TRANSFER\s+SWITCH|ATS)\b/i;
    for (const plan of ctx.data.plans) {
      const doc = await loadPdf(plan.id);
      for (let p = 1; p <= doc.numPages; p++) {
        const items = await pageText(await doc.getPage(p));
        const hit = items.find((t) => re.test(t.s));
        if (hit) {
          const sh = ctx.data.sheets.find((s) => s.plan_id === plan.id && s.page === p);
          found.push({ sheet: sh?.sheet_no || `p${p}`, text: hit.s.slice(0, 200), source: "scan" });
        }
      }
    }
    await api(`/api/jobs/${ctx.data.job.id}`, { method: "PATCH", json: { settings: { generator: { checked_at: new Date().toISOString(), hits: found } } } });
    ctx.data.job.settings.generator = { checked_at: new Date().toISOString(), hits: found };
    toast(found.length ? `Generator mentioned on ${[...new Set(found.map((f) => f.sheet))].join(", ")}.` : "No generator notes found in the plan text.");
    renderJobSpecs(document.getElementById("app"), ctx);
  };
  return h("div.card.section", { style: { marginTop: "12px" } },
    h("div.row", h("h3.grow", { style: { margin: 0 } }, "Generator"),
      h("button.small", { onclick: scan, disabled: !ctx.data.plans.length }, gen.checked_at ? "Re-scan plans" : "Scan plans for generator")),
    hits.length ? [
      h("div.warn", { style: { marginTop: "8px" } }, h("strong", "Generator indicated. "), "Company default is a SPAN or Leviton smart panel.", panelSpecName ? ` (Panel spec: ${panelSpecName}.)` : ""),
      h("ul.notes", hits.slice(0, 6).map((x) => h("li", h("strong", x.sheet), ` ${x.source === "claude" ? "(Claude)" : "(text)"}: “${x.text}”`))),
    ] : h("p.muted", { style: { fontSize: ".85rem" } }, gen.checked_at ? "No generator notes found in the plan text. Claude also reports generators when it analyses a sheet." : "Scan the plan text for generator, standby power or transfer-switch notes. Claude also reports them when it analyses a sheet."),
  );
}
