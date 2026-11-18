// Shared helpers: API calls, DOM building, formatting, PDF loading.
// pdf.js sits next to this file (vendor/pdfjs), locally and on the SIS Tools site.
import * as pdfjsLib from "./vendor/pdfjs/pdf.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdfjs/pdf.worker.mjs", import.meta.url).href;
export { pdfjsLib };

// Locally the API is /api/...; on the SIS Tools site the page is /takeoff/ and the API is /api/takeoff/...
export const IN_HUB = location.pathname.startsWith("/takeoff");
const API_BASE = IN_HUB ? "/api/takeoff" : "/api";
export const apiUrl = (path) => (path.startsWith("/api/") ? API_BASE + path.slice(4) : path);

export const bidChannel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("sis-bids") : { postMessage() {}, addEventListener() {} };
export const takeoffJobId = () => { const m = location.hash.match(/^#\/job\/(\d+)/); return m ? Number(m[1]) : null; };

export async function api(path, opts = {}) {
  const init = { ...opts, headers: { ...(opts.headers || {}) } };
  if (opts.json !== undefined) {
    init.body = JSON.stringify(opts.json);
    init.headers["Content-Type"] = "application/json";
    init.method ||= "POST";
  }
  const res = await fetch(apiUrl(path), init);
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("json") ? await res.json() : await res.text();
  // Claude jobs stream their answer (status 200) and report a failure as {"error": ...} in the body.
  if (!res.ok || (res.headers.get("x-long-job") && data?.error)) throw new Error(data?.error || `${res.status} ${res.statusText}`);
  if (typeof data === "string" && /^\s*</.test(data)) throw new Error("Your sign-in has expired. Reload the page to sign in again.");
  // SIS Bids: tell an open bid that the takeoff changed, so its rooms and counts follow (two-way sync with the bid page)
  if ((init.method || "GET") !== "GET") { try { bidChannel.postMessage({ t: "takeoff", job: takeoffJobId() }); } catch (e) {} }
  return data;
}

/** Tiny hyperscript: h("div.cls#id", {attrs, onclick}, ...children) */
export function h(tag, attrs, ...children) {
  const [, name = "div", rest = ""] = tag.match(/^([a-z0-9-]*)(.*)$/i);
  const el = document.createElement(name || "div");
  for (const m of rest.matchAll(/([.#])([\w-]+)/g)) m[1] === "." ? el.classList.add(m[2]) : (el.id = m[2]);
  if (attrs && (typeof attrs !== "object" || attrs instanceof Node || Array.isArray(attrs))) { children.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "value" || (k in el && k !== "list" && typeof v !== "string")) el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

/** SIS Tools rule (Tony, 2026-11-08): clicking off a pop-up saves it and closes it. A press and release outside the dialog's
 *  box runs onOff (default: just close, for pickers with nothing to save). The page's popup.js makes every dialog resizable. */
/** Tony (TO12): with a Lutron lighting spec, the first sheet review also zones the lights, so nobody pays for a second run. */
export const autoZonesWith = (spec) => !!spec && (!!spec.rules?.zoning_required || (spec.control && spec.control !== "standard"));

export function clickOff(dlg, onOff = () => dlg.close()) {
  const out = (e) => { const r = dlg.getBoundingClientRect(); return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom; };
  let down = false;
  dlg.addEventListener("pointerdown", (e) => { down = e.target === dlg && out(e); });
  dlg.addEventListener("click", (e) => { if (down && e.target === dlg && out(e)) onOff(); down = false; });
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); onOff(); }); // Esc does the same as clicking off (only Cancel discards)
  return dlg;
}

export const money = (n) => (n || 0).toLocaleString(undefined, { style: "currency", currency: "USD" });
export const num = (n, d = 1) => (n || 0).toLocaleString(undefined, { maximumFractionDigits: d });

let toastTimer;
export function toast(msg, isError = false) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.className = "toast" + (isError ? " error" : ""); t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 7000 : 3000);
}

const docCache = new Map();
export function loadPdf(planId) {
  if (!docCache.has(planId)) docCache.set(planId, pdfjsLib.getDocument({ url: apiUrl(`/api/plans/${planId}/file`) }).promise);
  return docCache.get(planId);
}

/** Text items on a page in PDF points with a top-left origin. */
export async function pageText(page) {
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  return tc.items.filter((it) => it.str && it.str.trim()).map((it) => {
    const m = pdfjsLib.Util.transform(vp.transform, it.transform);
    return { s: it.str.trim(), x: m[4] + (it.width || 0) / 2, y: m[5] - Math.hypot(m[2], m[3]) / 2, size: Math.hypot(m[2], m[3]) };
  });
}

/** Guess sheet number, title, kind and level from the large text in the title block. */
export async function describePage(page, pageNo) {
  const vp = page.getViewport({ scale: 1 });
  const items = await pageText(page);
  const strip = items.filter((t) => t.x > vp.width * 0.8 && t.y > vp.height * 0.35);
  const big = strip.filter((t) => t.size >= 13);
  const bigText = big.map((t) => t.s).join(" ");
  const all = items.filter((t) => t.size >= 13).map((t) => t.s).join(" ").toUpperCase();

  let sheet_no = "";
  const m = bigText.match(/\b([A-Z]{1,3})\s?[.-]\s?(\d{1,3}(?:\.\d+)?[A-Z]?)\b/) || bigText.match(/\b([A-Z]{1,2})(\d{1,3}(?:\.\d+)?[A-Z]?)\b/);
  if (m) sheet_no = `${m[1]}.${m[2]}`.replace("..", ".");
  // Some title blocks split "ID." and "3A" into separate items: take the largest-font short token after the prefix.
  if (!sheet_no) {
    const pre = big.find((t) => /^[A-Z]{1,3}\.$/.test(t.s));
    const suf = big.filter((t) => /^\d{1,3}[A-Z]?$/.test(t.s)).sort((a, b) => b.size - a.size)[0];
    if (pre && suf) sheet_no = pre.s + suf.s;
  }
  const titleWords = big.map((t) => t.s).filter((s) => /LEVEL|PLAN|WING|ELEVATION|FLOOR|ELECTRICAL|LIGHTING|POWER|SCHEDULE|BASEMENT|GARAGE|ROOF|SITE|DETAIL|SECTION|REFLECTED|CEILING|PLUMBING|MECHANICAL/i.test(s));
  const title = titleWords.join(" ").replace(/\s+/g, " ").trim();
  const T = (title || all);
  const kind = /ELECTRICAL|LIGHTING|POWER PLAN|E\.?\s?PLAN/.test(T) ? "electrical" : /FLOOR PLAN|FLOOR\s+PLAN/.test(T.replace(/\s+/g, " ")) ? "floor" : "other";
  const lv = T.match(/(LOWER|UPPER|MAIN|FIRST|SECOND|THIRD|GROUND|BASEMENT|GARAGE)\s+(LEVEL|FLOOR)?/);
  const wing = T.match(/(NORTH|SOUTH|EAST|WEST)\s+WING/);
  const level = [lv && lv[0], wing && wing[0]].filter(Boolean).map((s) => s.trim().replace(/\b\w+/g, (w) => w[0] + w.slice(1).toLowerCase())).join(" - ");
  return { page: pageNo, sheet_no, title, kind, level, width: vp.width, height: vp.height };
}

export function canvasToB64(canvas) {
  return canvas.toDataURL("image/png").split(",")[1];
}
