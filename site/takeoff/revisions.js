// Drawing revisions (Tony, 2026-11-09): compare a newer version of a sheet with the older one and merge them.
// The newer sheet is the one kept. Items only on the newer drawing (e.g. added lighting) are kept unless you drop them; items only
// on the older drawing (details the newer set lost) are carried over unless you drop them. Merging retires the older sheet:
// its takeoff is removed so nothing is counted twice, and the drawing stays viewable, marked "Replaced".
import { api, h, toast, loadPdf } from "./lib.js";

const norm = (s) => String(s || "").toUpperCase().replace(/\s+/g, "").replace(/[-_.]/g, "");

/** Sheets that share a sheet number across two uploads and haven't been merged yet: [{ new, old }]. */
export function revisionPairs(data) {
  const by = new Map();
  for (const s of data.sheets) { const k = norm(s.sheet_no); if (!k || s.replaced_by || s.kind === "superseded") continue; (by.get(k) || by.set(k, []).get(k)).push(s); }
  const pairs = [];
  for (const list of by.values()) {
    const plans = [...new Set(list.map((s) => s.plan_id))]; if (plans.length < 2) continue;
    const top = Math.max(...plans), nw = list.find((s) => s.plan_id === top);
    for (const o of list) if (o.plan_id !== top) pairs.push({ new: nw, old: o });
  }
  return pairs;
}
export const compareHref = (jobId, newId, oldId) => `#/job/${jobId}/compare/${newId}/${oldId}`;

/** Banner for the Plans page: sheets that look like two versions of the same drawing. */
export function revisionBanner(data) {
  const pairs = revisionPairs(data); if (!pairs.length) return null;
  const plan = (id) => data.plans.find((p) => p.id === id)?.filename || "upload";
  return h("div.warn.rev-banner", { style: { margin: "8px 12px", display: "flex", flexWrap: "wrap", gap: "6px 12px", alignItems: "center" } },
    h("b", pairs.length === 1 ? "This sheet is in two uploads:" : `${pairs.length} sheets are in two uploads:`),
    pairs.slice(0, 6).map((p) => h("a", { href: compareHref(data.job.id, p.new.id, p.old.id), title: `Older: ${plan(p.old.plan_id)} · Newer: ${plan(p.new.plan_id)}` }, `Compare ${p.new.sheet_no} →`)),
    pairs.length > 6 ? h("span.muted", `and ${pairs.length - 6} more`) : null,
    h("span.muted", "Until they're merged, both versions are counted."));
}

/** Sheet info: pick any other sheet as the older version (when the sheet numbers don't match). */
export function compareWithSelect(sheet, data) {
  if (sheet.replaced_by) {
    const nw = data.sheets.find((s) => s.id === sheet.replaced_by);
    return h("div.muted", { style: { fontSize: ".8rem", margin: "6px 0" } }, `Replaced by ${nw ? nw.sheet_no || "p" + nw.page : "a newer sheet"} (revision merged). Nothing on this sheet is counted.`);
  }
  const others = data.sheets.filter((s) => s.id !== sheet.id && !s.replaced_by && s.plan_id !== sheet.plan_id);
  if (!others.length) return null;
  const plan = (id) => data.plans.find((p) => p.id === id)?.filename || "";
  return h("label.muted", { style: { display: "block", fontSize: ".8rem", marginBottom: "6px" } }, "Older version of this sheet",
    h("select", { style: { width: "100%" }, onchange: (e) => { if (e.target.value) location.hash = compareHref(data.job.id, sheet.id, e.target.value); } },
      h("option", { value: "" }, "Compare with…"),
      others.map((s) => h("option", { value: s.id }, `${s.sheet_no || "p" + s.page} ${s.title || ""} · ${plan(s.plan_id)}`.trim()))));
}

/** The compare page: #/job/:id/compare/:newId/:oldId */
export async function renderCompare(app, ctx, newId, oldId) {
  app.replaceChildren(h("div.page", h("p.muted", "Comparing the two versions…")));
  let cmp;
  try { cmp = await api(`/api/sheets/${newId}/compare?old=${oldId}`); }
  catch (e) { app.replaceChildren(h("div.page", h("h1", "Compare revisions"), h("div.warn", e.message), h("a", { href: `#/job/${ctx.id}/plans` }, "← Back to plans"))); return; }
  const typeOf = Object.fromEntries(ctx.types.map((t) => [t.key, t]));
  const plan = (id) => ctx.data.plans.find((p) => p.id === id)?.filename || "";
  const name = (i) => i.kind === "device" ? typeOf[i.type]?.label || i.type : i.kind === "room" ? `Room ${i.label}` : i.kind === "tape" ? "LED tape run" : i.label;
  const color = (i) => i.kind === "device" ? typeOf[i.type]?.color || "#888" : "#888";
  const keepNew = new Map(cmp.only_new.map((i) => [i.kind + i.id, true]));   // true = keep (default)
  const carryOld = new Map(cmp.only_old.map((i) => [i.kind + i.id, true]));  // true = carry over (default)
  const has = (id) => ctx.data.devices.some((d) => d.sheet_id === id), oldAnalyzed = has(cmp.old.id), newAnalyzed = has(cmp.new.id);

  // ---- drawing: the newer sheet, the older one faintly on top (lined up), markers for differences
  const W = cmp.new.width || 3000, Hh = cmp.new.height || 2000;
  const stage = h("div", { style: { position: "relative", width: "100%", aspectRatio: `${W} / ${Hh}`, background: "#fff", border: "1px solid var(--line-strong)", borderRadius: "8px", overflow: "hidden" } });
  const cNew = h("canvas", { style: { position: "absolute", inset: 0, width: "100%", height: "100%" } });
  const t = cmp.transform, oldW = W / t.sx, oldH = Hh / t.sy;
  const cOld = h("canvas", { style: { position: "absolute", left: `${(t.dx / W) * 100}%`, top: `${(t.dy / Hh) * 100}%`, width: `${((oldW * t.sx) / W) * 100}%`, height: `${((oldH * t.sy) / Hh) * 100}%`, opacity: 0, mixBlendMode: "multiply", pointerEvents: "none", transition: "opacity .15s" } });
  const marks = h("div", { style: { position: "absolute", inset: 0 } });
  stage.append(cNew, cOld, marks);
  const paint = async (canvas, planId, page, w) => {
    try { const pg = await (await loadPdf(planId)).getPage(page); const scale = Math.min(2400 / w, 2); const vp = pg.getViewport({ scale });
      canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height); await pg.render({ canvas, viewport: vp }).promise; } catch (e) { console.error(e); }
  };
  paint(cNew, cmp.new.plan_id, cmp.new.page, W);
  let oldPainted = false;
  const showOld = h("input", { type: "checkbox", onchange: async (e) => { if (e.target.checked && !oldPainted) { oldPainted = true; await paint(cOld, cmp.old.plan_id, cmp.old.page, oldW); } cOld.style.opacity = e.target.checked ? ".45" : "0"; } });

  const markEls = new Map();
  const drawMarks = () => {
    marks.replaceChildren(); markEls.clear();
    const put = (i, isNew) => {
      if (i.x == null) return;
      const on = (isNew ? keepNew : carryOld).get(i.kind + i.id);
      const ring = isNew ? "#16a34a" : "#dc2626";
      const el = h("div", { title: `${isNew ? "Only on the newer drawing" : "Only on the older drawing"}: ${name(i)} (click to ${on ? "drop" : "keep"})`,
        style: { position: "absolute", left: `${(i.x / W) * 100}%`, top: `${(i.y / Hh) * 100}%`, width: "16px", height: "16px", margin: "-8px 0 0 -8px", borderRadius: "50%",
          border: `3px solid ${ring}`, background: on ? color(i) : "transparent", opacity: on ? 1 : 0.45, boxShadow: "0 0 0 2px #fff", cursor: "pointer" },
        onclick: () => { (isNew ? keepNew : carryOld).set(i.kind + i.id, !on); redraw(); } });
      markEls.set((isNew ? "n" : "o") + i.kind + i.id, el); marks.append(el);
    };
    cmp.only_new.forEach((i) => put(i, true)); cmp.only_old.forEach((i) => put(i, false));
  };
  const flash = (key, on) => { const el = markEls.get(key); if (el) { el.style.transform = on ? "scale(2.2)" : ""; el.style.zIndex = on ? 5 : ""; } };

  // ---- lists
  const listBox = h("div");
  const group = (title, help, items, map, isNew) => {
    const byLabel = new Map();
    for (const i of items) { const k = name(i); (byLabel.get(k) || byLabel.set(k, []).get(k)).push(i); }
    const all = (v) => { items.forEach((i) => map.set(i.kind + i.id, v)); redraw(); };
    return h("div.card.section", { style: { padding: "10px 12px" } },
      h("div.row", h("h3.grow", { style: { margin: 0, color: isNew ? "#16a34a" : "#dc2626" } }, `${title} (${items.length})`),
        items.length ? h("button.small", { onclick: () => all(true) }, isNew ? "Keep all" : "Carry all") : null,
        items.length ? h("button.small", { onclick: () => all(false) }, "Drop all") : null),
      h("p.muted", { style: { fontSize: ".8rem", margin: "4px 0 8px" } }, help),
      items.length ? [...byLabel.entries()].map(([label, list]) => h("div", { style: { marginBottom: "6px" } },
        h("div", { style: { fontSize: ".85rem", fontWeight: 600 } }, `${label} × ${list.length}`),
        h("div.row", { style: { flexWrap: "wrap", gap: "4px", marginTop: "3px" } }, list.map((i, n) => {
          const on = map.get(i.kind + i.id), key = (isNew ? "n" : "o") + i.kind + i.id;
          return h("label", { style: { fontSize: ".8rem", padding: "2px 7px", borderRadius: "12px", border: "1px solid var(--line-strong)", background: on ? "var(--accent-soft)" : "transparent", cursor: "pointer", textDecoration: on ? "none" : "line-through" },
            onmouseenter: () => flash(key, true), onmouseleave: () => flash(key, false) },
            h("input", { type: "checkbox", checked: on, style: { margin: "0 4px 0 0" }, onchange: (e) => { map.set(i.kind + i.id, e.target.checked); redraw(); } }), `#${n + 1}`);
        })))) : h("p.muted", { style: { margin: 0 } }, "Nothing."));
  };
  const counts = () => ({ keep: [...keepNew.values()].filter(Boolean).length, dropNew: [...keepNew.values()].filter((v) => !v).length,
    carry: [...carryOld.values()].filter(Boolean).length, dropOld: [...carryOld.values()].filter((v) => !v).length });
  const mergeBtn = h("button.primary", { onclick: async (e) => {
    const b = e.currentTarget;
    if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Click again to merge"; setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; summary(); } }, 4000); return; }
    b.disabled = true; b.textContent = "Merging…";
    try {
      const pick = (map, want) => [...map.entries()].filter(([, v]) => v === want).map(([k]) => ({ kind: k.replace(/\d+$/, ""), id: Number(k.match(/\d+$/)[0]) }));
      const r = await api(`/api/sheets/${cmp.new.id}/merge-revision`, { json: { old_id: cmp.old.id, carry: pick(carryOld, true), drop_new: pick(keepNew, false) } });
      toast(`Merged: ${r.carried} carried over, ${r.dropped} dropped. ${cmp.old.sheet_no || "The older sheet"} is no longer counted.`);
      ctx.focusNew?.(cmp.new.id); location.hash = `#/job/${ctx.id}/plans`;
    } catch (err) { toast(err.message, true); b.disabled = false; delete b.dataset.armed; summary(); }
  } });
  const summary = () => { const c = counts(); mergeBtn.textContent = `Merge: keep ${c.keep} new, carry ${c.carry} old${c.dropNew + c.dropOld ? `, drop ${c.dropNew + c.dropOld}` : ""}`; };
  const redraw = () => {
    drawMarks(); summary();
    listBox.replaceChildren(
      group("Only on the newer drawing", "Added in the revision. Kept unless you drop them.", cmp.only_new, keepNew, true),
      group("Only on the older drawing", "Missing from the revision. Carried over to the newer sheet unless you drop them.", cmp.only_old, carryOld, false));
  };
  redraw();

  const m = cmp.matched;
  app.replaceChildren(h("div.page",
    h("div.row", h("h1.grow", `Compare ${cmp.new.sheet_no || "sheet"} revisions`), h("a", { href: `#/job/${ctx.id}/plans` }, "← Back to plans")),
    h("p.muted", `Newer: ${cmp.new.sheet_no} ${cmp.new.title || ""} (${plan(cmp.new.plan_id)}) · Older: ${cmp.old.sheet_no} ${cmp.old.title || ""} (${plan(cmp.old.plan_id)})`),
    !oldAnalyzed || !newAnalyzed ? h("div.warn", `${!newAnalyzed ? "The newer" : "The older"} sheet has no devices yet, so there's nothing to compare it with. Analyze both sheets on the Plans page first, then come back.`) : null,
    h("div", { style: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) 360px", gap: "14px", alignItems: "start" } },
      h("div",
        h("div.row", { style: { gap: "14px", marginBottom: "6px", fontSize: ".85rem" } },
          h("span", h("span", { style: { color: "#16a34a", fontWeight: 700 } }, "●"), " only on newer"),
          h("span", h("span", { style: { color: "#dc2626", fontWeight: 700 } }, "●"), " only on older"),
          h("label", showOld, " Show the older drawing on top"),
          h("span.muted", `Same on both: ${m.devices} devices, ${m.rooms} rooms${m.equipment ? `, ${m.equipment} panels` : ""}${m.tape ? `, ${m.tape} tape runs` : ""}${t.pairs >= 3 && (Math.abs(t.dx) > 1 || Math.abs(t.dy) > 1) ? " · drawings lined up automatically" : ""}`)),
        stage),
      h("div", listBox,
        h("div.card", { style: { padding: "10px 12px" } },
          h("p.muted", { style: { fontSize: ".8rem", marginTop: 0 } }, `Merging keeps ${cmp.new.sheet_no || "the newer sheet"} and retires ${cmp.old.sheet_no || "the older sheet"}: its takeoff is removed so nothing is counted twice, and the drawing stays viewable. Re-run zoning afterwards if lights were carried over.`),
          h("div.row", { style: { justifyContent: "flex-end" } }, mergeBtn)))),
  ));
  summary();
}
