// Project setup: create the job, load every document, pick specs, then let Claude read it all in one pass.
import { api, h, toast, money, loadPdf, pageText, describePage, IN_HUB, autoZonesWith } from "./lib.js";
import { analyzeSheetInBrowser, codeCheckSheet } from "./plans.js";
import { CATEGORY_LABEL, kdChooser } from "./specs.js";
import { readSchedule, fixtureScheduleCard } from "./fixtures.js";

const STEPS = ["Project", "Documents", "Specs", "Review & run"];
const DOC_SLOTS = [
  { type: "plans", label: "Electrical / lighting plans", help: "Interior design or electrical set. Sheets are split out and electrical plans detected automatically." },
  { type: "appliance", label: "Appliance schedule", help: "Claude lists every appliance that needs a circuit." },
  { type: "mechanical", label: "Mechanical drawings", help: "Heat pumps, air handlers, boilers, pumps, fans… everything needing power." },
  { type: "lighting", label: "Lighting fixture schedule (optional)", help: "Claude reads the fixture types (A1, F3…), including which are Ketra or DALI-2. You can also type the schedule in on the Specs step or the job's Specs tab." },
  { type: "mechanical", label: "Spa / pool / other equipment", help: "Spa and pool equipment plans, read the same way as mechanical drawings.", key: "spa" },
];
const GEN_RE = /\b(GENERATOR|GEN\.?\s*SET|STANDBY\s+(POWER|GEN)|TRANSFER\s+SWITCH|ATS|POWERWALL|BATTERY\s+STORAGE)\b/i;
const COST = { sheet: 0.7, doc: 0.25, zone: 0.08, code: 0.15 }; // sheet = analysis + room assignment

let wiz = null; // { step, jobId, busy, log: [] }

export async function renderSetup(app, meta, jobId) {
  if (!wiz || (jobId && wiz.jobId !== jobId)) wiz = { step: jobId ? 1 : 0, jobId: jobId || null, busy: null, log: [], picks: {} };
  const job = wiz.jobId ? await api(`/api/jobs/${wiz.jobId}`) : null;
  const specs = await api("/api/specs");
  const go = (n) => { wiz.step = n; renderSetup(app, meta, wiz.jobId); };

  const stepper = h("div.row", { style: { gap: "6px", marginBottom: "14px" } },
    STEPS.map((s, i) => h("div", {
      style: { padding: "6px 12px", borderRadius: "16px", fontSize: ".85rem", cursor: job || i === 0 ? "pointer" : "default",
        background: i === wiz.step ? "var(--gold)" : i < wiz.step ? "var(--accent-soft)" : "var(--surface-2)", color: i === wiz.step ? "var(--gold-ink)" : "inherit" },
      onclick: () => { if (job || i === 0) go(i); },
    }, `${i + 1}. ${s}`)));

  let body;
  if (wiz.step === 0) body = stepProject(job, meta, async (j) => { wiz.jobId = j.id; history.replaceState(null, "", `#/new/${j.id}`); go(1); });
  else if (wiz.step === 1) body = stepDocuments(job, () => renderSetup(app, meta, wiz.jobId));
  else if (wiz.step === 2) body = stepSpecs(job, specs, meta, () => renderSetup(app, meta, wiz.jobId));
  else body = stepRun(job, specs, () => renderSetup(app, meta, wiz.jobId));

  app.replaceChildren(h("div.page.narrow",
    h("div.row", h("h1.grow", job ? `Set up: ${job.job.name}` : "New project"), job ? h("a", { href: `#/job/${job.job.id}/plans` }, "Skip to the takeoff →") : null),
    stepper,
    wiz.busy ? h("div.progress.section", wiz.busy) : null,
    body,
    h("div.row", { style: { marginTop: "16px" } },
      wiz.step > 0 ? h("button", { onclick: () => go(wiz.step - 1), disabled: !!wiz.busy }, `← ${STEPS[wiz.step - 1]}`) : null,
      h("span.grow"),
      wiz.step > 0 && wiz.step < 3 ? h("button.primary", { onclick: () => go(wiz.step + 1), disabled: !!wiz.busy }, "Next →") : null),
  ));
}

// ---------------------------------------------------------------- 1. project
function stepProject(job, meta, onCreated) {
  const j = job?.job;
  const s = j?.settings || meta.default_settings;
  const f = {
    name: h("input", { value: j?.name || "", placeholder: "e.g. 202 Pine Tree – Stone Haven" }),
    address: h("input", { value: j?.address || "", placeholder: "Address" }),
    type: h("select", h("option", { value: "new", selected: j?.job_type !== "remodel" }, "New construction"), h("option", { value: "remodel", selected: j?.job_type === "remodel" }, "Remodel")),
    labor: h("input", { type: "number", value: s.labor_rate }),
    tax: h("input", { type: "number", step: "0.001", value: s.tax_pct }),
  };
  // SIS Tools project list (Tony, 2026-11-09): pick the project and its name, address and sales tax fill in
  let link = s.sis_job || null, taxFound = null; // taxFound = { rate, county, state, source } from the last lookup
  const taxNote = h("div.muted", { style: { fontSize: ".8rem", marginTop: "4px" } });
  const showTax = () => {
    const t = taxFound; if (!t) { taxNote.textContent = ""; return; }
    const where = [t.county && `${t.county} County`, t.state].filter(Boolean).join(", ");
    taxNote.textContent = t.rate == null ? `No sales tax rate found${where ? " for " + where : ""}. Type it and it's remembered${t.county ? " for " + t.county + " County" : ""}.`
      : `${t.rate}%${where ? " · " + where : ""}${t.place ? " (" + t.place + ")" : ""} · ${{ saved: "your saved rate", cdtfa: "California CDTFA rate for this address", nv: "Nevada county rate" }[t.source] || ""}`;
  };
  const lookupTax = async (address, state) => {
    taxNote.textContent = "Looking up sales tax…";
    try { taxFound = await api(`/api/sis-tax?address=${encodeURIComponent(address)}&state=${encodeURIComponent(state || "")}`); if (taxFound.rate != null) f.tax.value = taxFound.rate; }
    catch (e) { taxFound = { rate: null }; }
    showTax();
  };
  const linkLine = h("div.muted", { style: { fontSize: ".85rem" } });
  const showLink = () => { linkLine.textContent = link ? `Linked to SIS project ${[link.no, link.name].filter(Boolean).join(" ")}` : ""; };
  let picker = null;
  if (IN_HUB) {
    const q = h("input", { placeholder: "Search SIS projects by number, name or address…", autocomplete: "off", style: { width: "100%" } });
    const list = h("div.sis-proj-list", { hidden: true, style: { position: "absolute", left: 0, right: 0, top: "100%", zIndex: 30, background: "var(--surface)", border: "1px solid var(--line-strong)", borderRadius: "8px", boxShadow: "var(--shadow-3)", maxHeight: "320px", overflowY: "auto" } });
    let all = null;
    const pick = async (p) => {
      link = { id: p.id, no: p.no, name: p.name }; showLink(); list.hidden = true; q.value = "";
      f.name.value = [p.no, p.name].filter(Boolean).join(" "); f.address.value = p.address;
      if (p.address) await lookupTax(p.address, p.state); else { taxFound = null; taxNote.textContent = "This project has no address in Administration › Projects, so sales tax wasn't looked up."; }
    };
    const draw = () => {
      const t = q.value.trim().toLowerCase(), hits = (all || []).filter((p) => !t || `${p.no} ${p.name} ${p.address} ${p.pm}`.toLowerCase().includes(t)).slice(0, 40);
      list.replaceChildren(...(all === null ? [h("div.muted", { style: { padding: "8px 10px" } }, "Loading projects…")] : hits.length ? hits.map((p) => h("div.clickable", { style: { padding: "7px 10px", borderBottom: "1px solid var(--line)", cursor: "pointer" }, onmousedown: (e) => { e.preventDefault(); pick(p); } },
        h("div", h("b", p.no || "—"), " ", p.name, p.wo ? h("span.muted", " · work order") : null, p.status === "complete" ? h("span.muted", " · complete") : null),
        h("div.muted", { style: { fontSize: ".8rem" } }, [p.address || "No address", p.pm].filter(Boolean).join(" · ")))) : [h("div.muted", { style: { padding: "8px 10px" } }, "No matching project. Add it in Administration › Projects, or fill the fields by hand.")]));
      list.hidden = false;
    };
    q.addEventListener("focus", async () => { draw(); if (all === null) { try { all = (await api("/api/sis-projects")).projects; } catch (e) { all = []; } draw(); } });
    q.addEventListener("input", draw);
    f.address.addEventListener("change", () => { if (f.address.value.trim()) lookupTax(f.address.value.trim(), ""); }); // typed by hand
    q.addEventListener("blur", () => setTimeout(() => (list.hidden = true), 150));
    q.addEventListener("keydown", (e) => { if (e.key === "Escape") { list.hidden = true; q.blur(); } if (e.key === "Enter") { const first = list.querySelector(".clickable"); if (first) first.dispatchEvent(new MouseEvent("mousedown")); } });
    picker = h("div", { style: { marginBottom: "12px" } }, h("label", { style: { display: "block", fontSize: ".85rem", color: "var(--muted)", marginBottom: "4px" } }, "SIS project"),
      h("div", { style: { position: "relative" } }, q, list), linkLine);
    showLink();
  }
  const save = async () => {
    if (!f.name.value.trim()) return toast("Give the project a name.", true);
    let id = j?.id;
    if (!id) id = (await api("/api/jobs", { json: { name: f.name.value, address: f.address.value, job_type: f.type.value } })).id;
    await api(`/api/jobs/${id}`, { method: "PATCH", json: { name: f.name.value, address: f.address.value, job_type: f.type.value, settings: { labor_rate: Number(f.labor.value), tax_pct: Number(f.tax.value), sis_job: link } } });
    // a rate typed for a county is remembered for the next project there
    if (IN_HUB && taxFound?.county && taxFound.state && f.tax.value !== "" && Number(f.tax.value) !== taxFound.rate)
      api("/api/sis-tax", { method: "PUT", json: { county: taxFound.county, state: taxFound.state, rate: Number(f.tax.value) } }).catch(() => {});
    onCreated({ id });
  };
  return h("div.card", picker,
    h("div.form-grid", h("label", "Project name", f.name), h("label", "Address", f.address), h("label", "Type", f.type),
      h("label", "Labor rate ($/hr)", f.labor), h("label", "Sales tax %", f.tax)), taxNote,
    h("div.row", { style: { marginTop: "12px", justifyContent: "flex-end" } }, h("button.primary", { onclick: save }, j ? "Save and continue →" : "Create project →")));
}

// ---------------------------------------------------------------- 2. documents
function stepDocuments(job, refresh) {
  const plans = job.plans;
  const sheetsOf = (pid) => job.sheets.filter((s) => s.plan_id === pid);
  const upload = (slot) => {
    const input = h("input", { type: "file", accept: "application/pdf", multiple: true, onchange: async (e) => {
      for (const file of e.target.files) {
        try {
          wiz.busy = `Uploading ${file.name}…`; refresh();
          const plan = await api(`/api/jobs/${job.job.id}/plans?filename=${encodeURIComponent(file.name)}&doc_type=${slot.type}`, { method: "POST", body: file, headers: { "Content-Type": "application/pdf" } });
          if (slot.type === "lighting") { await readSchedule(plan, (m) => { wiz.busy = m; refresh(); }); continue; }
          if (slot.type !== "appliance") {
            const doc = await loadPdf(plan.id);
            const out = [];
            for (let p = 1; p <= doc.numPages; p++) {
              wiz.busy = `Reading ${file.name}: sheet ${p} of ${doc.numPages}…`; refresh();
              const d = await describePage(await doc.getPage(p), p);
              out.push(slot.type === "plans" ? d : { ...d, kind: "other" });
            }
            await api(`/api/plans/${plan.id}/sheets`, { json: { sheets: out } });
          }
        } catch (err) { toast(err.message, true); }
      }
      wiz.busy = null;
      await scanGenerator(job.job.id);
      refresh();
    } });
    input.click();
  };

  return h("div",
    h("p.muted", "Load everything for the project. You can add more later from the Plans and Equipment tabs."),
    DOC_SLOTS.map((slot) => {
      const mine = plans.filter((p) => p.doc_type === slot.type && (slot.key === "spa" ? /spa|pool|plumb/i.test(p.filename) : slot.type !== "mechanical" || !/spa|pool|plumb/i.test(p.filename)));
      return h("div.card.section",
        h("div.row", h("div.grow", h("h3", { style: { margin: 0 } }, slot.label), h("div.muted", { style: { fontSize: ".85rem" } }, slot.help)),
          h("button", { onclick: () => upload(slot), disabled: !!wiz.busy }, mine.length ? "Add another" : "Upload PDF")),
        mine.length ? h("ul.notes", { style: { marginTop: "8px" } }, mine.map((p) => {
          const sh = sheetsOf(p.id);
          const el = sh.filter((s) => s.kind === "electrical");
          return h("li", h("strong", p.filename), slot.type === "appliance" ? "" : ` · ${sh.length} sheets${slot.type === "plans" ? `, ${el.length} electrical (${el.map((s) => s.sheet_no).join(", ")})` : ""}`);
        })) : null);
    }),
    generatorNote(job));
}

async function scanGenerator(jobId) {
  const job = await api(`/api/jobs/${jobId}`);
  const hits = (job.job.settings.generator?.hits || []).filter((x) => x.source === "claude");
  for (const plan of job.plans.filter((p) => p.doc_type !== "appliance")) {
    const doc = await loadPdf(plan.id);
    for (let p = 1; p <= doc.numPages; p++) {
      const hit = (await pageText(await doc.getPage(p))).find((t) => GEN_RE.test(t.s));
      if (hit) hits.push({ sheet: job.sheets.find((s) => s.plan_id === plan.id && s.page === p)?.sheet_no || `${plan.filename} p${p}`, text: hit.s.slice(0, 200), source: "scan" });
    }
  }
  await api(`/api/jobs/${jobId}`, { method: "PATCH", json: { settings: { generator: { checked_at: new Date().toISOString(), hits } } } });
}

function generatorNote(job) {
  const hits = job.job.settings.generator?.hits || [];
  if (!job.job.settings.generator?.checked_at) return null;
  return hits.length
    ? h("div.warn", h("strong", "Backup power mentioned in the documents: "), hits.slice(0, 4).map((x) => `${x.sheet}: “${x.text}”`).join(" · "), ". Pick a backup spec and a SPAN or Leviton smart panel on the next step.")
    : h("p.muted", "No generator, transfer switch or Powerwall notes found in the document text.");
}

// ---------------------------------------------------------------- 3. specs
function stepSpecs(job, specs, meta, refresh) {
  const js = job.job.settings.specs || {};
  const save = async (patch) => { await api(`/api/jobs/${job.job.id}`, { method: "PATCH", json: { settings: { specs: { ...js, ...patch } } } }); refresh(); };
  const gen = (job.job.settings.generator?.hits || []).length > 0;
  const backupWanted = gen || js.backup;
  const smart = specs.filter((s) => s.category === "panels" && /span|leviton/i.test(s.name));
  const pick = (cat) => {
    const list = specs.filter((s) => s.category === cat);
    const cur = list.find((s) => s.id === js[cat]);
    return h("div.card",
      h("h3", CATEGORY_LABEL[cat]),
      h("select", { style: { width: "100%" }, onchange: (e) => save({ [cat]: e.target.value ? Number(e.target.value) : null }) },
        h("option", { value: "" }, cat === "backup" ? "— No backup power —" : "— None / base assemblies —"),
        list.map((s) => h("option", { value: s.id, selected: s.id === js[cat] }, s.name))),
      cur ? h("p.muted", { style: { fontSize: ".8rem" } }, cur.data.description) : null,
      cat === "backup" && cur ? h("div.row", { style: { fontSize: ".85rem" } },
        h("label", "Units ", h("input", { type: "number", min: 1, value: js.backup_units ?? 1, style: { width: "60px" }, onchange: (e) => save({ backup_units: Number(e.target.value) }) })),
        h("label", "Expansions ", h("input", { type: "number", min: 0, value: js.backup_expansions ?? 0, style: { width: "60px" }, onchange: (e) => save({ backup_expansions: Number(e.target.value) }) }))) : null,
      cat === "panels" && backupWanted && !(cur && /span|leviton/i.test(cur.name)) ? h("div.warn", { style: { marginTop: "6px" } },
        "Backup power on this job: company default is a SPAN or Leviton smart panel. ",
        smart.map((s) => h("button.small", { style: { marginLeft: "4px" }, onclick: () => save({ panels: s.id }) }, `Use ${s.name}`))) : null);
  };
  return h("div",
    h("p.muted", "These decide which parts every device uses, how lighting control and tape are built, the panel, and what Claude is told when it reads the drawings. Edit the standards themselves in the Spec library."),
    h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "12px" } },
      ["devices", "lighting", "panels", "tape", "backup"].map(pick)),
    h("div.card.section", { style: { marginTop: "12px" } },
      h("h3", "Ketra and DALI-2 fixtures"),
      kdChooser(js, meta, save)),
    fixtureScheduleCard({ jobId: job.job.id, settings: job.job.settings, plans: job.plans, meta, reload: async () => refresh() }));
}

// ---------------------------------------------------------------- 4. review & run
function stepRun(job, specs, refresh) {
  const js = job.job.settings.specs || {};
  const lighting = specs.find((s) => s.id === js.lighting);
  const elec = job.sheets.filter((s) => s.kind === "electrical");
  const docs = job.plans.filter((p) => p.doc_type === "appliance" || p.doc_type === "mechanical");
  wiz.picks.sheets ??= new Set(elec.filter((s) => !s.analyzed_at).map((s) => s.id));
  wiz.picks.docs ??= new Set(docs.filter((d) => !job.loads.some((l) => l.doc_id === d.id)).map((d) => d.id));
  wiz.picks.zone ??= autoZonesWith(lighting?.data);
  wiz.picks.code ??= true;
  const nS = wiz.picks.sheets.size, nD = wiz.picks.docs.size;
  const cost = nS * COST.sheet + nD * COST.doc + (wiz.picks.zone ? nS * COST.zone : 0) + (wiz.picks.code ? nS * COST.code : 0);
  const toggle = (set, id) => { set.has(id) ? set.delete(id) : set.add(id); refresh(); };

  const run = async () => {
    wiz.log = [];
    const log = (m) => { wiz.log.push(m); refresh(); };
    try {
      for (const s of elec.filter((x) => wiz.picks.sheets.has(x.id))) {
        wiz.busy = `Analysing ${s.sheet_no}…`; refresh();
        try {
          const r = await analyzeSheetInBrowser(s, (m) => { wiz.busy = `${s.sheet_no}: ${m}`; refresh(); });
          log(`✓ ${s.sheet_no}: ${r.rooms} rooms, ${r.devices} devices (${money(r.usage.cost_usd)})`);
          if (wiz.picks.zone) {
            wiz.busy = `${s.sheet_no}: Claude is zoning the lights…`; refresh();
            const z = await api(`/api/sheets/${s.id}/auto-zone`, { method: "POST" }).catch((e) => ({ error: e.message }));
            log(z.error ? `  ! ${s.sheet_no} zoning: ${z.error}` : `  ✓ ${s.sheet_no}: ${z.zones} zones (${money(z.usage.cost_usd)})`);
          }
          if (wiz.picks.code) {
            const c = await codeCheckSheet(s, (m) => { wiz.busy = `${s.sheet_no}: ${m}`; refresh(); }).catch((e) => ({ error: e.message }));
            log(c.error ? `  ! ${s.sheet_no} code check: ${c.error}` : `  ✓ ${s.sheet_no}: ${c.findings} code findings to review (${money(c.usage.cost_usd)})`);
          }
          wiz.picks.sheets.delete(s.id);
        } catch (e) { log(`✗ ${s.sheet_no}: ${e.message}`); }
      }
      for (const d of docs.filter((x) => wiz.picks.docs.has(x.id))) {
        wiz.busy = `Claude is reading ${d.filename}…`; refresh();
        try {
          const doc = await loadPdf(d.id);
          const pages = [];
          for (let p = 1; p <= doc.numPages; p++) pages.push({ page: p, text: (await pageText(await doc.getPage(p))).map((t) => t.s).join(" ").slice(0, 20000) });
          const r = await api(`/api/plans/${d.id}/extract-loads`, { json: { pages } });
          log(`✓ ${d.filename}: ${r.loads} items needing power${r.duplicates ? `, ${r.duplicates} already on the plans` : ""} (${money(r.usage.cost_usd)})`);
          wiz.picks.docs.delete(d.id);
        } catch (e) { log(`✗ ${d.filename}: ${e.message}`); }
      }
      log("Done. Next: place the electrical panel(s), PD8 lighting panel(s) and any risers on each electrical sheet, then review the dashed markers.");
    } finally { wiz.busy = null; refresh(); }
  };

  return h("div",
    h("div.card.section",
      h("h3", "Claude will read"),
      elec.length ? h("div", h("strong", "Electrical sheets"),
        elec.map((s) => h("label", { style: { display: "block", fontSize: ".9rem" } },
          h("input", { type: "checkbox", checked: wiz.picks.sheets.has(s.id), onchange: () => toggle(wiz.picks.sheets, s.id) }),
          ` ${s.sheet_no} ${s.title}${s.analyzed_at ? " (already analysed)" : ""}`))) : h("p.muted", "No electrical sheets detected. Go back and upload the plans, or mark sheets as electrical on the Plans tab."),
      lighting ? h("label", { style: { display: "block", marginTop: "6px", fontSize: ".9rem" } },
        h("input", { type: "checkbox", checked: wiz.picks.zone, onchange: () => { wiz.picks.zone = !wiz.picks.zone; refresh(); } }),
        ` Zone the lights on each sheet (${lighting.name})`) : null,
      h("label", { style: { display: "block", fontSize: ".9rem" } },
        h("input", { type: "checkbox", checked: wiz.picks.code, onchange: () => { wiz.picks.code = !wiz.picks.code; refresh(); } }),
        ` Check each sheet against NEC ${job.job.settings.code_nec || "2026"} / IRC ${job.job.settings.code_irc || "2024"}`),
      docs.length ? h("div", { style: { marginTop: "8px" } }, h("strong", "Equipment documents"),
        docs.map((d) => h("label", { style: { display: "block", fontSize: ".9rem" } },
          h("input", { type: "checkbox", checked: wiz.picks.docs.has(d.id), onchange: () => toggle(wiz.picks.docs, d.id) }),
          ` ${d.filename}${job.loads.some((l) => l.doc_id === d.id) ? " (already read)" : ""}`))) : null,
      h("p", { style: { marginTop: "10px" } }, h("strong", `Estimated API cost: about ${money(cost)}`),
        h("span.muted", ` (${nS} sheet${nS === 1 ? "" : "s"} × ~$0.60${wiz.picks.zone ? " + zoning" : ""}, ${nD} document${nD === 1 ? "" : "s"} × ~$0.25)`)),
      h("button.primary", { disabled: !!wiz.busy || (!nS && !nD), onclick: run }, wiz.busy ? "Running…" : "Start")),
    wiz.log.length ? h("div.card.section", h("h3", "Progress"), h("ul.notes", wiz.log.map((m) => h("li", m))),
      !wiz.busy ? h("a", { href: `#/job/${job.job.id}/plans` }, h("button.primary", "Open the plans →")) : null) : null);
}
