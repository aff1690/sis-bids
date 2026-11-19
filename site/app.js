// SIS Bids page: bids, catalog and settings. Plain modules, no build step.
const app = document.getElementById("app");
const show = (...kids) => app.replaceChildren(...kids.flat().filter(k => k != null && k !== false));
let ME = null, SET = null; // signed-in person; settings (cost codes, pay schedules, systems, lead numbers)

// ---------------------------------------------------------------- helpers
function h(tag, attrs, ...kids) {
  const [t, ...cls] = tag.split("."); const el = document.createElement(t || "div"); if (cls.length) el.className = cls.join(" ");
  if (attrs != null && (typeof attrs !== "object" || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = !!v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  const add = k => { if (k == null || k === false) return; if (Array.isArray(k)) return k.forEach(add); el.append(k instanceof Node ? k : String(k)); };
  kids.forEach(add); return el;
}
async function api(path, opts = {}) {
  const o = { method: opts.method || (opts.json ? "POST" : "GET"), headers: {} };
  if (opts.json) { o.body = JSON.stringify(opts.json); o.headers["Content-Type"] = "application/json"; }
  const r = await fetch(path, o); let b = null; try { b = await r.json(); } catch (e) {}
  if (!r.ok) throw new Error((b && b.error) || `Something went wrong (${r.status}).`);
  return b;
}
let toastT; function toast(msg, isBad) { const t = document.getElementById("toast"); t.textContent = msg; t.className = "show" + (isBad ? " bad" : ""); clearTimeout(toastT); toastT = setTimeout(() => t.className = "", isBad ? 6000 : 3000); }
const money = n => n == null || !isFinite(n) ? "—" : (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const KIND_LABEL = { product: "Product", labor: "Labor item", service: "Service item", package: "Package" };
// labor time: seconds <-> H:MM:SS. Accepts 1:30:00, 0:15 (h:mm), 15m, 90s, or decimal hours (0.25).
const fmtHms = s => { s = Math.round(s || 0); const hh = Math.floor(s / 3600), mm = Math.floor(s % 3600 / 60), ss = s % 60; return `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`; };
function parseHms(v) {
  const t = String(v || "").trim().toLowerCase(); if (!t) return 0;
  let m = t.match(/^(\d+):(\d{1,2}):(\d{1,2})$/); if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3];
  m = t.match(/^(\d+):(\d{1,2})$/); if (m) return +m[1] * 3600 + +m[2] * 60;
  m = t.match(/^(\d+(?:\.\d+)?)\s*(h|hr|hrs|m|min|s|sec)$/); if (m) return Math.round(+m[1] * ({ h: 3600, hr: 3600, hrs: 3600, m: 60, min: 60, s: 1, sec: 1 }[m[2]]));
  m = t.match(/^\d*\.?\d+$/); if (m) return Math.round(parseFloat(t) * 3600);
  return NaN;
}
const codeName = c => { const x = (SET.costCodes || []).find(k => k.code === c); return x ? `${x.code} ${x.name}` : c; };
const rateOf = (c, div) => { const x = (SET.costCodes || []).find(k => k.code === c); return x ? (x.rates || {})[div] || 0 : 0; };
const laborText = labor => (labor || []).map(l => `${fmtHms(l.seconds)} ${codeName(l.cost_code)}`).join(", ");
function dialog(build) { const d = h("dialog"); document.body.append(d); d.addEventListener("close", () => d.remove()); build(d); d.showModal(); return d; }
const field = (label, input, cls) => h("label" + (cls ? "." + cls : ""), label, input);

// tiny CSV reader (quotes, commas and newlines inside quotes, BOM)
function readCsv(text) {
  text = text.replace(/^﻿/, ""); const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ",") { row.push(cur); cur = ""; } else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cur); rows.push(row); row = []; cur = ""; } else cur += c; }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const head = (rows.shift() || []).map(s => s.trim());
  return rows.filter(r => r.some(x => x.trim())).map(r => Object.fromEntries(head.map((k, i) => [k, r[i] ?? ""])));
}

// ---------------------------------------------------------------- routes
async function route() {
  const [, sec = "bids", sub] = location.hash.replace(/^#\/?/, "#/").split("/");
  document.querySelectorAll("#nav a,.sis-set").forEach(a => a.classList.toggle("on", a.dataset.r === sec));
  try {
    if (sec === "settings") return await renderSettings(sub);
    if (sec === "bids") return sub && /^\d+$/.test(sub) ? await renderBid(+sub) : await renderBids();
    return await renderCatalog();
  } catch (e) { show(h("div.note.bad", e.message)); }
}
window.addEventListener("hashchange", route);

// ---------------------------------------------------------------- bids (B2a)
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false));
const STATUS_LABEL = { draft: "Draft", sent: "Sent", won: "Won", lost: "Lost" };
const DIV_LABEL = { EL: "Electrical", LV: "Low Voltage" };
const hrs = s => (s / 3600).toLocaleString("en-US", { maximumFractionDigits: 1 }) + " h";
const leadText = dv => SET.leads[dv] != null ? `${dv}-${String(SET.leads[dv]).padStart(4, "0")}` : "";
function sysOptions(extra) {
  const o = []; for (const s of SET.systems || []) { o.push(s.name); for (const sub of s.subs || []) o.push(`${s.name}: ${sub}`); }
  for (const x of extra || []) if (x && !o.includes(x)) o.push(x); return o;
}
// a small dialog that asks for one value; resolves with the text, or null on Cancel
function ask(title, label, value = "", opts = {}) {
  return new Promise(res => dialog(d => {
    const inp = opts.multi ? h("textarea", { rows: 8, placeholder: opts.placeholder || "" }) : h("input", { value, placeholder: opts.placeholder || "", style: { width: "100%" } });
    if (opts.multi) inp.value = value;
    let done = false; d.addEventListener("close", () => { if (!done) res(null); });
    d.append(h("form", { onsubmit: e => { e.preventDefault(); done = true; d.close(); res(inp.value); } },
      h("header", h("h2", title)), h("div.bd", h("label.fld", label, inp), opts.hint ? h("p.muted.small", opts.hint) : null),
      h("footer", h("button.btn", { type: "button", onclick: () => d.close() }, "Cancel"), h("button.btn.pri", opts.ok || "OK"))));
    setTimeout(() => inp.focus(), 30);
  }));
}

async function renderBids() {
  const d = await api("/api/bids");
  const rows = d.bids.map(b => { const t = b.totals || {}, j = b.job || {};
    return h("tr.click", { onclick: () => location.hash = "#/bids/" + b.id },
      h("td", h("b", j.no || "?"), h("div.muted.small", j.name || "(job not found)")),
      h("td", b.name || "Bid", h("span.muted.small", "  rev " + b.rev), b.active ? h("span.pill.package", { style: { marginLeft: "6px" } }, "Active") : null),
      h("td", h("span.pill.st-" + b.status, STATUS_LABEL[b.status] || b.status)),
      h("td", DIV_LABEL[b.div] || b.div),
      h("td.num", money(t.total)), h("td.num", hrs(t.laborSecs || 0)), h("td.num", t.lines || 0),
      h("td.muted.small", (b.updated_at || "").slice(0, 10)));
  });
  const noRates = !(SET.costCodes || []).some(c => c.rates && (c.rates.EL || c.rates.LV));
  show(h("div.row", h("h1.grow", "Bids"), h("button.btn.pri", { onclick: newBidDialog }, "+ New bid")),
    noRates ? h("div.note.warn", "No labor rates are set yet, so labor totals $0. Set them in ", h("a", { href: "#/settings" }, "Settings"), ".") : null,
    h("div.card", h("div.wrap", h("table",
      h("thead", h("tr", h("th", "Job"), h("th", "Bid"), h("th", "Status"), h("th", "Division"), h("th.num", "Total"), h("th.num", "Labor"), h("th.num", "Lines"), h("th", "Updated"))),
      h("tbody", rows.length ? rows : h("tr", h("td", { colspan: 8 }, h("span.muted", "No bids yet. Click + New bid to start one."))))))));
}

// a bid starts from a job: a new lead job (takes the next EL-/LV- lead number) or one that's already in SIS Tools
function newBidDialog() {
  dialog(d => {
    let mode = "new";
    const tabs = h("div.tabs"), pane = h("div"), foot = h("footer");
    const start = async jobId => { const r = await api("/api/bids", { json: { job_id: jobId } }); d.close(); location.hash = "#/bids/" + r.id; };
    const draw = () => {
      fill(tabs, h("button.tab" + (mode === "new" ? ".on" : ""), { type: "button", onclick: () => { mode = "new"; draw(); } }, "New lead job"),
        h("button.tab" + (mode === "job" ? ".on" : ""), { type: "button", onclick: () => { mode = "job"; draw(); } }, "Existing job"));
      if (mode === "new") {
        const f = { div: h("select", SET.divs.map(v => h("option", { value: v, disabled: SET.leads[v] == null }, DIV_LABEL[v] + (SET.leads[v] != null ? ` (gets ${leadText(v)})` : " (set its lead number in Settings)")))),
          name: h("input", { required: true, placeholder: "Smith Residence" }), addr: h("input"), contact: h("input"), phone: h("input") };
        const firstOk = SET.divs.find(v => SET.leads[v] != null); if (firstOk) f.div.value = firstOk;
        fill(pane, h("p.muted.small", "This makes the job in SIS Tools with the next lead number for its division, then opens a new bid on it. Lead numbers are never reused."),
          h("div.grid", field("Division *", f.div), field("Job name *", f.name), field("Address", f.addr, "span2"), field("Contact", f.contact), field("Phone", f.phone)));
        fill(foot, h("button.btn", { type: "button", onclick: () => d.close() }, "Cancel"), h("button.btn.pri", { type: "submit" }, "Create job and bid"));
        d._go = async () => { if (!firstOk) return toast("Set the lead numbers in Settings first.", true);
          const r = await api("/api/jobs", { json: Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value])) });
          SET = await api("/api/settings"); toast(`Job ${r.job.no} created`); await start(r.job.id); };
        setTimeout(() => f.name.focus(), 30);
      } else {
        const q = h("input", { type: "search", placeholder: "Search job number, lead number, name or address…", style: { width: "100%" } }), list = h("div.joblist");
        const load = async () => { const r = await api("/api/jobs?q=" + encodeURIComponent(q.value));
          fill(list, ...(r.jobs.length ? r.jobs.map(j => h("div.jobrow", { onclick: () => start(j.id).catch(e => toast(e.message, true)) },
            h("b", j.no || j.lead || "—"), h("span.grow", j.name, j.addr ? h("span.muted.small", "  " + j.addr) : null),
            h("span.muted.small", j.div), j.bids ? h("span.pill", j.bids + (j.bids === 1 ? " bid" : " bids")) : null)) : [h("div.muted", "No jobs match.")])); };
        let tm; q.addEventListener("input", () => { clearTimeout(tm); tm = setTimeout(load, 200); });
        fill(pane, q, list); load(); setTimeout(() => q.focus(), 30);
        fill(foot, h("button.btn", { type: "button", onclick: () => d.close() }, "Cancel"));
        d._go = null;
      }
    };
    d.append(h("form", { onsubmit: async e => { e.preventDefault(); if (d._go) try { await d._go(); } catch (er) { toast(er.message, true); } } },
      h("header", h("h2", "New bid")), h("div.bd", tabs, pane), foot));
    draw();
  });
}

const bidChannel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("sis-bids") : null;
let onTakeoffMsg = null; // set by the open bid page
if (bidChannel) bidChannel.addEventListener("message", e => { if (onTakeoffMsg && location.hash.startsWith("#/bids/")) onTakeoffMsg(e.data || {}); });
const BV = { id: 0, room: "all", view: "lines", sel: new Set(), qty: 1, sys: "" };
async function renderBid(id) {
  if (BV.id !== id) Object.assign(BV, { id, room: "all", view: "lines", sel: new Set(), qty: 1, sys: "" });
  let D = await api("/api/bids/" + id);
  const others = (await api("/api/bids?job=" + encodeURIComponent(D.bid.job_id))).bids;
  const job = D.job || { no: "?", name: "(job not found)" };
  const totalsBox = h("div.card.totals"), treeBox = h("div.card.tree"), mainBox = h("div.grow", { style: { minWidth: 0 } }), payBox = h("div");

  const reload = async () => { D = await api("/api/bids/" + id); BV.sel = new Set([...BV.sel].filter(x => D.lines.some(l => l.id === x))); drawAll(); };
  const run = async (fn, msg) => { try { const r = await fn(); if (msg) toast(typeof msg === "function" ? msg(r) : msg); await reload(); return r; } catch (e) { toast(e.message, true); } };
  const putBid = b => run(() => api("/api/bids/" + id, { method: "PUT", json: b }));
  const saveLine = (lid, b) => run(() => api("/api/lines/" + lid, { method: "PUT", json: b }));

  // takeoff (B2b): start one, pop it out in its own window, and keep the bid's rooms and counts in step with it
  const takeoffBox = h("div.card.tobox");
  let syncT = null, lastSync = null;
  const popOut = (hash) => { const w = window.open(`/takeoff/?bid=${id}#${hash || `/job/${D.bid.takeoff_id}/plans`}`, "sis-takeoff-" + D.bid.takeoff_id, "popup,width=1500,height=950"); if (w) w.focus(); else toast("Your browser blocked the pop-out window. Allow pop-ups for this site.", true); };
  const sync = async quiet => {
    if (!D.bid.takeoff_id) return;
    try { lastSync = await api(`/api/bids/${id}/takeoff-sync`, { json: {} }); if (!quiet) toast(`Takeoff synced: ${lastSync.devices} devices in ${lastSync.rooms} rooms`); await reload(); }
    catch (e) { lastSync = { error: e.message }; drawTakeoff(); if (!quiet) toast(e.message, true); }
  };
  onTakeoffMsg = m => { if (m.t === "takeoff" && D.bid.takeoff_id && (!m.job || m.job === D.bid.takeoff_id)) { clearTimeout(syncT); syncT = setTimeout(() => sync(true), 1200); } };
  const startTakeoff = async () => {
    try { const t = await api("/api/takeoff/jobs", { json: { name: `${job.no} ${job.name}`.trim(), address: job.addr || "" } });
      await api("/api/bids/" + id, { method: "PUT", json: { takeoff_id: t.id } }); D.bid.takeoff_id = t.id; drawTakeoff(); popOut(`/new/${t.id}`); }
    catch (e) { toast(e.message, true); }
  };
  const drawTakeoff = () => {
    if (!D.bid.takeoff_id) return fill(takeoffBox, h("div.row", h("b", "Takeoff"), h("span.muted.small.grow", "Load the plans, let Claude count the devices, and the rooms and counts land in this bid."),
      h("button.btn.pri", { onclick: startTakeoff }, "Start takeoff")));
    const s = lastSync, um = s && s.unmapped || [];
    fill(takeoffBox, h("div.row", h("b", "Takeoff"),
      h("span.muted.small.grow", s && !s.error ? `${s.devices} devices in ${s.rooms} rooms${s.pending ? `, ${s.pending} still to check on the plans` : ""}. Changes in the takeoff window update this bid by themselves.` : s && s.error ? s.error : "Linked. Changes in the takeoff window update this bid by themselves."),
      h("button.btn.pri", { onclick: () => popOut() }, "⧉ Pop out takeoff"), h("button.btn.sm", { onclick: () => sync(false) }, "Sync now")),
      um.length ? h("div.note.warn", { style: { margin: "10px 0 0" } }, `${um.length} device type${um.length > 1 ? "s aren't" : " isn't"} linked to a catalog item yet, so ${um.length > 1 ? "they come" : "it comes"} in at $0: ${um.map(x => x.label).join(", ")}. `,
        ME.settings ? h("a", { href: "#/settings/takeoff" }, "Link them in Settings") : "Ask an admin to link them in Settings.", ".") : null);
  };

  // rooms
  const kids = () => { const k = {}; for (const r of D.rooms) (k[r.parent_id || 0] ||= []).push(r); return k; };
  const roomById = () => Object.fromEntries(D.rooms.map(r => [r.id, r]));
  const roomPath = rid => { const m = roomById(); const out = []; let r = m[rid]; while (r) { out.unshift(r.name); r = m[r.parent_id]; } return out.join(" › ") || "Not in a room"; };
  const depthOf = rid => { const m = roomById(); let n = 0, r = m[rid]; while (r && r.parent_id) { n++; r = m[r.parent_id]; } return n; };
  const under = rid => { const k = kids(), out = new Set([rid]); const walk = x => (k[x] || []).forEach(c => { out.add(c.id); walk(c.id); }); walk(rid); return out; };
  const roomSell = rid => [...under(rid)].reduce((a, x) => a + ((D.totals.byRoom[String(x)] || {}).sell || 0), 0);
  const roomOptions = () => { const k = kids(), out = []; const walk = (pid, dep) => (k[pid] || []).forEach(r => { out.push(h("option", { value: r.id }, " ".repeat(dep) + r.name)); walk(r.id, dep + 1); }); walk(0, 0); return out; };

  const drawTotals = () => {
    const t = D.totals;
    fill(totalsBox, h("div.stats",
      h("div", h("b", money(t.equipSell)), "Equipment"), t.svcSell ? h("div", h("b", money(t.svcSell)), "Services") : null,
      h("div", h("b", money(t.laborSell)), `Labor · ${hrs(t.laborSecs)}`), h("div", h("b", money(t.tax)), `Tax ${D.bid.tax_pct || 0}% on materials`),
      h("div.big", h("b", money(t.total)), "Total"), h("div", h("b", money(t.cost)), "Equipment cost"), h("div", h("b", (t.margin || 0) + "%"), "Margin")),
      t.missingRate.length ? h("div.note.warn", { style: { margin: "10px 0 0" } }, `No ${DIV_LABEL[D.bid.div]} rate for ${t.missingRate.map(codeName).join(", ")}, so that labor counts as $0. Set it in `, h("a", { href: "#/settings" }, "Settings"), ".") : null);
    const steps = D.bid.pay_steps || [];
    fill(payBox, h("div.small", steps.length ? steps.map((s, i) => h("div.paystep", h("span.grow", `${i + 1}. ${s.label}`), h("span.muted", s.pct + "%"), h("b.num", money(r2c(t.total * s.pct / 100))))) : h("span.muted", "No milestones.")));
  };
  const r2c = n => Math.round(n * 100) / 100;

  const drawTree = () => {
    const k = kids(), sel = BV.room;
    const node = (label, key, amt, dep, extra) => h("div.tn" + (String(sel) === String(key) ? ".on" : ""), { style: { paddingLeft: 8 + dep * 16 + "px" }, onclick: () => { BV.room = key; BV.view = "lines"; drawAll(); } },
      h("span.grow", label), extra || null, h("span.muted.small", money(amt)));
    const rows = [node(h("b", "All rooms"), "all", D.totals.total - D.totals.tax, 0)];
    const walk = (pid, dep) => (k[pid] || []).forEach(r => { rows.push(node(r.name, r.id, roomSell(r.id), dep, r.src_key ? h("span.tomark", { title: "From the takeoff" }, "⧉") : null)); walk(r.id, dep + 1); }); walk(0, 0);
    if (D.lines.some(l => !l.room_id)) rows.push(node(h("i", "Not in a room"), "none", (D.totals.byRoom["0"] || {}).sell || 0, 0));
    const rid = typeof sel === "number" ? sel : null;
    const addRooms = async parent => {
      const v = await ask(parent ? `Add inside ${roomPath(parent)}` : "Add rooms", "Names, one per line", "", { multi: true, ok: "Add", placeholder: "Level 1\nLevel 2\nGarage", hint: "Rooms go three levels deep, for example Level 1 › Kitchen › Pantry. Paste a list to add many at once." });
      const names = (v || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean); if (!names.length) return;
      await run(() => api(`/api/bids/${id}/rooms`, { json: { parent_id: parent, names } }), names.length > 1 ? `${names.length} rooms added` : null);
    };
    fill(treeBox, h("header", h("h2", "Rooms")), h("div.bd", rows,
      h("div.row", { style: { marginTop: "10px" } },
        h("button.btn.sm", { onclick: () => addRooms(null) }, "+ Room"),
        rid && depthOf(rid) < 2 ? h("button.btn.sm", { onclick: () => addRooms(rid) }, "+ Inside") : null,
        rid ? h("button.btn.sm", { onclick: async () => { const v = await ask("Rename room", "Name", roomById()[rid].name, { ok: "Save" }); if (v && v.trim()) { const sk = roomById()[rid].src_key; await run(() => api("/api/rooms/" + rid, { method: "PUT", json: { name: v } })); if (sk && bidChannel) bidChannel.postMessage({ t: "bid", takeoff: D.bid.takeoff_id }); } } }, "Rename") : null,
        rid ? h("button.btn.sm.danger", { onclick: () => { const n = under(rid).size - 1, l = D.lines.filter(x => under(rid).has(x.room_id)).length;
          if (!confirm(`Delete ${roomPath(rid)}${n ? ` and its ${n} room${n > 1 ? "s" : ""} inside` : ""}${l ? `, with ${l} line${l > 1 ? "s" : ""}` : ""}?`)) return;
          BV.room = "all"; run(() => api("/api/rooms/" + rid, { method: "DELETE" })); } }, "Delete") : null)));
  };

  // lines
  const lineMoney = l => {
    const secs = (l.labor || []).reduce((a, x) => a + x.seconds, 0) * l.qty;
    const lab = l.kind === "labor" && l.unit_price != null ? l.qty * l.unit_price : (l.labor || []).reduce((a, x) => a + x.seconds / 3600 * rateOf(x.cost_code, D.bid.div), 0) * l.qty;
    return { secs, lab, ext: l.kind === "labor" ? 0 : l.qty * (l.unit_price || 0) };
  };
  const visible = () => BV.room === "all" ? D.lines : BV.room === "none" ? D.lines.filter(l => !l.room_id) : D.lines.filter(l => under(BV.room).has(l.room_id));

  const addBar = () => {
    const q = h("input", { type: "search", placeholder: "Search the catalog to add an item…" }), drop = h("div.list", { hidden: true });
    const qty = h("input", { type: "number", step: "any", min: "0", value: BV.qty, style: { width: "80px" }, title: "Quantity", onchange: e => BV.qty = parseFloat(e.target.value) || 1 });
    const sys = h("input", { list: "bidsys", value: BV.sys, placeholder: "System (or the item's own)", style: { width: "210px" }, onchange: e => BV.sys = e.target.value });
    const add = async it => { q.value = ""; drop.hidden = true;
      const room = typeof BV.room === "number" ? BV.room : null;
      await run(() => api(`/api/bids/${id}/lines`, { json: { items: [{ item_id: it.id, qty: BV.qty, room_id: room, system: BV.sys }] } }), `Added ${[it.manufacturer, it.model].filter(Boolean).join(" ")}`); };
    let tm, hits = []; q.addEventListener("input", () => { clearTimeout(tm); tm = setTimeout(async () => {
      if (!q.value.trim()) { drop.hidden = true; return; }
      hits = (await api(`/api/catalog?q=${encodeURIComponent(q.value)}&limit=15`)).items;
      fill(drop, ...(hits.length ? hits.map(it => h("div", { onmousedown: e => { e.preventDefault(); add(it); } },
        h("span.pill." + it.kind, KIND_LABEL[it.kind]), " ", h("b", [it.manufacturer, it.model].filter(Boolean).join(" ")), it.short_desc ? h("span.muted.small", "  " + it.short_desc.slice(0, 80)) : null)) : [h("div.muted", "No matches")]));
      drop.hidden = false; }, 200); });
    q.addEventListener("keydown", e => { if (e.key === "Enter" && hits.length && !drop.hidden) { e.preventDefault(); add(hits[0]); } });
    q.addEventListener("blur", () => setTimeout(() => drop.hidden = true, 150));
    const where = typeof BV.room === "number" ? roomPath(BV.room) : null;
    return h("div.card", h("div.bd",
      h("div.row", h("div.picker.grow", { style: { minWidth: "240px" } }, q, drop), qty, sys,
        h("datalist", { id: "bidsys" }, sysOptions(D.lines.map(l => l.system)).map(v => h("option", { value: v })))),
      h("div.muted.small", { style: { marginTop: "6px" } }, where ? `Adds to ${where}.` : D.rooms.length ? "Pick a room on the left first, or the item goes in Not in a room." : "Add rooms on the left, then add items to them.")));
  };

  const bulkBar = () => {
    if (!BV.sel.size) return null; const ids = [...BV.sel];
    const mv = h("select", { onchange: e => { if (e.target.value) run(() => api(`/api/bids/${id}/lines/bulk`, { json: { ids, room_id: e.target.value === "none" ? null : +e.target.value } }), "Moved"); } },
      h("option", { value: "" }, "Move to room…"), h("option", { value: "none" }, "Not in a room"), roomOptions());
    const cp = h("select", { onchange: e => { if (e.target.value) run(() => api(`/api/bids/${id}/lines/bulk`, { json: { ids, copy_to_rooms: [e.target.value === "none" ? null : +e.target.value] } }), "Copied"); } },
      h("option", { value: "" }, "Copy to room…"), roomOptions());
    return h("div.note.bulk", h("div.row", h("b", `${ids.length} selected`), mv, cp,
      h("button.btn.sm", { onclick: async () => { const v = await ask("Set system", "System", "", { ok: "Set" }); if (v != null) run(() => api(`/api/bids/${id}/lines/bulk`, { json: { ids, system: v } }), "System set"); } }, "Set system"),
      h("button.btn.sm.danger", { onclick: () => { if (confirm(`Delete ${ids.length} line${ids.length > 1 ? "s" : ""}?`)) { BV.sel.clear(); run(() => api(`/api/bids/${id}/lines/bulk`, { json: { ids, delete: true } }), "Deleted"); } } }, "Delete"),
      h("button.btn.sm", { onclick: () => { BV.sel.clear(); drawMain(); } }, "Clear")));
  };

  const linesTable = () => {
    const ls = visible(), showRoom = BV.room === "all" || (typeof BV.room === "number" && under(BV.room).size > 1);
    const groups = {}; for (const l of ls) (groups[l.system || ""] ||= []).push(l);
    const cols = showRoom ? 11 : 10, body = [];
    const allBox = h("input", { type: "checkbox", title: "Select all", checked: ls.length && ls.every(l => BV.sel.has(l.id)), onchange: e => { ls.forEach(l => e.target.checked ? BV.sel.add(l.id) : BV.sel.delete(l.id)); drawMain(); } });
    for (const g of Object.keys(groups).sort((a, b) => (a === "") - (b === "") || a.localeCompare(b))) {
      const gl = groups[g], gt = gl.reduce((a, l) => { const m = lineMoney(l); a.ext += m.ext; a.lab += m.lab; a.secs += m.secs; return a; }, { ext: 0, lab: 0, secs: 0 });
      body.push(h("tr.grp", h("td", { colspan: cols - 4 }, g || "No system"), h("td.num", money(gt.ext)), h("td.num.small", fmtHms(gt.secs)), h("td.num", money(gt.lab)), h("td")));
      for (const l of gl) {
        const m = lineMoney(l);
        const price = l.kind === "labor" && l.unit_price == null ? h("span.muted.small", "at rate")
          : h("input.price", { type: "number", step: "0.01", min: "0", value: (+(l.unit_price || 0)).toFixed(2), onchange: e => saveLine(l.id, { unit_price: e.target.value }) });
        body.push(h("tr",
          h("td", h("input", { type: "checkbox", checked: BV.sel.has(l.id), onchange: e => { e.target.checked ? BV.sel.add(l.id) : BV.sel.delete(l.id); drawMain(); } })),
          h("td", h("input.qty", { type: "number", step: "any", min: "0", value: l.qty, onchange: e => saveLine(l.id, { qty: e.target.value }) })),
          h("td", h("span.pill." + l.kind, KIND_LABEL[l.kind]), " ", l.source === "takeoff" ? h("span.pill.to", { title: "Counted on the plans; the quantity follows the takeoff" }, "Takeoff") : null, " ", h("b", [l.manufacturer, l.model].filter(Boolean).join(" ")),
            l.description ? h("div.desc", l.description) : null,
            l.contents.length ? h("details.small", h("summary.muted", `${l.contents.length} part${l.contents.length > 1 ? "s" : ""}`), l.contents.map(c => h("div", `${c.qty} × ${[c.manufacturer, c.model].filter(Boolean).join(" ")}`))) : null),
          showRoom ? h("td.small", roomPath(l.room_id)) : null,
          h("td.small", h("input.sysin", { list: "bidsys", value: l.system || "", placeholder: "—", onchange: e => saveLine(l.id, { system: e.target.value }) })),
          h("td.num", money(l.unit_cost)), h("td.num", price), h("td.num", money(m.ext)),
          h("td.num.small", fmtHms(m.secs), l.labor.length ? h("div.muted", l.labor.map(x => x.cost_code).join(", ")) : null), h("td.num", money(m.lab)),
          h("td", h("button.btn.sm.danger", { title: "Remove this line", onclick: () => run(() => api("/api/lines/" + l.id, { method: "DELETE" })) }, "×"))));
      }
    }
    return h("div.card", h("div.wrap", h("table.lines",
      h("thead", h("tr", h("th", allBox), h("th", "Qty"), h("th", "Item"), showRoom ? h("th", "Room") : null, h("th", "System"), h("th.num", "Unit cost"), h("th.num", "Unit sell"),
        h("th.num", "Ext sell"), h("th.num", "Labor"), h("th.num", "Labor $"), h("th"))),
      h("tbody", body.length ? body : h("tr", h("td", { colspan: cols }, h("span.muted", "No items here yet. Search the catalog above to add some.")))))));
  };

  const summary = () => {
    const t = D.totals;
    if (BV.view === "system") {
      const rows = Object.entries(t.bySystem).sort((a, b) => b[1].sell - a[1].sell);
      return h("div.card", h("div.wrap", h("table", h("thead", h("tr", h("th", "System"), h("th.num", "Sell incl. labor"), h("th.num", "Labor"), h("th.num", "Labor hours"), h("th.num", "Equipment cost"))),
        h("tbody", rows.map(([k, v]) => h("tr", h("td", k || h("i.muted", "No system")), h("td.num", money(v.sell)), h("td.num", money(v.labor)), h("td.num", hrs(v.secs)), h("td.num", money(v.cost))))))));
    }
    if (BV.view === "code") {
      const rows = Object.entries(t.byCode).sort((a, b) => a[0].localeCompare(b[0]));
      return h("div.card", h("div.wrap", h("table", h("thead", h("tr", h("th", "Cost code"), h("th.num", "Hours"), h("th.num", "H:M:S"), h("th.num", `${DIV_LABEL[D.bid.div]} rate`), h("th.num", "Labor $"))),
        h("tbody", rows.map(([c, v]) => h("tr", h("td", codeName(c) || h("i.muted", "No code")), h("td.num", (v.secs / 3600).toFixed(2)), h("td.num", fmtHms(v.secs)), h("td.num", money(rateOf(c, D.bid.div))), h("td.num", money(v.labor)))),
          h("tr.grp", h("td", "Total"), h("td.num", (t.laborSecs / 3600).toFixed(2)), h("td.num", fmtHms(t.laborSecs)), h("td"), h("td.num", money(t.laborSell)))))));
    }
    const k = kids(), rows = []; const walk = (pid, dep) => (k[pid] || []).forEach(r => { const own = t.byRoom[String(r.id)] || {};
      rows.push(h("tr", h("td", { style: { paddingLeft: 9 + dep * 18 + "px" } }, r.name), h("td.num", money(roomSell(r.id))), h("td.num", money(own.sell || 0)), h("td.num", hrs([...under(r.id)].reduce((a, x) => a + ((t.byRoom[String(x)] || {}).secs || 0), 0))))); walk(r.id, dep + 1); });
    walk(0, 0); if (t.byRoom["0"]) rows.push(h("tr", h("td", h("i", "Not in a room")), h("td.num", money(t.byRoom["0"].sell)), h("td.num", money(t.byRoom["0"].sell)), h("td.num", hrs(t.byRoom["0"].secs))));
    return h("div.card", h("div.wrap", h("table", h("thead", h("tr", h("th", "Room"), h("th.num", "Sell incl. rooms inside"), h("th.num", "This room only"), h("th.num", "Labor hours"))), h("tbody", rows))));
  };

  const drawMain = () => {
    const vt = (k, label) => h("button.tab" + (BV.view === k ? ".on" : ""), { onclick: () => { BV.view = k; drawMain(); } }, label);
    fill(mainBox, h("div.tabs", vt("lines", "Items"), vt("room", "By room"), vt("system", "By system"), vt("code", "By cost code")),
      BV.view === "lines" ? [addBar(), bulkBar(), linesTable()] : summary());
  };
  const drawAll = () => { drawTotals(); drawTree(); drawMain(); drawTakeoff(); };

  // the bid's own settings
  const nm = h("input", { value: D.bid.name, onchange: e => putBid({ name: e.target.value }) });
  const rev = h("select", { onchange: e => location.hash = "#/bids/" + e.target.value }, others.map(b => h("option", { value: b.id, selected: b.id === id }, `Rev ${b.rev} · ${b.name || "Bid"}${b.active ? " (active)" : ""}`)));
  const st = h("select", { onchange: e => putBid({ status: e.target.value }) }, Object.entries(STATUS_LABEL).map(([k, v]) => h("option", { value: k, selected: D.bid.status === k }, v)));
  const dv = h("select", { onchange: e => putBid({ div: e.target.value }) }, SET.divs.map(v => h("option", { value: v, selected: D.bid.div === v }, DIV_LABEL[v])));
  const tax = h("input", { type: "number", step: "0.001", min: "0", max: "30", value: D.bid.tax_pct || 0, onchange: e => putBid({ tax_pct: e.target.value }) });
  const mg = h("input", { type: "number", step: "0.1", min: "0", max: "95", value: D.bid.margin_pct ?? "", placeholder: "Catalog prices", onchange: e => putBid({ margin_pct: e.target.value }) });
  const pay = h("select", { onchange: e => putBid({ pay_id: e.target.value }) }, (SET.paySchedules || []).map(p => h("option", { value: p.id, selected: D.bid.pay_id === p.id }, p.name)));
  const editSteps = () => dialog(d => {
    const steps = (D.bid.pay_steps || []).map(s => ({ ...s })), box = h("div");
    const draw = () => fill(box, ...steps.map((s, i) => h("div.lab-row", h("input", { value: s.label, style: { flex: 1 }, onchange: e => s.label = e.target.value }),
      h("input", { type: "number", step: "any", value: s.pct, style: { width: "90px" }, onchange: e => s.pct = parseFloat(e.target.value) || 0 }), "%",
      h("button.btn.sm.danger", { type: "button", onclick: () => { steps.splice(i, 1); draw(); } }, "Remove"))), h("button.btn.sm", { type: "button", onclick: () => { steps.push({ label: "", pct: 0 }); draw(); } }, "+ Milestone"));
    draw();
    d.append(h("form", { onsubmit: async e => { e.preventDefault(); try { await api("/api/bids/" + id, { method: "PUT", json: { pay_steps: steps } }); d.close(); await reload(); } catch (er) { toast(er.message, true); } } },
      h("header", h("h2", "Payment milestones for this bid")), h("div.bd", h("p.muted.small", "Changes here apply to this bid only. Milestones must total 100%."), box),
      h("footer", h("button.btn", { type: "button", onclick: () => d.close() }, "Cancel"), h("button.btn.pri", "Save"))));
  });

  show(
    h("div.row", h("a.btn.sm", { href: "#/bids" }, "← Bids"), h("h1.grow", { style: { margin: "4px 0" } }, `${job.no} · ${job.name}`),
      D.bid.active ? h("span.pill.package", "Active bid") : h("button.btn.sm", { onclick: () => putBid({ active: true }) }, "Make this the active bid"),
      h("button.btn.sm", { onclick: () => run(() => api("/api/bids", { json: { job_id: D.bid.job_id, copy_from: id, name: D.bid.name } }), "New revision made").then(r => { if (r) location.hash = "#/bids/" + r.id; }) }, "New revision"),
      h("button.btn.sm.danger", { onclick: async () => { if (!confirm(`Delete rev ${D.bid.rev} (${D.bid.name}) and everything in it?`)) return; try { await api("/api/bids/" + id, { method: "DELETE" }); location.hash = "#/bids"; } catch (e) { toast(e.message, true); } } }, "Delete bid")),
    job.addr || job.contact ? h("div.muted.small", { style: { margin: "0 0 10px" } }, [job.addr, job.contact].filter(Boolean).join(" · ")) : null,
    h("div.bidtop",
      h("div.card", h("div.bd", h("div.grid.bidset", field("Bid name", nm), field("Revision", rev), field("Status", st), field("Division (sets labor rates)", dv),
        field("Tax % on materials", tax), field("Margin % for unpriced items", mg)),
        h("div.row", { style: { marginTop: "12px" } },
          h("button.btn.sm", { title: "Pull current catalog cost, sell and labor into every line", onclick: () => { if (confirm("Pull current catalog prices and labor into every line that came from the catalog? Prices you typed in are replaced.")) run(() => api(`/api/bids/${id}/refresh`, { json: {} }), r => `${r.updated} lines updated`); } }, "Update prices from catalog"),
          h("button.btn.sm", { disabled: D.bid.margin_pct == null, title: "Set every product and package to cost at this margin", onclick: () => { if (confirm(`Price every product and package at ${D.bid.margin_pct}% margin on cost?`)) run(() => api(`/api/bids/${id}/refresh`, { json: { at_margin: true } }), r => `${r.updated} lines repriced`); } }, "Apply margin to every line")))),
      h("div.card", h("header", h("h2", "Payment schedule"), h("button.btn.sm", { onclick: editSteps }, "Edit for this bid")), h("div.bd", pay, payBox))),
    takeoffBox, totalsBox,
    h("div.bidgrid", treeBox, mainBox));
  drawAll();
  if (D.bid.takeoff_id) sync(true); // pick up anything counted since the bid was last open
}

// ---------------------------------------------------------------- catalog
const CAT = { q: "", kind: "", cat: null, offset: 0, limit: 100 };
async function renderCatalog() {
  const d = await api(`/api/catalog?q=${encodeURIComponent(CAT.q)}&kind=${CAT.kind}&limit=${CAT.limit}&offset=${CAT.offset}${CAT.cat != null ? "&cat=" + encodeURIComponent(CAT.cat) : ""}`);
  const total = Object.values(d.counts).reduce((a, b) => a + b, 0);
  const search = h("input", { type: "search", placeholder: "Search manufacturer, model, part #, description, vendor…", value: CAT.q, style: { flex: "1", minWidth: "220px" } });
  let tm; search.addEventListener("input", () => { clearTimeout(tm); tm = setTimeout(() => { CAT.q = search.value; CAT.offset = 0; renderCatalog().then(() => { const s = app.querySelector("input[type=search]"); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }); }, 250); });
  const tab = (k, label) => h("button.tab" + (CAT.kind === k ? ".on" : ""), { onclick: () => { CAT.kind = k; CAT.offset = 0; renderCatalog(); } }, label, h("span.n", k ? d.counts[k] || 0 : total));
  const file = h("input", { type: "file", accept: ".csv,text/csv", hidden: true, onchange: e => { const f = e.target.files[0]; e.target.value = ""; if (f) importDialog(f); } });
  const catN = Object.fromEntries(d.cats.map(c => [c.category, c.n]));
  const catSel = h("select", { onchange: e => { CAT.cat = e.target.value === "__all__" ? null : e.target.value; CAT.offset = 0; renderCatalog(); } },
    h("option", { value: "__all__" }, "All categories"), d.cats.map(c => h("option", { value: c.category, selected: CAT.cat === c.category }, `${c.category || "No category"} (${c.n})`)));
  if (CAT.cat != null && !d.cats.some(c => c.category === CAT.cat)) catSel.append(h("option", { value: CAT.cat, selected: true }, CAT.cat || "No category"));
  let lastCat = null; const rows = [];
  d.items.forEach(it => { const c = it.category || ""; if (c !== lastCat) { lastCat = c; rows.push(h("tr.grp", h("td", { colspan: 8 }, c || "No category", h("span.muted", { style: { fontWeight: 500, marginLeft: "8px" } }, `${catN[c] || 0} item${catN[c] === 1 ? "" : "s"}`)))); } rows.push(itemRow(it)); });
  function itemRow(it) {
    const price = it.kind === "package" ? it.rollup && it.rollup.price : it.unit_price;
    const cost = it.kind === "package" ? it.rollup && it.rollup.cost : it.unit_cost;
    const lab = it.kind === "package" ? Object.entries((it.rollup || {}).labor || {}).map(([c, s]) => ({ cost_code: c, seconds: s })) : it.labor;
    return h("tr.click", { onclick: () => editItem(it.id) },
      h("td", h("span.pill." + it.kind, KIND_LABEL[it.kind])),
      h("td", h("b", [it.manufacturer, it.model].filter(Boolean).join(" ")), it.part_number ? h("div.muted.small", "#" + it.part_number) : null),
      h("td", h("div.desc", it.short_desc || "")),
      h("td.muted.small", it.subcategory || ""),
      h("td.num", money(cost)), h("td.num", price == null ? h("span.muted", "at rate") : money(price)),
      h("td.small", laborText(lab)), h("td.muted.small", it.vendor || ""));
  }
  const pages = Math.ceil(d.total / CAT.limit), pg = Math.floor(CAT.offset / CAT.limit) + 1;
  show(
    h("div.row", h("h1.grow", "Catalog"),
      h("button.btn", { onclick: () => editItem(0, "product") }, "+ Product"),
      h("button.btn", { onclick: () => editItem(0, "labor") }, "+ Labor item"),
      h("button.btn", { onclick: () => editItem(0, "service") }, "+ Service item"),
      h("button.btn", { onclick: () => editItem(0, "package") }, "+ Package"),
      h("button.btn.pri", { onclick: () => file.click() }, "Import D-Tools catalog"), file),
    !total ? h("div.note.warn", "The catalog is empty. Export your catalog from D-Tools SI (Product Explorer, export to CSV) and click Import D-Tools catalog. Old D-Tools labor codes are converted to your cost codes as they come in.") : null,
    h("div.tabs", tab("", "All"), tab("product", "Products"), tab("labor", "Labor items"), tab("service", "Service items"), tab("package", "Packages")),
    h("div.row", { style: { marginBottom: "10px" } }, search, catSel),
    h("div.card", h("div.wrap", { style: { maxHeight: "calc(100vh - 290px)" } }, h("table",
      h("thead", h("tr", h("th", "Type"), h("th", "Item"), h("th", "Description"), h("th", "Subcategory"), h("th.num", "Cost"), h("th.num", "Sell"), h("th", "Labor (H:M:S)"), h("th", "Vendor"))),
      h("tbody", rows.length ? rows : h("tr", h("td", { colspan: 8 }, h("span.muted", CAT.q ? "Nothing matches that search." : "Nothing here yet."))))))),
    pages > 1 ? h("div.row", h("span.muted.small", `${d.total.toLocaleString()} items · page ${pg} of ${pages}`), h("span.grow"),
      h("button.btn.sm", { disabled: pg <= 1, onclick: () => { CAT.offset -= CAT.limit; renderCatalog(); } }, "Previous"),
      h("button.btn.sm", { disabled: pg >= pages, onclick: () => { CAT.offset += CAT.limit; renderCatalog(); } }, "Next")) : null);
}

// labor lines editor: [{cost_code, seconds}]
function laborEditor(lines, onChange) {
  const box = h("div");
  const codes = (SET.costCodes || []).filter(c => !c.retired);
  const draw = () => {
    box.replaceChildren(...lines.map((l, i) => {
      const t = h("input.hms", { value: fmtHms(l.seconds), placeholder: "0:15:00", title: "H:MM:SS, or decimal hours like 0.25" });
      t.addEventListener("change", () => { const s = parseHms(t.value); if (isNaN(s)) { toast("Enter time as H:MM:SS, for example 0:15:00.", true); t.value = fmtHms(l.seconds); return; } l.seconds = s; t.value = fmtHms(s); onChange && onChange(); });
      const sel = h("select", { onchange: e => { l.cost_code = e.target.value; onChange && onChange(); } }, h("option", { value: "" }, "Cost code…"),
        codes.map(c => h("option", { value: c.code, selected: c.code === l.cost_code }, `${c.code} ${c.name}`)),
        l.cost_code && !codes.some(c => c.code === l.cost_code) ? h("option", { value: l.cost_code, selected: true }, `${l.cost_code} (retired)`) : null);
      return h("div.lab-row", t, sel, h("button.btn.sm.danger", { type: "button", onclick: () => { lines.splice(i, 1); draw(); onChange && onChange(); } }, "Remove"));
    }), h("button.btn.sm", { type: "button", onclick: () => { lines.push({ cost_code: "", seconds: 0 }); draw(); } }, "+ Labor line"));
  };
  draw(); return box;
}

// package contents editor with a catalog search to add parts
function packageEditor(items, onChange) {
  const box = h("div"), list = h("div"), sum = h("div.stats", { style: { margin: "8px 0" } });
  const recalc = async () => {
    const ids = items.map(x => x.item_id); if (!ids.length) { sum.replaceChildren(h("span.muted", "Add parts below.")); return; }
    try { const r = await api("/api/catalog/rollup", { json: { ids } }); let cost = 0, price = 0, lab = {}; const noPrice = [];
      for (const x of items) { const ru = r.rollup[x.item_id] || {}; cost += x.qty * (ru.cost || 0); if (ru.price == null) noPrice.push(x); else price += x.qty * ru.price; for (const [c, s] of Object.entries(ru.labor || {})) lab[c] = (lab[c] || 0) + x.qty * s; }
      sum.replaceChildren(h("div", h("b", money(cost)), "Cost"), h("div", h("b", money(price)), "Sell (parts)"), h("div", h("b", fmtHms(Object.values(lab).reduce((a, b) => a + b, 0))), "Labor"),
        h("div.small.muted", { style: { alignSelf: "center" } }, Object.entries(lab).map(([c, s]) => `${fmtHms(s)} ${codeName(c)}`).join(" · ")));
    } catch (e) { sum.replaceChildren(h("span.muted", e.message)); }
  };
  const draw = () => {
    list.replaceChildren(h("table", h("thead", h("tr", h("th", "Qty"), h("th", "Part"), h("th"))),
      h("tbody", items.map((x, i) => h("tr",
        h("td", { style: { width: "110px" } }, h("input", { type: "number", step: "any", min: "0", value: x.qty, style: { width: "90px" }, onchange: e => { x.qty = Math.max(0, parseFloat(e.target.value) || 0); onChange && onChange(); recalc(); } })),
        h("td", h("span.pill." + (x.kind || "product"), KIND_LABEL[x.kind || "product"]), " ", [x.manufacturer, x.model].filter(Boolean).join(" ")),
        h("td.num", h("button.btn.sm.danger", { type: "button", onclick: () => { items.splice(i, 1); draw(); onChange && onChange(); recalc(); } }, "Remove")))))));
  };
  const q = h("input", { type: "search", placeholder: "Search the catalog to add a part…", style: { width: "100%" } }), drop = h("div.list", { hidden: true });
  let tm; q.addEventListener("input", () => { clearTimeout(tm); tm = setTimeout(async () => {
    if (!q.value.trim()) { drop.hidden = true; return; }
    const r = await api(`/api/catalog?q=${encodeURIComponent(q.value)}&limit=15`);
    drop.replaceChildren(...r.items.map(it => h("div", { onclick: () => { items.push({ item_id: it.id, qty: 1, kind: it.kind, manufacturer: it.manufacturer, model: it.model }); q.value = ""; drop.hidden = true; draw(); onChange && onChange(); recalc(); } },
      h("span.pill." + it.kind, KIND_LABEL[it.kind]), " ", h("b", [it.manufacturer, it.model].filter(Boolean).join(" ")), it.part_number ? h("span.muted", "  #" + it.part_number) : null)));
    if (!r.items.length) drop.replaceChildren(h("div.muted", "No matches")); drop.hidden = false; }, 200); });
  q.addEventListener("blur", () => setTimeout(() => drop.hidden = true, 200));
  draw(); recalc();
  box.append(list, h("div.picker", { style: { marginTop: "8px" } }, q, drop), sum);
  return box;
}

async function editItem(id, kind) {
  const it = id ? (await api(`/api/catalog/${id}`)).item : { kind, manufacturer: "", model: "", labor: [], items: [], taxable: kind === "product", unit_price: kind === "labor" ? null : 0, unit_cost: 0, order_units: 1, extra: {} };
  kind = it.kind;
  const f = {}, inp = (k, attrs = {}) => (f[k] = h("input", { value: it[k] ?? "", ...attrs }));
  const labor = (it.labor || []).map(l => ({ ...l })), items = (it.items || []).map(x => ({ ...x }));
  if (kind === "labor" && !labor.length) labor.push({ cost_code: "", seconds: 3600 });
  const sysOpts = [];
  for (const s of SET.systems || []) { sysOpts.push(s.name); for (const sub of s.subs || []) sysOpts.push(`${s.name}: ${sub}`); }
  const sysList = h("datalist", { id: "syslist" }, sysOpts.map(v => h("option", { value: v })));
  const nameLabel = kind === "product" ? "Model *" : "Name *";
  const priceHint = kind === "labor" ? "Leave Unit sell empty to sell at the cost code's rate" : "";
  dialog(d => {
    const save = async e => {
      e.preventDefault();
      const b = { kind };
      for (const [k, el] of Object.entries(f)) b[k] = el.type === "checkbox" ? el.checked : el.value;
      if ("unit_price" in b && b.unit_price === "") b.unit_price = null;
      if (kind !== "package") { if (labor.some(l => l.seconds && !l.cost_code)) return toast("Pick a cost code for every labor line.", true); b.labor = labor.filter(l => l.cost_code && l.seconds); }
      if (kind === "labor" || kind === "service") b.cost_code = (b.labor[0] || {}).cost_code || "";
      if (kind === "package") b.items = items.map(x => ({ item_id: x.item_id, qty: x.qty }));
      try { await api(id ? `/api/catalog/${id}` : "/api/catalog", { method: id ? "PUT" : "POST", json: b }); d.close(); toast("Saved."); renderCatalog(); } catch (err) { toast(err.message, true); }
    };
    const del = async () => { if (!confirm("Delete this item from the catalog?")) return; try { await api(`/api/catalog/${id}`, { method: "DELETE" }); d.close(); toast("Deleted."); renderCatalog(); } catch (err) { toast(err.message, true); } };
    d.append(h("form", { onsubmit: save },
      h("header", h("h2", (id ? "Edit " : "New ") + KIND_LABEL[kind].toLowerCase()), h("button.btn.sm", { type: "button", onclick: () => d.close() }, "Close")),
      h("div.bd",
        h("div.grid",
          kind === "product" ? field("Manufacturer", inp("manufacturer")) : null,
          field(nameLabel, inp("model", { required: true }), kind === "product" ? "" : "span2"),
          kind === "product" ? field("Part number", inp("part_number")) : null,
          kind === "product" ? field("Catalog #", inp("catalog_no")) : null,
          field("Category", inp("category")), field("Subcategory", inp("subcategory")),
          field("Default system", inp("system", { list: "syslist", placeholder: "Lighting: Can Light" })),
          kind === "product" ? field("Preferred vendor", inp("vendor")) : null,
          kind !== "package" && kind !== "labor" ? field("Unit cost", inp("unit_cost", { type: "number", step: "any", min: "0" })) : null,
          kind !== "package" ? field("Unit sell" + (kind === "labor" ? " (optional)" : ""), inp("unit_price", { type: "number", step: "any", min: "0", placeholder: priceHint ? "at rate" : "" })) : null,
          kind === "product" ? field("MSRP", inp("msrp", { type: "number", step: "any", min: "0" })) : null,
          kind === "product" ? field("Order unit", inp("order_uom", { placeholder: "Each, Package, Reel" })) : null,
          kind === "product" ? field("Units per order", inp("order_units", { type: "number", step: "any", min: "1" })) : null,
          kind === "product" ? field("Purchase cost (per order unit)", inp("purchase_cost", { type: "number", step: "any", min: "0" })) : null,
          kind === "product" || kind === "service" ? field("Product URL", inp("url"), "span2") : null,
          kind === "product" ? field("Image URL", inp("image_url"), "span2") : null,
          kind === "product" ? h("label", { style: { flexDirection: "row", alignItems: "center", gap: "6px" } }, (f.taxable = h("input", { type: "checkbox", checked: it.taxable })), "Taxable") : null,
          id ? h("label", { style: { flexDirection: "row", alignItems: "center", gap: "6px" } }, (f.discontinued = h("input", { type: "checkbox", checked: it.discontinued })), "Discontinued") : null),
        priceHint ? h("p.muted.small", priceHint + ".") : null,
        kind !== "product" ? h("p.muted.small", kind === "package" ? "Packages aren't taxed themselves; their products are." : "Labor and service items are never taxed.") : null,
        h("label.fld", { style: { marginTop: "10px" } }, "Description", (f.short_desc = h("textarea", { rows: 2 }, it.short_desc || ""))),
        kind !== "package" ? [h("div.sec", kind === "labor" ? "Labor" : "Labor per unit"), h("p.muted.small", { style: { margin: "0 0 8px" } },
          kind === "service" ? "Optional. The cost code also files the charge on the job." : "Time is H:MM:SS. On a bid, each line costs its time times the quantity times that cost code's rate for the bid's division."), laborEditor(labor)] : null,
        kind === "package" ? [h("div.sec", "Contents"), h("p.muted.small", { style: { margin: "0 0 8px" } }, "Quantities are per package. Placing 9 of this package on a bid places 9 times each part."), packageEditor(items)] : null,
        sysList),
      h("footer", id ? h("button.btn.danger", { type: "button", onclick: del }, "Delete") : null, h("span.grow"),
        h("button.btn", { type: "button", onclick: () => d.close() }, "Cancel"), h("button.btn.pri", "Save"))));
  });
}

async function importDialog(file) {
  const rows = readCsv(await file.text());
  if (!rows.length || !("Model" in rows[0])) return toast("That file doesn't look like a D-Tools catalog export (no Model column).", true);
  let dry; try { dry = { added: 0, updated: 0, skipped: 0, noCode: 0, newSystems: 0 }; for (let i = 0; i < rows.length; i += 1000) { const r = await api("/api/catalog/import", { json: { rows: rows.slice(i, i + 1000), dry: true } }); for (const k of ["added", "updated", "skipped", "noCode"]) dry[k] += r[k]; dry.newSystems = Math.max(dry.newSystems, r.newSystems || 0); } }
  catch (e) { return toast(e.message, true); }
  dialog(d => {
    const bar = h("i"), msg = h("p.muted");
    const go = async e => {
      e.preventDefault(); e.submitter && (e.submitter.disabled = true);
      const tot = { added: 0, updated: 0, newSystems: 0 };
      try { for (let i = 0; i < rows.length; i += 500) { const r = await api("/api/catalog/import", { json: { rows: rows.slice(i, i + 500) } }); tot.added += r.added; tot.updated += r.updated; tot.newSystems += r.newSystems || 0; bar.style.width = Math.min(100, (i + 500) / rows.length * 100) + "%"; msg.textContent = `${Math.min(rows.length, i + 500).toLocaleString()} of ${rows.length.toLocaleString()} rows…`; }
        SET = await api("/api/settings"); d.close(); toast(`Imported: ${tot.added} new, ${tot.updated} updated.`); CAT.offset = 0; renderCatalog(); }
      catch (err) { toast(err.message, true); msg.textContent = "Stopped: " + err.message + " Rows before this point were saved; you can run the import again safely."; }
    };
    d.append(h("form", { onsubmit: go }, h("header", h("h2", "Import D-Tools catalog")),
      h("div.bd", h("p", h("b", file.name), ` has ${rows.length.toLocaleString()} rows.`),
        h("ul", h("li", `${dry.added.toLocaleString()} new products`), h("li", `${dry.updated.toLocaleString()} already in the catalog (matched on manufacturer and model) will be updated`),
          dry.skipped ? h("li", `${dry.skipped} rows skipped (no model, or listed twice)`) : null,
          dry.newSystems ? h("li", `${dry.newSystems} systems or subsystems will be added to Settings`) : null,
          dry.noCode ? h("li", { style: { color: "var(--warn)" } }, `${dry.noCode} products have labor hours but a phase or labor type whose code isn't one of your cost codes or aliases. They'll come in without labor. Add the missing code as an alias in Settings first if you want it.`) : null),
        h("p.muted.small", "Phases and labor types are matched through your cost code aliases, for example [6020] to 7030 Rough-In. Unit Labor Hours become a labor line in H:M:S. Re-importing later is safe: it updates what's there."),
        h("div.bar", bar), msg),
      h("footer", h("button.btn", { type: "button", onclick: () => d.close() }, "Cancel"), h("button.btn.pri", "Import"))));
  });
}

// ---------------------------------------------------------------- settings
async function renderSettings(sub) {
  SET = await api("/api/settings");
  const can = ME.settings, ro = can ? null : true;
  const codes = SET.costCodes.map(c => ({ ...c, rates: { ...c.rates }, aliases: [...(c.aliases || [])] }));
  const pays = SET.paySchedules.map(p => ({ ...p, steps: p.steps.map(s => ({ ...s })) }));
  const sys = SET.systems.map(s => ({ ...s, subs: [...s.subs] }));
  const saveBtn = (label, fn) => can ? h("button.btn.pri.sm", { onclick: async () => { try { await fn(); SET = await api("/api/settings"); toast("Saved."); renderSettings(); } catch (e) { toast(e.message, true); } } }, label) : null;

  // cost codes
  const codeBody = h("tbody");
  const drawCodes = () => codeBody.replaceChildren(...codes.map((c, i) => h("tr",
    h("td", h("input", { value: c.code, style: { width: "80px" }, disabled: ro, onchange: e => c.code = e.target.value.trim() })),
    h("td", h("input", { value: c.name, style: { width: "100%", minWidth: "160px" }, disabled: ro, onchange: e => c.name = e.target.value })),
    ...SET.divs.map(dv => h("td.rates", h("input", { type: "number", step: "0.01", min: "0", value: c.rates[dv] || "", placeholder: "0.00", disabled: ro, onchange: e => c.rates[dv] = parseFloat(e.target.value) || 0 }))),
    h("td", h("input", { value: c.aliases.join(", "), placeholder: "old codes", style: { width: "130px" }, disabled: ro, title: "Old codes that mean this one (D-Tools phases and labor types)", onchange: e => c.aliases = e.target.value.split(/[\s,;]+/).filter(Boolean) })),
    h("td", h("label.small", { style: { display: "flex", gap: "4px", alignItems: "center" } }, h("input", { type: "checkbox", checked: c.retired, disabled: ro, onchange: e => c.retired = e.target.checked }), "Retired")),
    can ? h("td", h("button.btn.sm.danger", { onclick: () => { codes.splice(i, 1); drawCodes(); } }, "Remove")) : null)));
  drawCodes();

  // payment schedules
  const payBox = h("div");
  const drawPays = () => payBox.replaceChildren(...pays.map((p, i) => {
    const tot = Math.round(p.steps.reduce((a, s) => a + (+s.pct || 0), 0) * 100) / 100, totEl = h("span" + (tot === 100 ? ".muted" : ""), { style: tot === 100 ? null : { color: "var(--bad)", fontWeight: 600 } }, `Total ${tot}%`);
    return h("div.sys",
      h("div.row", h("input", { value: p.name, placeholder: "Schedule name", style: { flex: "1", fontWeight: 600 }, disabled: ro, onchange: e => p.name = e.target.value }), totEl,
        can ? h("button.btn.sm.danger", { onclick: () => { pays.splice(i, 1); drawPays(); } }, "Remove schedule") : null),
      h("table", { style: { marginTop: "6px" } }, h("tbody", p.steps.map((s, j) => h("tr",
        h("td", h("input", { value: s.label, placeholder: "Milestone", style: { width: "100%" }, disabled: ro, onchange: e => s.label = e.target.value })),
        h("td", { style: { width: "120px" } }, h("input", { type: "number", step: "0.01", min: "0", max: "100", value: s.pct, style: { width: "80px" }, disabled: ro, onchange: e => { s.pct = parseFloat(e.target.value) || 0; drawPays(); } }), " %"),
        can ? h("td", { style: { width: "90px" } }, h("button.btn.sm.danger", { onclick: () => { p.steps.splice(j, 1); drawPays(); } }, "Remove")) : null)))),
      can ? h("button.btn.sm", { onclick: () => { p.steps.push({ label: "", pct: 0 }); drawPays(); } }, "+ Milestone") : null);
  }));
  drawPays();

  // systems
  const sysBox = h("div");
  const drawSys = () => sysBox.replaceChildren(...sys.map((s, i) => h("div.sys",
    h("div.row", h("input", { value: s.name, style: { fontWeight: 600, flex: "1" }, disabled: ro, onchange: e => s.name = e.target.value }),
      can ? h("button.btn.sm.danger", { onclick: () => { sys.splice(i, 1); drawSys(); } }, "Remove") : null),
    h("div.chips", s.subs.map((x, j) => h("span.chip", x, can ? h("button", { title: "Remove", onclick: () => { s.subs.splice(j, 1); drawSys(); } }, "×") : null)),
      can ? h("input", { placeholder: "+ Subsystem", style: { width: "150px", minHeight: "28px" }, onkeydown: e => { if (e.key === "Enter" && e.target.value.trim()) { s.subs.push(e.target.value.trim()); drawSys(); } } }) : null))));
  drawSys();

  // lead numbers
  const leadIn = {};
  const leadRows = SET.divs.map(dv => h("div.row", { style: { marginBottom: "8px" } }, h("b", { style: { width: "40px" } }, dv),
    (leadIn[dv] = h("input", { type: "number", min: SET.leads[dv] || 1, step: "1", value: SET.leads[dv] ?? "", placeholder: "200", style: { width: "120px" }, disabled: ro })),
    h("span.muted", SET.leads[dv] != null ? `Next number: ${dv}-${String(SET.leads[dv]).padStart(4, "0")}` : "Not set yet. Bids can't create jobs in this division until it is.")));

  // takeoff devices: the catalog item or package each counted device type becomes in the bid
  const tt = (await api("/api/takeoff-types")).types, picks = {};
  const toBody = h("tbody");
  const drawTo = () => fill(toBody, tt.map(t => {
    const cur = t.key in picks ? picks[t.key] : t.item;
    const q = h("input", { type: "search", placeholder: cur ? "Change…" : "Search the catalog…", disabled: ro, style: { width: "100%" } }), drop = h("div.list", { hidden: true });
    let tm; q.addEventListener("input", () => { clearTimeout(tm); tm = setTimeout(async () => {
      if (!q.value.trim()) { drop.hidden = true; return; }
      const r = await api(`/api/catalog?q=${encodeURIComponent(q.value)}&limit=12`);
      fill(drop, r.items.length ? r.items.map(it => h("div", { onmousedown: e => { e.preventDefault(); picks[t.key] = it; drawTo(); } }, h("span.pill." + it.kind, KIND_LABEL[it.kind]), " ", h("b", [it.manufacturer, it.model].filter(Boolean).join(" ")))) : h("div.muted", "No matches"));
      drop.hidden = false; }, 200); });
    q.addEventListener("blur", () => setTimeout(() => drop.hidden = true, 150));
    return h("tr", h("td.muted.small", t.group), h("td", h("b", t.label)),
      h("td", cur ? [h("span.pill." + cur.kind, KIND_LABEL[cur.kind]), " ", [cur.manufacturer, cur.model].filter(Boolean).join(" ")] : h("span.muted", "Not linked")),
      h("td", { style: { width: "280px" } }, h("div.picker", q, drop)),
      can && cur ? h("td", h("button.btn.sm.danger", { onclick: () => { picks[t.key] = null; drawTo(); } }, "Unlink")) : h("td"));
  }));
  drawTo();
  const toCard = h("div.card", { id: "takeoff-devices" }, h("header", h("h2", "Takeoff devices"),
      saveBtn("Save takeoff devices", () => api("/api/takeoff-types", { method: "PUT", json: { map: Object.fromEntries(Object.entries(picks).map(([k, v]) => [k, v ? v.id : null])) } }))),
    h("div.bd", h("p.muted.small", { style: { marginTop: 0 } }, "Each device the takeoff counts on the plans comes into the bid as this catalog item or package, in the room it was counted in. A package can hold the box, device, plate, wire and labor. Unlinked devices still come in, at $0, so nothing is missed."),
      h("div.wrap", h("table", h("thead", h("tr", h("th", "Group"), h("th", "Device"), h("th", "Becomes"), h("th", ""), h("th"))), toBody))));

  show(
    h("h1", "Settings"),
    !can ? h("div.note", "Only Admins can change settings. You can see them here.") : null,
    h("div.card", h("header", h("h2", "Cost codes and labor rates"), saveBtn("Save cost codes", () => api("/api/settings/cost-codes", { method: "PUT", json: { costCodes: codes } }))),
      h("div.bd", h("p.muted.small", { style: { marginTop: 0 } }, "Labor sells at the rate for the bid's division, with no markup. Aliases are old codes that mean this one, so D-Tools imports land on the right code. A code used in the catalog can be retired but not removed."),
        h("div.wrap", h("table", h("thead", h("tr", h("th", "Code"), h("th", "Name"), ...SET.divs.map(dv => h("th", `${dv} rate ($/hr)`)), h("th", "Aliases"), h("th", ""), can ? h("th") : null)), codeBody)),
        can ? h("button.btn.sm", { style: { marginTop: "8px" }, onclick: () => { codes.push({ code: "", name: "", rates: {}, aliases: [], retired: false }); drawCodes(); } }, "+ Cost code") : null)),
    h("div.card", h("header", h("h2", "Payment schedules"), saveBtn("Save schedules", () => api("/api/settings/pay-schedules", { method: "PUT", json: { paySchedules: pays } }))),
      h("div.bd", h("p.muted.small", { style: { marginTop: 0 } }, "Each bid picks one of these, and can change its milestones for that bid only. Milestones must total 100%."), payBox,
        can ? h("button.btn.sm", { onclick: () => { pays.push({ name: "", steps: [{ label: "", pct: 100 }] }); drawPays(); } }, "+ Payment schedule") : null)),
    h("div.card", h("header", h("h2", "Lead numbers"), saveBtn("Save lead numbers", () => api("/api/settings/leads", { method: "PUT", json: { leads: Object.fromEntries(SET.divs.map(dv => [dv, leadIn[dv].value])) } }))),
      h("div.bd", h("p.muted.small", { style: { marginTop: 0 } }, "A new job gets the next number in its division, like EL-0200 or LV-0200. The next number can only move forward, so no lead number is ever used twice."), leadRows)),
    h("div.card", h("header", h("h2", "Systems"), saveBtn("Save systems", () => api("/api/settings/systems", { method: "PUT", json: { systems: sys } }))),
      h("div.bd", h("p.muted.small", { style: { marginTop: 0 } }, "A system and its subsystems, like Lighting with Can Light and Tape Light. The D-Tools import adds any it finds. Type a subsystem and press Enter."), sysBox,
        can ? h("button.btn.sm", { onclick: () => { sys.push({ name: "New system", subs: [] }); drawSys(); } }, "+ System") : null)),
    toCard);
  if (sub === "takeoff") setTimeout(() => toCard.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
}

// ---------------------------------------------------------------- dark mode (same "sis.theme" setting and button as SIS Tools)
{
  const root = document.documentElement, btn = document.getElementById("theme");
  const dark = () => root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  const paint = () => { btn.textContent = dark() ? "☀ Light mode" : "☾ Dark mode"; };
  btn.onclick = () => { const t = dark() ? "light" : "dark"; root.dataset.theme = t; try { localStorage.setItem("sis.theme", t); } catch (e) {} paint(); };
  paint();
  // keep the tab bar right under the header while scrolling (sis-header.css reads --sis-hdr-h)
  const hdr = document.querySelector(".sis-hdr"), setH = () => root.style.setProperty("--sis-hdr-h", Math.round(hdr.getBoundingClientRect().height) + "px");
  setH(); if (window.ResizeObserver) new ResizeObserver(setH).observe(hdr); else addEventListener("resize", setH);
}

// ---------------------------------------------------------------- start
(async () => {
  try {
    const r = await api("/api/me"); ME = r.me; SET = await api("/api/settings");
    document.getElementById("who").textContent = ME.name;
    const rb = document.getElementById("role"), rn = ME.role === "admin" ? "Admin" : (ME.roleName || "");
    if (rn) { rb.textContent = rn; rb.className = "sis-role " + (["admin", "pm", "scheduler"].includes(ME.role) ? ME.role : "viewer"); rb.hidden = false; }
    if (r.sisTools) document.getElementById("sis").href = r.sisTools;
    route();
  } catch (e) { show(h("div.note.bad", e.message)); }
})();
