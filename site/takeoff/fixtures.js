// Lighting fixture schedule (Tony, 2026-11-09): type marks (A1, F3…) with description, maker/model, takeoff type, Ketra / DALI-2
// control and watts. Typed by hand or read by Claude from an uploaded PDF. Claude uses it when reading plans and zoning lights.
import { api, h, toast, money, loadPdf, pageText } from "./lib.js";

const CONTROL = [["", "Not stated"], ["dpm", "Standard (DPM)"], ["ketra", "Ketra"], ["dali", "DALI-2"], ["lumaris", "Lumaris"], ["wall", "Wall switch"]];

/** Upload a schedule PDF to the job and have Claude read it. progress(text) shows status. */
export async function uploadSchedule(jobId, file, progress = () => {}) {
  progress(`Uploading ${file.name}…`);
  const plan = await api(`/api/jobs/${jobId}/plans?filename=${encodeURIComponent(file.name)}&doc_type=lighting`, { method: "POST", body: file, headers: { "Content-Type": "application/pdf" } });
  return readSchedule(plan, progress);
}
export async function readSchedule(plan, progress = () => {}) {
  progress(`Reading the text of ${plan.filename}…`);
  const doc = await loadPdf(plan.id), pages = [];
  for (let p = 1; p <= doc.numPages; p++) pages.push({ page: p, text: (await pageText(await doc.getPage(p))).map((t) => t.s).join(" ").slice(0, 20000) });
  progress(`Claude is reading the fixture schedule in ${plan.filename}… (about a minute)`);
  const r = await api(`/api/plans/${plan.id}/extract-fixtures`, { json: { pages } });
  toast(`Claude found ${r.fixtures} fixture types${r.skipped ? ` (${r.skipped} already on the schedule were left as they are)` : ""} (${money(r.usage.cost_usd)}).`);
  return r;
}

/** The schedule card. ctx: { jobId, settings, plans, meta, reload } */
export function fixtureScheduleCard(ctx) {
  let rows = (ctx.settings.fixture_schedule || []).map((f) => ({ ...f }));
  let busy = null, dirty = false; // eslint-disable-line no-unused-vars
  const typeLabel = (k) => ctx.meta.device_types.find((t) => t.key === k)?.label || (k === "other" ? "Other" : k);
  const card = h("div.card.section", { style: { marginTop: "12px" } });
  const status = h("span.muted", { style: { fontSize: ".8rem" } });
  // typing saves quietly (no redraw, so the cursor stays put); adding or removing a row redraws
  const save = async (redraw = true) => {
    try {
      const out = (await api(`/api/jobs/${ctx.jobId}/fixture-schedule`, { method: "PUT", json: { fixtures: rows } })).fixtures;
      out.forEach((o, i) => { if (rows[i]) rows[i].id = o.id; }); ctx.settings.fixture_schedule = out; dirty = false; status.textContent = "Saved."; if (redraw) draw();
    } catch (e) { status.textContent = ""; toast(e.message, true); }
  };
  let timer = null;
  const later = () => { dirty = true; status.textContent = "Saving…"; clearTimeout(timer); timer = setTimeout(() => save(false), 700); };
  const input = (f, key, w, type = "text") => h("input", { type, value: f[key] ?? "", style: { width: w }, oninput: (e) => { f[key] = type === "number" ? Number(e.target.value) : e.target.value; later(); } });
  const docs = (ctx.plans || []).filter((p) => p.doc_type === "lighting");
  const file = h("input", { type: "file", accept: "application/pdf", hidden: true, onchange: async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { await uploadSchedule(ctx.jobId, f, (m) => { busy = m; draw(); }); } catch (err) { toast(err.message, true); }
    busy = null; await ctx.reload();
  } });
  const reread = async (p) => { try { await readSchedule(p, (m) => { busy = m; draw(); }); } catch (err) { toast(err.message, true); } busy = null; await ctx.reload(); };
  function draw() {
    card.replaceChildren(
      h("div.row", h("h3.grow", { style: { margin: 0 } }, "Lighting fixture schedule"),
        h("button.small", { disabled: !!busy, onclick: () => { rows.push({ id: crypto.randomUUID(), tag: "", description: "", manufacturer: "", model: "", type: "recessed", control: "", watts: 0, volts: 0, location: "", notes: "", source: "manual" }); draw(); save(); } }, "+ Add fixture"),
        h("button.small.primary", { disabled: !!busy || !ctx.meta.has_api_key, onclick: () => file.click() }, "Upload schedule PDF"), file),
      h("p.muted", { style: { fontSize: ".85rem" } }, "Optional. Fixture type marks on the plans (A1, F3…) and what they are. Claude uses this when it reads the plans and zones the lights, including which fixtures are Ketra or DALI-2. Type it in, or upload the schedule and Claude fills it in for you to check."),
      busy ? h("div.progress", busy) : null,
      docs.length ? h("div.muted", { style: { fontSize: ".8rem", marginBottom: "6px" } }, "From: ", docs.map((d) => h("span", { style: { marginRight: "10px" } }, d.filename, " ",
        h("a", { href: "#", onclick: (e) => { e.preventDefault(); if (!busy) reread(d); } }, "re-read")))) : null,
      rows.length ? h("div.table-wrap", h("table",
        h("tr", h("th", "Tag"), h("th", "Description"), h("th", "Manufacturer"), h("th", "Model"), h("th", "Takeoff type"), h("th", "Control"), h("th.num", "Watts"), h("th", "Notes"), h("th", "")),
        rows.map((f, i) => h("tr",
          h("td", input(f, "tag", "56px")), h("td", input(f, "description", "190px")), h("td", input(f, "manufacturer", "110px")), h("td", input(f, "model", "150px")),
          h("td", h("select", { onchange: (e) => { f.type = e.target.value; later(); } },
            [...ctx.meta.fixture_types, "other"].map((k) => h("option", { value: k, selected: f.type === k }, typeLabel(k))))),
          h("td", h("select", { onchange: (e) => { f.control = e.target.value; later(); } }, CONTROL.map(([v, l]) => h("option", { value: v, selected: (f.control || "") === v }, l)))),
          h("td.num", input(f, "watts", "60px", "number")), h("td", input(f, "notes", "160px")),
          h("td", f.source === "ai" ? h("span.badge.ai", { title: "Read by Claude: check it" }, "AI") : null,
            h("button.small.danger", { title: "Remove", onclick: () => { rows.splice(i, 1); draw(); save(); } }, "✕")))))) : h("p.muted", { style: { margin: 0 } }, "No fixtures on the schedule yet."),
      h("div", { style: { marginTop: "4px" } }, status));
  }
  draw();
  return card;
}
