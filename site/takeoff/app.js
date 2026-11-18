import { api, apiUrl, h, toast, money, num, clickOff, autoZonesWith, bidChannel } from "./lib.js";
import { renderPlans, handlePlanKeys, focusSheet } from "./plans.js";
import { renderSpecLibrary, renderJobSpecs, ZONE_CONTROL_LABEL, panelScheduleTable } from "./specs.js";
import { renderEquipment } from "./equipment.js";
import { renderSetup } from "./setup.js";
import { renderCompare } from "./revisions.js";

const app = document.getElementById("app");
let meta = null;
let jobCtx = null;

async function route() {
  if (!meta) { meta = await api("/api/meta"); showMe(meta); }
  const [, section, id, tab = "plans"] = location.hash.replace(/^#\/?/, "#/").split("/");
  document.querySelectorAll("[data-global]").forEach((a) => a.classList.toggle("active", a.dataset.global === (section || "jobs")));
  const nav = document.getElementById("jobnav");
  try {
    if (section === "job" && id) {
      if (!jobCtx || jobCtx.id !== Number(id)) jobCtx = await makeJobCtx(Number(id));
      else jobCtx.data = await api(`/api/jobs/${id}`); // fresh data on every tab switch (other estimators may have edited)
      await loadLightingRules(jobCtx);
      if (tab === "plans") await loadSystem(jobCtx);
      nav.hidden = false;
      document.getElementById("jobname").textContent = jobCtx.data.job.name;
      nav.querySelectorAll("[data-tab]").forEach((a) => { a.href = `#/job/${id}/${a.dataset.tab}`; a.classList.toggle("active", a.dataset.tab === tab); });
      if (tab === "compare") { // #/job/:id/compare/:newSheet/:oldSheet (drawing revisions)
        const [, , , , nId, oId] = location.hash.replace(/^#\/?/, "#/").split("/");
        nav.querySelectorAll("[data-tab]").forEach((a) => a.classList.toggle("active", a.dataset.tab === "plans"));
        jobCtx.tab = "compare"; jobCtx.focusNew = (sid) => focusSheet(sid);
        return renderCompare(app, jobCtx, Number(nId), Number(oId));
      }
      jobCtx.tab = tab;
      jobCtx.rerender();
      return;
    }
    nav.hidden = true; jobCtx = null;
    if (section === "catalog" || section === "assemblies") { location.hash = "#/"; return; } // the bid catalog and packages replace these
    if (section === "specs") return renderSpecLibrary(app, meta);
    if (section === "new") return renderSetup(app, meta, id ? Number(id) : null);
    return renderJobs();
  } catch (e) { toast(e.message, true); }
}
window.addEventListener("hashchange", route);
// SIS Bids: the bid page changed something this takeoff shows (a room renamed there): reload, unless a dialog is open
bidChannel.addEventListener("message", (e) => {
  const m = e.data || {}; if (m.t !== "bid" || !jobCtx || m.takeoff !== jobCtx.id || document.querySelector("dialog[open]")) return;
  jobCtx.reload().catch(() => {});
});
// the bid page opens this window with ?bid=<id>: the header button goes back to that bid
{ const b = new URLSearchParams(location.search).get("bid"); if (b && /^\d+$/.test(b)) { const a = document.getElementById("tobid"); a.href = "/#/bids/" + b; a.textContent = "← Bid"; } }

/** On the SIS Tools site: your name and access in the header (with Sign out), and a note when you can only view. */
function showMe(m) {
  if (!m.me) return;
  const mid = document.querySelector(".sis-hdr-mid");
  mid.prepend(h("span.sis-me", m.me.name || m.me.email, m.level !== "edit" ? h("span.sis-role.viewer", "View only") : null));
  if (!mid.querySelector(".sis-out")) mid.append(h("a.sis-out", { href: "/cdn-cgi/access/logout" }, "Sign out"));
}
document.addEventListener("keydown", (e) => { if (jobCtx?.tab === "plans") handlePlanKeys(e, jobCtx); });

// ---------------------------------------------------------------- jobs list
async function renderJobs() {
  const jobs = await api("/api/jobs");
  app.replaceChildren(h("div.page.narrow",
    h("h1", "Jobs"),
    h("div.card.section", h("p.muted", "Each takeoff belongs to a bid. Open a bid in ", h("a", { href: "/#/bids" }, "SIS Bids"), " and click Takeoff to start one or pop it out.")),
    jobs.length ? h("div.jobs", jobs.map((j) => h("div.card.job-card", { onclick: () => (location.hash = `#/job/${j.id}/plans`) },
      h("h3", j.name), h("div.muted", j.address || "—"),
      h("div.row", { style: { marginTop: "8px" } }, h("span.badge", j.job_type === "remodel" ? "Remodel" : "New construction"), h("span.badge", `${j.device_count} devices`),
        j.claude_cost ? h("span.badge", { title: "Claude cost logged for this job" }, `Claude ${money(j.claude_cost)}`) : null,
        h("span.grow"), h("a", { href: `#/new/${j.id}`, onclick: (e) => e.stopPropagation() }, "Setup"),
        // Delete (Tony, 2026-11-09): two clicks, like the rest of SIS Tools; removes the job, its sheets, takeoff and plan PDFs
        h("button.small.danger", { style: { marginLeft: "10px" }, title: "Delete this job, its drawings and its takeoff", onclick: async (e) => {
          e.stopPropagation(); const b = e.currentTarget;
          if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Click again to delete"; setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = "Delete"; } }, 4000); return; }
          try { await api(`/api/jobs/${j.id}`, { method: "DELETE" }); toast(`Deleted ${j.name}.`); renderJobs(); } catch (err) { toast(err.message, true); }
        } }, "Delete")),
    ))) : h("p.muted", "No jobs yet."),
  ));
}

// ---------------------------------------------------------------- job context
async function makeJobCtx(id) {
  const ctx = {
    id, meta, types: meta.device_types, tab: "plans", data: await api(`/api/jobs/${id}`),
    async reload() {
      ctx.data = await api(`/api/jobs/${id}`); meta = ctx.meta = await api("/api/meta");
      await loadLightingRules(ctx);
      if (ctx.tab === "plans") await loadSystem(ctx);
      ctx.rerender();
    },
    async refreshSystem() { await loadSystem(ctx); ctx.rerender(); },
    rerender() {
      if (ctx.tab === "specs") return renderJobSpecs(app, ctx);
      if (ctx.tab === "equipment") return renderEquipment(app, ctx);
      if (ctx.tab === "rooms") return renderRooms(ctx);
      if (ctx.tab === "estimate") { location.hash = `#/job/${id}/plans`; return; } // estimates are made in the bid now
      return renderPlans(app, ctx);
    },
    async patchDevice(devId, body) {
      try {
        const d = await api(`/api/devices/${devId}`, { method: "PATCH", json: body });
        ctx.data.devices = ctx.data.devices.map((x) => (x.id === devId ? d : x));
        if (ctx.tab === "plans") await loadSystem(ctx); // circuits / zone runs follow moved or re-zoned devices
        ctx.rerender();
      } catch (e) { toast(e.message, true); }
    },
    async patchSheet(sheetId, body) {
      try { await api(`/api/sheets/${sheetId}`, { method: "PATCH", json: body }); await ctx.reload(); } catch (e) { toast(e.message, true); }
    },
  };
  ctx.meta = meta;
  return ctx;
}

/** Circuits, zone runs and panel allocation (drawn as layers on the plans). */
async function loadSystem(ctx) {
  try { ctx.system = await api(`/api/jobs/${ctx.data.job.id}/system`); } catch { ctx.system = null; }
}

/** Rules of the job's lighting-control spec (zoning required, default zone control…), or null. */
async function loadLightingRules(ctx) {
  const id = ctx.data.job.settings?.specs?.lighting;
  ctx.lightingRules = null; ctx.lightingAutoZone = false;
  try { ctx.specList = await api("/api/specs"); } catch { ctx.specList = []; }
  if (id) { try { const sp = (await api(`/api/specs/${id}`)).data; ctx.lightingRules = sp.rules; ctx.lightingAutoZone = autoZonesWith(sp); } catch { /* spec deleted */ } }
}

// ---------------------------------------------------------------- room tree
function renderRooms(ctx) {
  const { data, types } = ctx;
  const typeMap = Object.fromEntries(types.map((t) => [t.key, t]));
  const sheetLevel = Object.fromEntries(data.sheets.map((s) => [s.id, s.level]));
  const levels = new Map();
  const levelOf = (lv) => { const k = lv || "(no level)"; if (!levels.has(k)) levels.set(k, { rooms: [], unassigned: [] }); return levels.get(k); };
  for (const r of data.rooms) levelOf(r.level).rooms.push(r);
  for (const d of data.devices.filter((d) => !d.room_id)) levelOf(sheetLevel[d.sheet_id]).unassigned.push(d);

  const chips = (devs) => {
    const c = {};
    for (const d of devs) c[d.type] = (c[d.type] || 0) + 1;
    return h("div.chips", types.filter((t) => c[t.key]).map((t) => h("span.chip", { style: { background: t.color }, title: t.label }, `${c[t.key]} ${t.label}`)));
  };

  const lvlInput = h("input", { placeholder: "Level (e.g. Upper Level)", list: "levels" });
  const numInput = h("input", { placeholder: "No.", style: { width: "70px" } });
  const nameInput = h("input", { placeholder: "Room name" });
  const addRoom = async (e) => {
    e.preventDefault();
    if (!nameInput.value) return;
    await api(`/api/jobs/${data.job.id}/rooms`, { json: { level: lvlInput.value, number: numInput.value, name: nameInput.value } });
    await ctx.reload();
  };

  app.replaceChildren(h("div.page.narrow",
    h("div.row", h("h1.grow", "Room tree"), h("span.muted", `${data.rooms.length} rooms · ${data.devices.length} devices`)),
    !data.rooms.length ? h("div.warn", "No rooms yet. Analyze an electrical sheet with Claude on the Plans tab to build the room tree automatically, or add rooms below.") : null,
    [...levels.entries()].sort().map(([lv, g]) => h("div.card.section.tree",
      h("h2", lv, h("span.muted", { style: { fontWeight: 400, fontSize: ".85rem", marginLeft: "8px" } },
        `${g.rooms.length} rooms · ${data.devices.filter((d) => (d.room_id ? data.rooms.find((r) => r.id === d.room_id)?.level : sheetLevel[d.sheet_id]) === (lv === "(no level)" ? "" : lv)).length} devices`)),
      g.rooms.sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true })).map((r) => {
        const devs = data.devices.filter((d) => d.room_id === r.id);
        const zones = (data.zones || []).filter((z) => z.room_id === r.id);
        return h("div.room",
          h("input", { value: r.number, onchange: (e) => api(`/api/rooms/${r.id}`, { method: "PATCH", json: { number: e.target.value } }).then(ctx.reload) }),
          h("div",
            h("input", { value: r.name, style: { width: "100%", fontWeight: 600, border: "none", padding: "2px 0" }, onchange: (e) => api(`/api/rooms/${r.id}`, { method: "PATCH", json: { name: e.target.value } }).then(ctx.reload) }),
            devs.length ? chips(devs) : h("span.muted", { style: { fontSize: ".8rem" } }, "No devices"),
            zones.length ? h("div.muted", { style: { fontSize: ".78rem", marginTop: "3px" } }, "Zones: ",
              zones.map((z) => `${z.code} ${z.name} (${data.devices.filter((d) => d.zone_id === z.id).length}, ${ZONE_CONTROL_LABEL[z.control]})`).join(" · ")) : null),
          h("div.row",
            r.sheet_id ? h("button.small", { onclick: () => { focusSheet(r.sheet_id); location.hash = `#/job/${data.job.id}/plans`; } }, "Plan") : null,
            h("button.small.danger", { title: "Delete room (devices become unassigned)", onclick: async () => { if (confirm(`Delete room ${r.name}?`)) { await api(`/api/rooms/${r.id}`, { method: "DELETE" }); await ctx.reload(); } } }, "✕")));
      }),
      g.unassigned.length ? h("div.room", h("span.muted", "—"), h("div", h("em", "Unassigned"), chips(g.unassigned)), h("span")) : null,
    )),
    h("form.card", { onsubmit: addRoom },
      h("h3", "Add room"),
      h("datalist#levels", [...levels.keys()].map((l) => h("option", { value: l }))),
      h("div.row", lvlInput, numInput, h("span.grow", nameInput), h("button.primary", "Add"))),
  ));
  nameInput.style.width = "100%";
}

// ---------------------------------------------------------------- estimate
async function renderEstimate(ctx) {
  const est = await api(`/api/jobs/${ctx.data.job.id}/estimate`);
  const s = est.settings;
  const typeMap = Object.fromEntries(ctx.types.map((t) => [t.key, t]));
  const setting = (label, key, step = "0.01") => h("label", label,
    h("input", { type: "number", step, value: s[key], onchange: async (e) => { await api(`/api/jobs/${ctx.data.job.id}`, { method: "PATCH", json: { settings: { [key]: Number(e.target.value) } } }); renderEstimate(ctx); } }));
  const t = est.totals;
  const stat = (l, v, cls = "") => h("div.card.stat" + cls, h("div.v", v), h("div.l", l));

  app.replaceChildren(h("div.page.narrow",
    h("div.row.no-print", h("h1.grow", "Estimate"),
      h("a", { href: apiUrl(`/api/jobs/${ctx.data.job.id}/material-list.csv`) }, h("button", "Download material list (CSV)")),
      h("button", { onclick: () => print() }, "Print")),
    h("h2", { style: { display: "none" }, class: "print-title" }, est.job.name),
    est.sop_warnings?.length ? h("div.warn", h("strong", "Wire SOP: "), h("ul", { style: { margin: "4px 0 0" } }, est.sop_warnings.map((w) => h("li", w))),
      h("a", { href: "#/assemblies" }, "Fix in Assemblies")) : null,
    (est.system?.warnings || []).map((w) => h("div.warn", w)),
    h("p.muted.no-print", "Specs: ",
      h("strong", est.specs.devices?.name || "base devices"), " · ", h("strong", est.specs.lighting?.name || "no lighting-control spec"), " · ",
      h("strong", est.specs.panels?.name || "no panel spec"), " ",
      h("a", { href: `#/job/${ctx.data.job.id}/specs` }, "change")),
    est.pending ? h("div.warn", `${est.pending} AI-detected devices haven't been checked yet. They're included below. Confirm or delete them on the Plans tab.`) : null,
    !est.device_total ? h("div.warn", "No devices counted yet.") : null,

    h("div.card.section.no-print",
      h("h3", "Job settings"),
      h("div.form-grid",
        h("label", "Job type", h("select", { onchange: async (e) => { await api(`/api/jobs/${ctx.data.job.id}`, { method: "PATCH", json: { job_type: e.target.value } }); ctx.data.job.job_type = e.target.value; renderEstimate(ctx); } },
          h("option", { value: "new", selected: est.job.job_type === "new" }, "New construction"),
          h("option", { value: "remodel", selected: est.job.job_type === "remodel" }, "Remodel"))),
        setting("Labor rate ($/hr)", "labor_rate", "1"),
        // margin on cost, not markup (Tony, 2026-11-09); empty = the catalog's sell prices
        h("label", "Material margin %", h("input", { type: "number", step: "0.5", min: "0", max: "95", placeholder: "catalog price", value: s.margin_pct ?? "",
          title: "Sell price = cost ÷ (1 − margin). 40% margin on a $60 part sells it for $100. Leave empty to use the catalog's sell prices.",
          onchange: async (e) => { const v = e.target.value.trim(); await api(`/api/jobs/${ctx.data.job.id}`, { method: "PATCH", json: { settings: { margin_pct: v === "" ? null : Number(v) } } }); renderEstimate(ctx); } })),
        setting("Sales tax %", "tax_pct"),
        setting("Wire waste %", "waste_pct", "1"),
        setting("Remodel labor factor", "remodel_labor_factor", "0.05"))),

    h("div.stats",
      stat("Devices", num(est.device_total, 0)),
      stat("Material (sell)", money(t.material_price)),
      stat("Tax", money(t.tax)),
      stat(`Labor (${num(t.labor_hours)} hrs${est.labor_factor !== 1 ? ` ×${est.labor_factor}` : ""})`, money(t.labor_price)),
      stat("Bid total", money(t.total), ".total"),
      stat("Material cost", money(t.material_cost)),
      stat("Material margin", `${num(t.material_margin_pct, 1)}%`)),

    h("div.card.section",
      h("h2", "By phase"),
      h("table", h("tr", h("th", "Phase"), h("th.num", "Material"), h("th.num", "Labor hrs"), h("th.num", "Labor $")),
        Object.entries(est.phases).map(([p, v]) => h("tr", h("td", p), h("td.num", money(v.material_price)), h("td.num", num(v.labor_hours)), h("td.num", money(v.labor_hours * s.labor_rate)))))),

    est.system?.spec || est.system?.panel_spec ? h("div.card.section",
      h("h2", [est.system.spec?.name, est.system.panel_spec?.name].filter(Boolean).join(" · ")),
      h("div.chips",
        [["Zones", est.system.zones], ["Dimming DPMs", est.system.dpms], ["Switching DPMs", est.system.dpms_switching], ["DALI-2 modules", est.system.dali_modules],
          ["PD8 panels", est.system.panels], ["Ketra/DALI circuits", est.system.pd8_circuits], ["RF devices", est.system.rf_devices], ["RF processors", est.system.rf_processors],
          ...(est.system.panel_spec ? [["Power circuits", est.system.circuits.power + est.system.circuits.gfci], ["Lighting circuits", est.system.circuits.lighting], ["240V circuits", est.system.circuits.c240]] : [])]
          .filter(([, v]) => v).map(([l, v]) => h("span.chip", { style: { background: "var(--chip-neutral)" } }, `${v} ${l}`))),
      h("p.muted", { style: { fontSize: ".8rem" } }, `Home runs (before waste): zones ${est.system.home_runs.zones_ft} ft, Ketra/DALI ${est.system.home_runs.pd8_ft} ft, power ${est.system.home_runs.power_ft} ft, lighting ${est.system.home_runs.lighting_ft} ft, PD8 feeders ${est.system.home_runs.feeder_ft} ft. ${est.system.rf_reason || ""}`),
      panelScheduleTable(est.system),
      est.system.lines.length ? h("table", { style: { marginTop: "8px" } }, h("tr", h("th", "System item"), h("th", "Sized by"), h("th.num", "Qty")),
        est.system.lines.map((l) => h("tr", h("td", l.description), h("td.muted", ctx.meta.spec_bases[l.basis] || l.basis), h("td.num", num(l.qty, 2))))) : null) : null,

    h("div.card.section",
      h("h2", "Device counts"),
      h("div.chips", est.device_counts.map((c) => h("span.chip", { style: { background: typeMap[c.type].color } }, `${c.count} ${c.label}`)))),

    h("div.card.section",
      h("h2", `Material list (${est.lines.length} items)`),
      h("div.table-wrap", h("table",
        h("tr", h("th", "Phase"), h("th", "Item"), h("th", "Part #"), h("th.num", "Qty"), h("th.num", "Unit cost"), h("th.num", "Unit sell"), h("th.num", "Ext sell"), h("th.num", "Labor hrs")),
        est.lines.map((l) => h("tr",
          h("td", l.phase),
          h("td", l.description, !l.linked ? h("span.badge", { style: { marginLeft: "6px" }, title: "Not linked to a catalog item: uses the assembly's own price" }, "allowance") : null),
          h("td.muted", l.part_number), h("td.num", `${num(l.qty, 2)} ${l.unit}`), h("td.num", money(l.unit_cost)), h("td.num", money(l.unit_price)),
          h("td.num", money(l.ext_price)), h("td.num", num(l.labor_hours))))))),

    h("div.card.section",
      h("h2", "By room"),
      h("div.table-wrap", h("table",
        h("tr", h("th", "Level"), h("th", "Room"), h("th", "Devices"), h("th.num", "Material"), h("th.num", "Labor hrs")),
        est.rooms.map((r) => h("tr", h("td", r.level), h("td", `${r.number ? r.number + " " : ""}${r.room}`),
          h("td", Object.entries(r.counts).map(([k, n]) => `${n} ${typeMap[k]?.code || k}`).join(", ")),
          h("td.num", money(r.material_price)), h("td.num", num(r.labor_hours))))))),
  ));
}

// ---------------------------------------------------------------- catalog
async function renderCatalog(q = "") {
  const items = await api(`/api/catalog?limit=200&q=${encodeURIComponent(q)}`);
  const search = h("input", { placeholder: "Search manufacturer, model, part #, description…", value: q, style: { flex: 1 } });
  let timer;
  search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => renderCatalog(search.value).then(() => { const s = app.querySelector("input"); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }), 300); });
  const file = h("input", { type: "file", accept: ".csv,text/csv", hidden: true, onchange: async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      toast("Importing…");
      const r = await api("/api/catalog/import", { method: "POST", body: await f.text(), headers: { "Content-Type": "text/csv" } });
      meta = await api("/api/meta");
      toast(`Imported ${r.imported} items (${r.linked} assembly lines linked to catalog parts).`);
      renderCatalog(search.value);
    } catch (err) { toast(err.message, true); }
  } });

  // click off: saves the new item if anything was typed (Model is still required), otherwise just closes
  const dlg = clickOff(h("dialog"), () => { const fm = dlg.querySelector("form"); if (fm && [...fm.elements].some((el) => (el.tagName === "INPUT" || el.tagName === "TEXTAREA") && el.value.trim())) fm.requestSubmit(); else dlg.close(); });
  const openAdd = () => {
    const f = {};
    const field = (label, key, type = "text") => h("label", label, (f[key] = h("input", { type, step: "any" })));
    dlg.replaceChildren(h("form", { method: "dialog", onsubmit: async (e) => {
      e.preventDefault();
      try {
        await api("/api/catalog", { json: Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value])) });
        dlg.close(); toast("Saved to catalog."); renderCatalog(search.value);
      } catch (err) { toast(err.message, true); }
    } },
      h("h2", "Add catalog item"),
      h("div.form-grid", field("Manufacturer", "manufacturer"), field("Model *", "model"), field("Part number", "part_number"),
        field("Category", "category"), field("Subcategory", "subcategory"), field("Vendor", "vendor"),
        field("Unit cost", "unit_cost", "number"), field("Unit price", "unit_price", "number"), field("Labor hours", "labor_hours", "number"),
        field("Product URL", "url"), field("Phase", "phase")),
      h("label", { style: { display: "block", marginTop: "10px" } }, "Description", (f.description = h("textarea", { rows: 3, style: { width: "100%" } }))),
      h("div.row", { style: { marginTop: "12px", justifyContent: "flex-end" } }, h("button", { type: "button", onclick: () => dlg.close() }, "Cancel"), h("button.primary", "Save"))));
    dlg.showModal();
  };

  app.replaceChildren(h("div.page",
    h("div.row.section", h("h1.grow", "Catalog"), h("span.muted", `${meta.catalog_count} items`),
      h("button", { onclick: openAdd }, "Add item"),
      h("button.primary", { onclick: () => file.click() }, "Import D-Tools CSV"), file),
    h("p.muted", "Re-importing updates existing items (matched on manufacturer + model). Web-captured items from the browser extension will also land here (Phase 3)."),
    h("div.row.section", search),
    h("div.table-wrap", { style: { maxHeight: "calc(100vh - 230px)" } }, h("table",
      h("tr", h("th", "Manufacturer"), h("th", "Model"), h("th", "Part #"), h("th", "Category"), h("th.num", "Cost"), h("th.num", "Price"), h("th.num", "Labor"), h("th", "Vendor"), h("th", "")),
      items.map((c) => h("tr",
        h("td", c.manufacturer), h("td", { title: c.description }, c.model), h("td.muted", c.part_number), h("td.muted", `${c.category}${c.subcategory ? " / " + c.subcategory : ""}`),
        h("td.num", money(c.unit_cost)), h("td.num", money(c.unit_price)), h("td.num", num(c.labor_hours, 2)), h("td.muted", c.vendor),
        h("td", c.url ? h("a", { href: c.url, target: "_blank", rel: "noopener" }, "link") : null))))),
    dlg,
  ));
}

// ---------------------------------------------------------------- assemblies
let asmType = "receptacle";
async function renderAssemblies() {
  const asm = await api("/api/assemblies");
  const types = meta.device_types;
  const items = (asm[asmType] || []).map((it) => ({ ...it }));
  const t = types.find((x) => x.key === asmType);

  const totals = () => items.reduce((a, it) => {
    const qty = Number(it.qty || 0);
    const unitCost = it.catalog ? it.catalog.unit_cost : Number(it.unit_cost || 0);
    const unitPrice = it.catalog ? (it.catalog.unit_price || it.catalog.unit_cost) : Number(it.unit_cost || 0);
    const lab = it.labor_hours !== null && it.labor_hours !== undefined && it.labor_hours !== "" ? Number(it.labor_hours) : (it.catalog?.labor_hours || 0);
    a.cost += qty * unitCost; a.price += qty * unitPrice; a.labor += qty * lab; return a;
  }, { cost: 0, price: 0, labor: 0 });

  const save = async () => {
    await api(`/api/assemblies/${asmType}`, { method: "PUT", json: { items } });
    toast(`${t.label} assembly saved.`); renderAssemblies();
  };

  const picker = clickOff(h("dialog"));
  const pick = (idx) => {
    const list = h("div.table-wrap", { style: { maxHeight: "50vh" } });
    const q = h("input", { placeholder: "Search catalog…", style: { width: "100%" } });
    const run = async () => {
      const res = await api(`/api/catalog?limit=60&q=${encodeURIComponent(q.value)}`);
      list.replaceChildren(h("table", res.map((c) => h("tr.clickable", { onclick: () => {
        // keep the "(ft)" marker so wire stays priced per foot with waste added
        const perFoot = /\(ft\)/i.test(items[idx].description || "");
        Object.assign(items[idx], { catalog_id: c.id, catalog: c, description: `${c.manufacturer} ${c.model}${perFoot ? " (ft)" : ""}`, unit_cost: c.unit_cost, labor_hours: null });
        picker.close(); draw();
      } }, h("td", c.manufacturer), h("td", c.model), h("td.num", money(c.unit_cost)), h("td.num", num(c.labor_hours, 2))))));
    };
    let tm; q.addEventListener("input", () => { clearTimeout(tm); tm = setTimeout(run, 250); });
    picker.replaceChildren(h("h2", "Pick a catalog item"), q, list, h("div.row", { style: { justifyContent: "flex-end", marginTop: "10px" } }, h("button", { onclick: () => picker.close() }, "Close")));
    q.value = items[idx].description.replace(/\(.*?\)/g, "").split(" ").slice(0, 3).join(" ");
    picker.showModal(); run();
  };

  const body = h("div");
  // Wire SOP: power = min 12 AWG (20A), lighting = 14 AWG (15A).
  const gauge = (s) => { const m = String(s || "").match(/\b(\d{1,2})\s*\/\s*[2-4](?:-\d)?\b/); const g = m ? +m[1] : null; return g >= 6 && g <= 18 ? g : null; };
  const sopNote = (it) => {
    const text = `${it.description || ""} ${it.catalog?.model || ""}`;
    if (!/\(ft\)|NM-B|Romex/i.test(text)) return null;
    const g = gauge(text);
    if (g == null) return null;
    if (t.circuit === "power" && g > 12) return `SOP: power items need minimum 12 AWG (20A). This line is ${g} AWG.`;
    if (t.circuit === "lighting" && g < 14) return `SOP: lighting is 14 AWG (15A). This line is ${g} AWG.`;
    return null;
  };

  function draw() {
    const tot = totals();
    body.replaceChildren(
      h("p.muted", { style: { marginTop: 0 } }, t.circuit === "power" ? "Power item: 20A circuit, 12/2 NM-B minimum (SOP)."
        : t.circuit === "lighting" ? "Lighting item: 15A circuit, 14 AWG NM-B (SOP)." : ""),
      h("table",
        h("tr", h("th", "Item"), h("th.num", "Qty"), h("th.num", "Unit cost"), h("th.num", "Labor hrs/unit"), h("th", "Phase"), h("th", "")),
        items.map((it, i) => h("tr",
          h("td",
            it.catalog ? h("div", h("strong", `${it.catalog.manufacturer} ${it.catalog.model}`), h("div.muted", { style: { fontSize: ".8rem" } }, it.catalog.part_number || ""))
              : h("input", { value: it.description, style: { width: "100%" }, onchange: (e) => (it.description = e.target.value) }),
            h("div.row", { style: { gap: "4px", marginTop: "4px" } },
              h("button.small", { onclick: () => pick(i) }, it.catalog ? "Change part" : "Link catalog part"),
              it.catalog ? h("button.small", { onclick: () => { it.description = `${it.catalog.manufacturer} ${it.catalog.model}`; it.catalog = null; it.catalog_id = null; draw(); } }, "Unlink") : null),
            sopNote(it) ? h("div", { style: { color: "var(--bad)", fontSize: ".8rem", marginTop: "4px", fontWeight: 600 } }, "⚠ " + sopNote(it)) : null),
          h("td.num", h("input", { type: "number", step: "any", value: it.qty, style: { width: "80px" }, onchange: (e) => { it.qty = Number(e.target.value); draw(); } })),
          h("td.num", it.catalog ? money(it.catalog.unit_cost) : h("input", { type: "number", step: "any", value: it.unit_cost, style: { width: "90px" }, onchange: (e) => { it.unit_cost = Number(e.target.value); draw(); } })),
          h("td.num", h("input", { type: "number", step: "any", value: it.labor_hours ?? "", placeholder: it.catalog ? num(it.catalog.labor_hours, 3) : "0", style: { width: "90px" }, title: "Leave blank to use the catalog's labor hours", onchange: (e) => { it.labor_hours = e.target.value === "" ? null : Number(e.target.value); draw(); } })),
          h("td", h("select", { onchange: (e) => (it.phase = e.target.value) }, ["Rough", "Finish"].map((p) => h("option", { selected: (it.phase || "Rough") === p }, p)))),
          h("td", h("button.small.danger", { onclick: () => { items.splice(i, 1); draw(); } }, "✕"))))),
      h("div.row", { style: { marginTop: "10px" } },
        h("button", { onclick: () => { items.push({ catalog_id: null, description: "New item", qty: 1, unit_cost: 0, labor_hours: null, phase: "Rough" }); draw(); } }, "Add line"),
        h("span.grow"),
        h("span.muted", `Per device: cost ${money(tot.cost)} · sell ${money(tot.price)} · ${num(tot.labor, 2)} labor hrs`),
        h("button.primary", { onclick: save }, "Save assembly")),
      h("p.muted", { style: { fontSize: ".8rem" } }, "Wire lines are entered in feet and named “(ft)”; the job's wire waste % is added on the estimate."),
    );
  }
  draw();

  app.replaceChildren(h("div.page",
    h("h1", "Assemblies"),
    h("p.muted", "Each counted device expands into these parts and labor. Link lines to catalog parts so prices stay current when you re-import from D-Tools."),
    h("div", { style: { display: "grid", gridTemplateColumns: "230px 1fr", gap: "16px", alignItems: "start" } },
      h("div.card", { style: { padding: "8px" } }, types.map((x) => h("div.sheet-item" + (x.key === asmType ? ".active" : ""), { onclick: () => { asmType = x.key; renderAssemblies(); } },
        h("span.swatch", { style: { background: x.color } }), h("span", x.label)))),
      h("div.card", h("h2", t.label), body)),
    picker,
  ));
}

route();
