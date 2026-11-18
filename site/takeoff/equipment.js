// Equipment tab: appliance specs + mechanical drawings -> loads needing dedicated circuits.
import { api, h, toast, money, loadPdf, pageText, describePage } from "./lib.js";

const CATS = { kitchen: "Kitchen", laundry: "Laundry", hvac: "HVAC", water_heating: "Water heating", pump: "Pumps", ev: "EV", pool_spa: "Pool / spa", other: "Other" };
const BREAKERS = [15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100, 110, 125, 150, 175, 200];
const DOC_LABEL = { appliance: "Appliance spec", mechanical: "Mechanical drawings" };
let busy = null;
let lastNotes = [];

/** Same sizing as the server: NM-B (12 AWG minimum per SOP) up to 60A, aluminum SER above. */
function wireFor(breaker, poles, neutral) {
  if (breaker > 60) {
    const size = [[65, "4"], [90, "2"], [100, "1"], [120, "1/0"], [135, "2/0"], [155, "3/0"], [180, "4/0"], [999, "250"]].find(([a]) => breaker <= a)[1];
    return `#${size} Al SER`;
  }
  const g = breaker <= 20 ? 12 : breaker <= 30 ? 10 : breaker <= 40 ? 8 : 6;
  return `${g}/${poles === 1 ? 2 : neutral ? 3 : 2} NM-B`;
}

/** Review panel: equipment documents vs devices on the electrical plans. */
function reviewPanel(recon) {
  const rows = recon.filter((r) => r.mismatch);
  if (!rows.length) {
    return recon.length ? h("div.card.section", h("h3", "Electrical vs. equipment documents"),
      h("p.muted", recon.map((r) => `${r.label}s: ${r.plans} on the plans, ${r.documents} in the documents ✓`).join(" · "))) : null;
  }
  return h("div.card.section", { style: { borderColor: "var(--warn-line)" } },
    h("h3", "Review: counts don't match"),
    h("p.muted", { style: { fontSize: ".85rem" } }, "Exhaust fans, ceiling fans and smoke/CO detectors are counted from the electrical plans, so the ones in the equipment documents are left out. When the counts differ, one of the drawings may be missing something."),
    rows.map((r) => h("div", { style: { marginTop: "8px" } },
      h("div", h("strong", `${r.label}s: `), `${r.plans} on the electrical plans, ${r.documents} in the equipment documents`,
        r.documents_without_room ? h("span.muted", ` (${r.documents_without_room} with no room)`) : null),
      !r.complete ? h("div.warn", { style: { marginTop: "6px" } }, `Only ${r.sheets_analyzed} of ${r.sheets_total} electrical sheets are analysed (still to do: ${r.not_analyzed.join(", ")}), so the plan count is incomplete. Check again after analysing them.`) : null,
      r.rooms_differing.length ? h("table", { style: { marginTop: "6px", maxWidth: "520px" } },
        h("tr", h("th", "Room"), h("th.num", "Electrical plans"), h("th.num", "Equipment docs")),
        r.rooms_differing.map((x) => h("tr", h("td", x.room), h("td.num", x.plans), h("td.num", x.documents)))) : null,
      h("p.muted", { style: { fontSize: ".8rem" } }, "If the electrical plans are missing one, add it on the Plans tab; to price one from the documents instead, tick it in the list below."))));
}

export async function renderEquipment(app, ctx) {
  const { data } = ctx;
  const [system, recon] = await Promise.all([api(`/api/jobs/${data.job.id}/system`), api(`/api/jobs/${data.job.id}/reconcile`)]);
  const circuitOf = new Map((system.load_circuits || []).map((c) => [c.load_id, c]));
  const docs = data.plans.filter((p) => p.doc_type === "appliance" || p.doc_type === "mechanical");
  const rooms = data.rooms.slice().sort((a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));

  const upload = (docType) => {
    const input = h("input", { type: "file", accept: "application/pdf", onchange: async (e) => {
      const file = e.target.files[0]; if (!file) return;
      try {
        busy = `Uploading ${file.name}…`; renderEquipment(app, ctx);
        const plan = await api(`/api/jobs/${data.job.id}/plans?filename=${encodeURIComponent(file.name)}&doc_type=${docType}`, {
          method: "POST", body: file, headers: { "Content-Type": "application/pdf" },
        });
        if (docType === "mechanical") {
          // Mechanical sheets also go in the sheet list so equipment locations can be viewed.
          const doc = await loadPdf(plan.id);
          const out = [];
          for (let p = 1; p <= doc.numPages; p++) { busy = `Reading sheet ${p} of ${doc.numPages}…`; renderEquipment(app, ctx); out.push({ ...(await describePage(await doc.getPage(p), p)), kind: "other" }); }
          await api(`/api/plans/${plan.id}/sheets`, { json: { sheets: out } });
        }
        busy = null;
        await ctx.reload();
        await extract(plan);
      } catch (err) { busy = null; toast(err.message, true); renderEquipment(app, ctx); }
    } });
    input.click();
  };

  const extract = async (plan) => {
    try {
      busy = `Reading the text of ${plan.filename}…`; renderEquipment(app, ctx);
      const doc = await loadPdf(plan.id);
      const pages = [];
      for (let p = 1; p <= doc.numPages; p++) pages.push({ page: p, text: (await pageText(await doc.getPage(p))).map((t) => t.s).join(" ").slice(0, 20000) });
      busy = `Claude is listing the equipment that needs power in ${plan.filename}… (1–3 minutes)`; renderEquipment(app, ctx);
      const r = await api(`/api/plans/${plan.id}/extract-loads`, { json: { pages } });
      lastNotes = r.notes || [];
      toast(`Claude found ${r.loads} items needing power (${money(r.usage.cost_usd)})${r.duplicates ? `; ${r.duplicates} already on the plan as devices were left out` : ""}.`);
    } catch (err) { toast(err.message, true); }
    busy = null;
    await ctx.reload();
  };

  const patch = async (l, body) => {
    try {
      const nl = await api(`/api/loads/${l.id}`, { method: "PATCH", json: body });
      data.loads = data.loads.map((x) => (x.id === l.id ? nl : x));
      renderEquipment(app, ctx);
    } catch (err) { toast(err.message, true); }
  };
  const addLoad = async () => {
    await api(`/api/jobs/${data.job.id}/loads`, { json: { name: "New equipment", volts: 120 } });
    await ctx.reload();
  };

  const loads = data.loads || [];
  const included = loads.filter((l) => l.include);
  const groups = Object.keys(CATS).filter((c) => loads.some((l) => l.category === c));

  app.replaceChildren(h("div.page",
    h("div.row", h("h1.grow", "Equipment & dedicated circuits"),
      h("button", { disabled: !!busy, onclick: () => upload("appliance") }, "Upload appliance spec"),
      h("button", { disabled: !!busy, onclick: () => upload("mechanical") }, "Upload mechanical drawings"),
      h("button.primary", { onclick: addLoad }, "+ Add equipment")),
    h("p.muted", "Claude reads appliance specs and mechanical drawings (equipment schedules) and lists everything that needs power: appliances, heat pumps, air handlers, boilers, pumps and so on. Each included item gets a dedicated circuit: breaker sized from the MOCP (or 125% of the amps), NM-B by breaker size, a disconnect where needed, and a home run measured from its room to the nearest electrical panel."),
    busy ? h("div.progress", busy) : null,

    docs.length ? h("div.card.section",
      h("h3", "Documents"),
      h("table", docs.map((d) => h("tr",
        h("td", h("span.badge", DOC_LABEL[d.doc_type])), h("td", d.filename),
        h("td.muted", `${loads.filter((l) => l.doc_id === d.id).length} items`),
        h("td", h("button.small", { disabled: !!busy || !ctx.meta.has_api_key, onclick: () => extract(d) }, "Re-read with Claude")))))) : null,
    reviewPanel(recon),
    lastNotes.length ? h("div.card.section", h("h3", "Notes from the documents"), h("ul.notes", lastNotes.map((n) => h("li", n)))) : null,

    h("div.stats",
      stat("Items", loads.length), stat("Included", included.length),
      stat("Breaker spaces", included.reduce((a, l) => a + l.poles, 0)),
      stat("Home runs (ft)", Math.round([...circuitOf.values()].reduce((a, c) => a + c.ft, 0)))),

    loads.length ? groups.map((cat) => h("div.card.section",
      h("h3", CATS[cat]),
      h("div.table-wrap", { style: { maxHeight: "none" } }, h("table",
        h("tr", h("th", ""), h("th", "Equipment"), h("th", "Tag"), h("th", "Room"), h("th", "Volts"), h("th.num", "Amps"), h("th", "Breaker"),
          h("th", "Cable"), h("th", "Neutral"), h("th", "Connection"), h("th", "Disc."), h("th", "Circuit"), h("th", "")),
        loads.filter((l) => l.category === cat).map((l) => {
          const c = circuitOf.get(l.id);
          return h("tr", { style: l.include ? {} : { opacity: 0.5 } },
            h("td", h("input", { type: "checkbox", checked: !!l.include, title: "Include in estimate", onchange: (e) => patch(l, { include: e.target.checked }) })),
            h("td", h("input", { value: l.name, style: { width: "170px" }, onchange: (e) => patch(l, { name: e.target.value }) }),
              l.note ? h("div.muted", { style: { fontSize: ".72rem", maxWidth: "240px" } }, l.note) : null,
              l.source === "ai" ? h("div.muted", { style: { fontSize: ".72rem" } }, `From ${docs.find((d) => d.id === l.doc_id)?.filename || "document"}${l.page ? `, p.${l.page}` : ""}`) : null),
            h("td", h("input", { value: l.tag, style: { width: "80px" }, onchange: (e) => patch(l, { tag: e.target.value }) })),
            h("td", h("select", { style: { maxWidth: "150px" }, onchange: (e) => patch(l, { room_id: e.target.value ? Number(e.target.value) : null }) },
              h("option", { value: "" }, l.location ? `(${l.location}) not on plan` : "— not on plan —"),
              rooms.map((r) => h("option", { value: r.id, selected: r.id === l.room_id }, `${r.number} ${r.name}`)))),
            h("td", h("select", { onchange: (e) => patch(l, { volts: Number(e.target.value) }) }, [120, 208, 240].map((v) => h("option", { value: v, selected: l.volts === v }, `${v}V`)))),
            h("td.num", h("input", { type: "number", step: "0.1", value: l.amps, style: { width: "64px" }, onchange: (e) => patch(l, { amps: Number(e.target.value) }) })),
            h("td", h("select", { onchange: (e) => patch(l, { breaker: Number(e.target.value) }) }, BREAKERS.map((b) => h("option", { value: b, selected: l.breaker === b }, `${b}A ${l.poles}P`)))),
            h("td.muted", wireFor(l.breaker, l.poles, l.neutral)),
            h("td", l.poles === 2 ? h("input", { type: "checkbox", checked: !!l.neutral, onchange: (e) => patch(l, { neutral: e.target.checked }) }) : "—"),
            h("td", h("select", { onchange: (e) => patch(l, { connection: e.target.value }) },
              [["hardwired", "Hardwired"], ["receptacle", "Receptacle"]].map(([v, t]) => h("option", { value: v, selected: l.connection === v }, t)))),
            h("td", h("input", { type: "checkbox", checked: !!l.disconnect, onchange: (e) => patch(l, { disconnect: e.target.checked }) })),
            h("td.muted", c && l.include ? `${c.label || "?"} · ${Math.round(c.ft)} ft` : ""),
            h("td", h("button.small.danger", { onclick: async () => { await api(`/api/loads/${l.id}`, { method: "DELETE" }); await ctx.reload(); } }, "✕")));
        }))))) : h("div.empty", h("h2", "No equipment yet"), h("p", "Upload the appliance spec and the mechanical drawings, or add equipment by hand.")),
  ));
}

const stat = (l, v) => h("div.card.stat", h("div.v", String(v)), h("div.l", l));
