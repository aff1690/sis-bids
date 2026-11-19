// Claude plan analysis.
// Pass 1 (overview): whole sheet + extracted PDF text -> sheet info, legend, room list.
// Pass 2 (tiles):    high-res tiles of the sheet -> device symbols with pixel positions.
// Claude is called with plain HTTPS requests (fetch), so the same code runs on the local server and on the
// SIS Tools site, which already holds the ANTHROPIC_API_KEY secret used by Panels, SOP and AV.
import { DEVICE_TYPES, TYPE_KEYS } from "./deviceTypes.js";

const PRICE_IN = 4 / 1e6, PRICE_OUT = 20 / 1e6; // Claude Opus 5.5 $/token
const cfg = { apiKey: "", model: "claude-opus-5-5", tileConcurrency: 3 };
let MODEL = cfg.model, TILE_CONCURRENCY = cfg.tileConcurrency;
/** Set from .env locally, from the site's secrets/variables on SIS Tools. */
export function configureClaude({ apiKey, model, tileConcurrency } = {}) {
  cfg.apiKey = apiKey || "";
  MODEL = cfg.model = model || "claude-opus-5-5";
  TILE_CONCURRENCY = cfg.tileConcurrency = Number(tileConcurrency) || 3;
}
export const hasApiKey = () => !!cfg.apiKey;

class ClaudeError extends Error {
  constructor(status, type, message) { super(message); this.status = status; this.type = type; }
}

/** One streamed Messages API request, collected into the final message (streaming keeps long calls alive). */
async function streamMessage(body) {
  if (!cfg.apiKey) throw new ClaudeError(400, "config", "ANTHROPIC_API_KEY is not set, so Claude can't read plans. Locally: add it to .env and restart. On SIS Tools: it's the site secret Panels already uses.");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": "2026-10-21",
      "anthropic-beta": "server-side-fallback-2026-07-01",
    },
    body: JSON.stringify({ ...body, stream: true }),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => null);
    throw new ClaudeError(res.status, j?.error?.type || "api_error", j?.error?.message || `Claude API error ${res.status}`);
  }
  const msg = { content: [], usage: {}, stop_reason: null, stop_details: null };
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  const handle = (ev) => {
    switch (ev.type) {
      case "message_start": Object.assign(msg.usage, ev.message.usage || {}); break;
      case "content_block_start": msg.content[ev.index] = { ...ev.content_block, text: ev.content_block.text || "" }; break;
      case "content_block_delta": if (ev.delta.type === "text_delta") msg.content[ev.index].text += ev.delta.text; break;
      case "message_delta":
        Object.assign(msg.usage, ev.usage || {});
        msg.stop_reason = ev.delta?.stop_reason ?? msg.stop_reason;
        msg.stop_details = ev.delta?.stop_details ?? msg.stop_details;
        break;
      case "error": throw new ClaudeError(500, ev.error?.type || "api_error", ev.error?.message || "Claude stream error");
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += value;
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const data = chunk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      if (data) handle(JSON.parse(data));
    }
    if (done) break;
  }
  return msg;
}

const DEVICE_GUIDE = DEVICE_TYPES.map((t) => `- ${t.key}: ${t.label} (typical symbol: ${t.hint})`).join("\n");

export const OVERVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["sheet_title", "level_name", "is_electrical_plan", "scale_text", "legend", "rooms", "notes", "equipment", "generator_evidence"],
  properties: {
    sheet_title: { type: "string" },
    level_name: { type: "string", description: "Floor/area this sheet covers, e.g. 'Lower Level - South Wing'" },
    is_electrical_plan: { type: "boolean" },
    scale_text: { type: "string" },
    legend: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["symbol", "meaning", "device_type"],
        properties: {
          symbol: { type: "string", description: "What the symbol looks like on this sheet" },
          meaning: { type: "string" },
          device_type: { type: "string", enum: TYPE_KEYS },
        },
      },
    },
    rooms: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["number", "name", "label_items"],
        properties: {
          number: { type: "string" },
          name: { type: "string" },
          label_items: { type: "array", items: { type: "integer" }, description: "Indexes of the PDF text items that form this room's label" },
        },
      },
    },
    notes: { type: "array", items: { type: "string" }, description: "Plan notes an electrical estimator should know (special outlets, TBD items, owner-supplied fixtures)" },
    equipment: {
      type: "array", description: "Electrical equipment drawn or labelled on the floor plan (not in notes/legend): panels, sub-panels, meters, generators, transfer switches",
      items: {
        type: "object", additionalProperties: false, required: ["kind", "label", "label_items"],
        properties: {
          kind: { type: "string", enum: ["elec_panel", "subpanel", "meter", "generator", "transfer_switch", "lighting_panel"] },
          label: { type: "string" },
          label_items: { type: "array", items: { type: "integer" }, description: "Indexes of the PDF text items that label it" },
        },
      },
    },
    generator_evidence: { type: "string", description: "Quote of any note or label indicating a generator / standby power / transfer switch, or '' if none" },
  },
};

const TILE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["devices"],
  properties: {
    devices: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["type", "x", "y", "room_number", "room_name", "confidence", "note"],
        properties: {
          type: { type: "string", enum: TYPE_KEYS },
          x: { type: "number", description: "Symbol centre, image pixels from left" },
          y: { type: "number", description: "Symbol centre, image pixels from top" },
          room_number: { type: "string", description: "Room number the device is in, or '' if the room has no number" },
          room_name: { type: "string", description: "Room name exactly as labelled on the drawing (e.g. 'SOUTH HALL'), even when it has no number" },
          confidence: { type: "number", description: "0-1" },
          note: { type: "string", description: "Mounting height, tag (GFI, +39), or why it is uncertain" },
        },
      },
    },
  },
};

async function callClaude({ system, content, schema, effort }) {
  const msg = await streamMessage({
    model: MODEL,
    max_tokens: 32000,
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort, format: { type: "json_schema", schema } },
    system,
    messages: [{ role: "user", content }],
  });
  if (msg.stop_reason === "refusal") {
    throw new Error(`Claude declined to analyze this sheet (${msg.stop_details?.category ?? "no category"}).`);
  }
  if (msg.stop_reason === "max_tokens") throw new Error("Claude's answer was cut off (max_tokens). Try a smaller area.");
  const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const usage = { input: msg.usage.input_tokens + (msg.usage.cache_read_input_tokens || 0), output: msg.usage.output_tokens };
  return { data: JSON.parse(text), usage };
}

const img = (b64) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: b64 } });

const SYSTEM = `You are an experienced residential electrical estimator doing a takeoff from construction drawings.
You read plan sheets carefully, use the sheet's own legend to identify symbols, and never invent devices that are not drawn.
Device types you can assign:
${DEVICE_GUIDE}`;

const withSpecs = (specText) => specText ? `${SYSTEM}\n\nThis job's specifications (they decide how the drawing is interpreted):\n${specText}` : SYSTEM;

async function overviewPass({ sheet, overview, textItems, specText, lookText = "" }) {
  const textList = textItems.map((t) => `${t.i}: "${t.s}" @ (${Math.round(t.x)}, ${Math.round(t.y)})`).join("\n");
  const content = [
    img(overview.png),
    {
      type: "text",
      text: `This is sheet ${sheet.sheet_no || "?"} (page ${sheet.page}) of a residential plan set. The image is the whole sheet (${overview.w}x${overview.h}px; sheet is ${Math.round(sheet.width)}x${Math.round(sheet.height)} PDF points).

Text items extracted from the PDF (index: text @ x,y in PDF points from the top-left):
${textList}

Tasks:
1. Identify the sheet title, the floor/area it covers (level_name), the drawing scale, and whether it is an electrical/lighting plan.
2. Read the electrical/MEP legend on the sheet and map each symbol to one of the device types.
3. List every room (use the room name and room number tags). For each room give the indexes of the text items that form its label inside the floor plan (not the legend, schedules or title block).
4. Note anything an electrical estimator must know (ceiling outlets, TBD locations, special circuits, owner-furnished fixtures).
5. List electrical equipment shown on the plan (panels, sub-panels, meters, generators, transfer switches) with the text items that label it.
6. If any note or label indicates a generator, standby power or a transfer switch, quote it in generator_evidence.${lookText ? `\n\n${lookText}\nUse the symbol descriptions above when mapping the legend.` : ""}`,
    },
  ];
  return callClaude({ system: withSpecs(specText), content, schema: OVERVIEW_SCHEMA, effort: "high" });
}

async function tilePass({ tile, legend, roomsInTile, levelName, idx, total, specText, lookText = "" }) {
  const legendText = legend.length
    ? legend.map((l) => `- ${l.symbol} => ${l.meaning} [${l.device_type}]`).join("\n")
    : "(no legend found - use standard residential electrical symbols)";
  const roomText = roomsInTile.length
    ? roomsInTile.map((r) => `- ${r.number ? r.number + " " : "(no number) "}${r.name} label at (${Math.round(r.px)}, ${Math.round(r.py)})`).join("\n")
    : "(no room labels fall inside this tile)";
  const content = [
    img(tile.png),
    {
      type: "text",
      text: `This image is tile ${idx + 1} of ${total} cut from an electrical plan (${levelName || "unknown level"}). It is ${tile.w}x${tile.h} pixels. Tiles overlap slightly; report every symbol you can see in this tile.

Legend from this sheet:
${legendText}

Room labels in this tile (pixel positions in this image):
${roomText}

Find every electrical device symbol drawn on the floor plan in this tile: receptacles, switches, lights, fans, smoke/CO detectors, data outlets, etc.
- Ignore symbols inside the legend box, schedules, notes, title block, and elevation tags/section markers (diamonds or circles with sheet references like "ID.9").
- Give the pixel position of each symbol's centre in this image.
- Give the room the device is physically inside (by the walls, not the nearest label): its number, and always its name as labelled (room names are unique on a sheet even when a room has no number, e.g. 'SOUTH HALL'). Long halls contain every device along their length.
- Put tags such as GFI, +39, USB, or the reason you are unsure in the note. Use lower confidence when unsure.
- A switch drawn with a subscript (3, 4, D) is that switch type. Count each LED tape/under-cabinet run once.${lookText ? `\n\n${lookText}` : ""}`,
    },
  ];
  return callClaude({ system: withSpecs(specText), content, schema: TILE_SCHEMA, effort: "high" });
}

// ---------- room assignment ----------
const ROOMS_SCHEMA = {
  type: "object", additionalProperties: false, required: ["rooms", "devices"],
  properties: {
    rooms: {
      type: "array", description: "Bounding box of each room's floor area, inside its walls, in image pixels",
      items: { type: "object", additionalProperties: false, required: ["room_number", "x0", "y0", "x1", "y1"],
        properties: { room_number: { type: "string" }, x0: { type: "number" }, y0: { type: "number" }, x1: { type: "number" }, y1: { type: "number" } } },
    },
    devices: {
      type: "array", description: "Every device id with the room it is physically inside (by the walls, not the nearest label)",
      items: { type: "object", additionalProperties: false, required: ["id", "room_number"],
        properties: { id: { type: "integer" }, room_number: { type: "string", description: "Room number, or 'exterior' if outside the building" } } },
    },
  },
};

/** Put every device in the room it is actually inside, judged by the walls on the drawing. */
export async function assignRooms({ sheet, overview, rooms, devices }) {
  const text = `This is electrical plan sheet ${sheet.sheet_no || sheet.page} (${overview.w}x${overview.h} px).
Rooms and where their name labels are (image pixels):
${rooms.map((r) => `- ${r.number} ${r.name}: label at (${Math.round(r.px)}, ${Math.round(r.py)})`).join("\n")}

Devices (id, type, position in image pixels):
${devices.map((d) => `- #${d.id} ${d.label} at (${Math.round(d.px)}, ${Math.round(d.py)})`).join("\n")}

1. For each room give the bounding box of its floor area inside its walls.
2. For EVERY device give the room it is physically inside, using the walls and doors on the drawing, NOT the nearest label. Long halls and corridors contain all the lights along their length even when another room's label is closer. Devices outside the building are "exterior"; wall-mounted devices belong to the room on the side they face.`;
  const res = await callClaude({ system: SYSTEM, content: [img(overview.png), { type: "text", text }], schema: ROOMS_SCHEMA, effort: "high" });
  return { ...res.data, usage: { ...res.usage, cost_usd: +(res.usage.input * PRICE_IN + res.usage.output * PRICE_OUT).toFixed(2) } };
}

// ---------- NEC / IRC code check ----------
const CODE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["rooms", "findings"],
  properties: {
    rooms: {
      type: "array", description: "Every room on the sheet with its use and approximate size from the drawing scale",
      items: {
        type: "object", additionalProperties: false, required: ["room_number", "use", "length_ft", "width_ft"],
        properties: {
          room_number: { type: "string" },
          use: { type: "string", enum: ["bedroom", "bathroom", "kitchen", "dining", "living", "family", "hall", "foyer", "stair", "closet", "laundry", "garage", "basement_unfinished", "mechanical", "storage", "office", "media", "exterior", "other"] },
          length_ft: { type: "number" }, width_ft: { type: "number" },
        },
      },
    },
    findings: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["rule", "code_ref", "room_number", "severity", "message", "add_device_type", "x", "y"],
        properties: {
          rule: { type: "string", description: "Short name, e.g. 'Hallway receptacle'" },
          code_ref: { type: "string", description: "Section(s) in the stated editions, e.g. 'NEC 210.52(H); IRC E3901.10'" },
          room_number: { type: "string" },
          severity: { type: "string", enum: ["required", "review"], description: "required = clearly missing per code; review = needs a human check (e.g. dimensions unclear)" },
          message: { type: "string", description: "What is missing and why, in one or two sentences" },
          add_device_type: { type: "string", enum: [...TYPE_KEYS, "none"], description: "Device to add if accepted, or 'none' for review-only items" },
          x: { type: "number", description: "Suggested location in image pixels (where the device should go), or 0" },
          y: { type: "number" },
        },
      },
    },
  },
};

/**
 * Check one electrical sheet against the NEC / IRC for missing required devices.
 * @param devices [{type, label, room, x, y}] in image pixels
 */
export async function codeCheck({ sheet, overview, rooms, devices, specText, nec, irc, dismissed = [] }) {
  const text = `Check this residential electrical plan (sheet ${sheet.sheet_no || sheet.page}, ${sheet.level || ""}) for devices REQUIRED by the ${nec} NEC and ${irc} IRC that are not drawn.
The image is ${overview.w}x${overview.h} pixels; the drawing scale is ${sheet.scale_text || "1/4\" = 1'-0\""}.

Rooms (label positions in image pixels):
${rooms.map((r) => `- ${r.number} ${r.name} at (${Math.round(r.px)}, ${Math.round(r.py)})`).join("\n")}

Devices already counted (image pixels):
${devices.map((d) => `- ${d.label}${d.room ? ` in ${d.room}` : ""} at (${Math.round(d.px)}, ${Math.round(d.py)})${d.note ? ` [${d.note}]` : ""}`).join("\n")}

Check at least (cite the section numbers of the ${nec} NEC / ${irc} IRC):
- Hallways 10 ft or longer need a receptacle (NEC 210.52(H)); foyers over 60 sq ft need a receptacle on each wall space 3 ft or wider (210.52(I)).
- Wall-space receptacle spacing in habitable rooms: no point along the floor line more than 6 ft from a receptacle, every wall 2 ft or wider (210.52(A)). Wall space is BROKEN by doorways, fireplaces, fixed built-ins/cabinets and similar openings: measure each wall space separately and never place a receptacle in a fireplace, hearth, chimney bump-out or doorway. A bay or arc drawn at a wall may be a fireplace or hearth: if it could be, report it only as "review", not "required".
- Bathrooms: a receptacle within 3 ft of each basin (210.52(D)).
- Kitchen / wet-bar countertop spacing, islands and peninsulas (210.52(C)).
- Laundry, garage, unfinished basement, and HVAC service receptacles (210.52(F)/(G), 210.63) if those spaces/equipment are on this sheet.
- Outdoor receptacles at the front and back of the dwelling at grade, and at balconies/decks (210.52(E)) if shown on this sheet.
- A switched lighting outlet in every habitable room, bathroom, hallway, stairway, attached garage, and at outdoor entrances (210.70); stairways with 6 or more risers need switching at each floor level.
- Smoke alarms in each sleeping room, outside each sleeping area, and on each story; CO alarms outside sleeping areas where required (IRC R314, R315).
Rules:
- Only report what is genuinely missing from the drawing. Do not report items already drawn, GFCI/AFCI protection (handled elsewhere), or things outside this sheet.
- For each finding give the room, the code section, and a suggested location in image pixels for the device to add (against the correct wall).
- Use severity "review" when you cannot be sure from the drawing (unclear dimensions, door swings, fixed glass).
- Also list every room's use and approximate size.${dismissed.length ? `

The estimator already reviewed and DISMISSED these; do not report them again (and apply the same reasoning elsewhere):
${dismissed.map((d) => `- ${d.room}: ${d.rule}. Reason: ${d.note}`).join("\n")}` : ""}`;
  const content = [img(overview.png), { type: "text", text }];
  const res = await callClaude({ system: withSpecs(specText), content, schema: CODE_SCHEMA, effort: "high" });
  return { ...res.data, usage: { ...res.usage, cost_usd: +(res.usage.input * PRICE_IN + res.usage.output * PRICE_OUT).toFixed(2) } };
}

// ---------- appliance specs & mechanical drawings -> powered equipment ----------
const LOADS_SCHEMA = {
  type: "object", additionalProperties: false, required: ["loads", "notes"],
  properties: {
    loads: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["name", "tag", "category", "location", "room_number", "volts", "phase", "amps", "mocp", "needs_neutral", "connection", "needs_disconnect", "gas_fired", "page", "from_spec", "notes"],
        properties: {
          name: { type: "string", description: "e.g. 'Induction range', 'Heat pump condenser', 'Boiler'" },
          tag: { type: "string", description: "Equipment tag / model, e.g. 'HP-1', 'Wolf IR36550', or ''" },
          category: { type: "string", enum: ["kitchen", "laundry", "hvac", "water_heating", "pump", "ev", "pool_spa", "other"] },
          location: { type: "string", description: "Room / area as written, or ''" },
          room_number: { type: "string", description: "Room number if known, or ''" },
          volts: { type: "integer", description: "120, 208 or 240" },
          phase: { type: "integer", description: "1 or 3" },
          amps: { type: "number", description: "FLA or MCA in amps (0 if unknown)" },
          mocp: { type: "integer", description: "Max overcurrent protection / breaker size in amps (0 if not stated)" },
          needs_neutral: { type: "boolean", description: "120/240V appliances such as ranges, ovens and dryers" },
          connection: { type: "string", enum: ["hardwired", "receptacle"] },
          needs_disconnect: { type: "boolean", description: "Outdoor HVAC units and equipment out of sight of the panel" },
          gas_fired: { type: "boolean", description: "Gas appliance that still needs 120V power" },
          page: { type: "integer", description: "Page the item appears on" },
          from_spec: { type: "boolean", description: "true if electrical data is stated in the document, false if you used a typical value" },
          notes: { type: "string" },
        },
      },
    },
    notes: { type: "array", items: { type: "string" }, description: "Other electrical requirements in the document (e.g. 'all appliances 240V', 'provide snow-melt controller')" },
  },
};

/**
 * Read an appliance spec or mechanical drawing set and list everything that needs electrical power.
 * @param pdfB64  whole PDF (base64) when small enough, else null
 * @param pages   [{page, text}] extracted text, used when the PDF is too large
 */
export async function extractLoads({ docType, filename, pdfB64, pages, specText, rooms }) {
  const what = docType === "mechanical"
    ? "mechanical drawings (equipment schedules, plans and notes)"
    : "an appliance specification / schedule";
  const content = [];
  if (pdfB64) content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfB64 } });
  else content.push({ type: "text", text: `Extracted text of "${filename}", page by page:\n\n${pages.map((p) => `--- page ${p.page} ---\n${p.text}`).join("\n\n")}` });
  content.push({
    type: "text",
    text: `This is ${what} for a residential project. List every piece of equipment the electrical contractor must provide power for.

Include: kitchen appliances (range, cooktop, wall ovens, steam/speed ovens, warming drawer, dishwasher, disposal, refrigerator/freezer/wine units, microwave, hood/ventilation, ice maker), laundry (washer, dryer), water heaters, HVAC (heat pumps, condensers, air handlers, furnaces, boilers, mini-split heads, ERV/HRV, fan coils, dehumidifiers), pumps (circulators, recirc, sump, well), snow-melt, radiant heat, EV chargers, pool/spa/steam equipment and anything else needing a circuit.
- Use the electrical data in the document (volts, phase, FLA/MCA, MOCP). If it is missing, use a typical residential value and set from_spec false.
- Gas appliances that need 120V (gas range, furnace, boiler, gas water heater, gas dryer) are included with gas_fired true.
- One entry per physical unit (two identical condensers = two entries). Combined units on one circuit (e.g. a range and its hood) stay separate entries.
- Ranges, ovens, cooktops and dryers on 240V need a neutral. Outdoor condensers / heat pumps need a disconnect.
- Room numbers available on this job: ${rooms.map((r) => `${r.number} ${r.name}`).join("; ") || "(none yet)"}.`,
  });
  const res = await callClaude({ system: withSpecs(specText), content, schema: LOADS_SCHEMA, effort: "high" });
  return { ...res.data, usage: { ...res.usage, cost_usd: +(res.usage.input * PRICE_IN + res.usage.output * PRICE_OUT).toFixed(2) } };
}

// ---------- lighting fixture schedule (Tony, 2026-11-09) ----------
const FIXTURE_KEYS = ["recessed", "recessed_directional", "recessed_wet", "ceiling_light", "pendant", "sconce", "track_light", "under_cabinet", "lit_mirror", "fluorescent", "ceiling_fan", "exhaust_fan", "other"];
const FIXTURE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["fixtures", "notes"],
  properties: {
    fixtures: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["tag", "description", "manufacturer", "model", "type", "control", "watts", "volts", "location", "notes"],
        properties: {
          tag: { type: "string", description: "Fixture type mark as used on the plans, e.g. 'A1', 'F3', 'L-2'" },
          description: { type: "string" },
          manufacturer: { type: "string" },
          model: { type: "string", description: "Catalog / model number as written" },
          type: { type: "string", enum: FIXTURE_KEYS, description: "Closest takeoff fixture type" },
          control: { type: "string", enum: ["", "dpm", "ketra", "dali", "lumaris", "wall"], description: "ketra = Lutron Ketra; dali = DALI / DALI-2 driver; lumaris = Lutron Lumaris tape; dpm = phase/ELV/0-10V dimmed through lighting control; '' = not stated" },
          watts: { type: "number", description: "Watts per fixture (0 if not stated)" },
          volts: { type: "number", description: "Volts (0 if not stated)" },
          location: { type: "string", description: "Where it is used, if the schedule says" },
          notes: { type: "string" },
        },
      },
    },
    notes: { type: "array", items: { type: "string" } },
  },
};
export async function extractFixtures({ filename, pdfB64, pages, specText }) {
  const content = [];
  if (pdfB64) content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfB64 } });
  else content.push({ type: "text", text: `Extracted text of "${filename}", page by page:\n\n${pages.map((p) => `--- page ${p.page} ---\n${p.text}`).join("\n\n")}` });
  content.push({ type: "text", text: `This is a lighting fixture schedule (or a document containing one) for a residential project. List every fixture type in it, one entry per type mark (tag), exactly as the schedule shows it.
- Copy the tag, description, manufacturer and model as written.
- Pick the closest takeoff type. Recessed downlights and cans are "recessed"; adjustable/gimbal/directional recessed are "recessed_directional"; wet-location / shower recessed are "recessed_wet".
- Control: "ketra" for Lutron Ketra fixtures; "dali" when the driver or notes say DALI or DALI-2; "lumaris" for Lutron Lumaris tape; "dpm" for fixtures dimmed through the lighting control (phase, ELV, 0-10V); "" when the schedule doesn't say.
- Watts and volts per fixture when stated, else 0.
- Put anything else useful (finish, CCT, mounting, quantity notes) in notes.` });
  const res = await callClaude({ system: withSpecs(specText), content, schema: FIXTURE_SCHEMA, effort: "medium" });
  return { ...res.data, usage: { ...res.usage, cost_usd: +(res.usage.input * PRICE_IN + res.usage.output * PRICE_OUT).toFixed(2) } };
}

// ---------- zoning ----------
const ZONE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["zones"],
  properties: {
    zones: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["name", "room_number", "control", "device_ids", "reason", "exterior"],
        properties: {
          name: { type: "string", description: "Short zone name, e.g. 'Play Room Recessed'" },
          exterior: { type: "boolean", description: "true for exterior fixtures (outside the building walls) zoned by wall face" },
          room_number: { type: "string", description: "Room number or '' if the room has none" },
          control: { type: "string", enum: ["dpm", "dali", "ketra", "wall"] },
          device_ids: { type: "array", items: { type: "integer" } },
          reason: { type: "string", description: "One short sentence on why these fixtures are one zone" },
        },
      },
    },
  },
};

/**
 * Group light fixtures on one sheet into lighting zones (loads).
 * @param lights  [{id, type, label, room, x, y, note}] fixtures to zone (x/y in feet)
 * @param controls [{type, room, x, y}] wall control locations for context
 */
export async function autoZone({ sheet, rooms, lights, controls, specText, defaultControl, ketraTypes, daliTypes = [], mixedTypes = [] }) {
  const fmt = (d) => `#${d.id} ${d.label}${d.room ? ` in ${d.room}` : ""} at (${d.x.toFixed(0)} ft, ${d.y.toFixed(0)} ft)${d.note ? ` [${d.note}]` : ""}`;
  const text = `Group the light fixtures on sheet ${sheet.sheet_no || sheet.page} (${sheet.level || "unknown level"}) into lighting zones.

A zone is one controlled load: the fixtures that dim/switch together on one dimmer output.
Guidance:
- A zone NEVER crosses rooms: every fixture in a zone must be in the same room. No zone may turn on lights in two separate rooms (closets, WCs, halls and adjoining spaces each get their own zones).
- Fixtures of the SAME TYPE in the SAME ROOM go in ONE zone (e.g. all the recessed cans along a hallway are one zone). Never give a fixture its own zone when other fixtures of the same type are in its room. Splitting zones per fixture is a costly estimating error.
- Only split one room's same-type fixtures into two zones when the room is large with clearly distinct areas (e.g. a great room's seating vs. dining, a theater's perimeter vs. center) or has more than about 10 of them.
- Different fixture types in a room are separate zones (recessed, sconces, pendants, LED tape/under-cabinet, vanity/lit mirror, surface fixtures).
- Ceiling fans and exhaust fans are their own zone each.
- Every fixture id must appear in exactly one zone.
- Never mix Ketra or DALI-2 fixtures with other fixtures in one zone.
- Exterior lighting (fixtures outside the building walls: wall sconces/coach lights, soffit or eave lights, porch and deck lights): fixtures of the same type on the SAME WALL FACE of the building are ONE zone, even though they sit outside different rooms. Each wall face (elevation side) is its own zone. Set exterior true, room_number '' and name it by the face, e.g. 'Exterior North Wall Sconces'. Interior zones have exterior false.
- Control: default "${defaultControl}". ${ketraTypes.length ? `Fixture types ${ketraTypes.join(", ")} are Ketra: their zones are "ketra".` : ""} ${daliTypes.length ? `Fixture types ${daliTypes.join(", ")} are DALI-2: their zones are "dali".` : ""} ${mixedTypes.length ? `Fixture types ${mixedTypes.join(", ")} can be Ketra OR DALI-2 on this job: read the fixture schedule, legend, type tags and notes on the sheet to decide each fixture, make their zones "ketra" or "dali" accordingly, never put Ketra and DALI-2 fixtures in one zone, and when nothing on the sheet says, use "dali" and note "Ketra or DALI-2 not shown, check" on the zone.` : ""} Use "wall" only for loads controlled by a local switch outside the lighting-control system (e.g. exhaust fans on their own switch, if the spec says so).

Rooms: ${rooms.map((r) => `${r.number ? r.number + " " : ""}${r.name}`).join("; ")}

Wall control locations (switches/keypads) for context:
${controls.map((c) => `${c.label}${c.room ? ` in ${c.room}` : ""} at (${c.x.toFixed(0)} ft, ${c.y.toFixed(0)} ft)`).join("\n") || "(none)"}

Light fixtures:
${lights.map(fmt).join("\n")}`;
  const res = await callClaude({ system: withSpecs(specText), content: [{ type: "text", text }], schema: ZONE_SCHEMA, effort: "medium" });
  return { zones: res.data.zones, usage: { ...res.usage, cost_usd: +(res.usage.input * PRICE_IN + res.usage.output * PRICE_OUT).toFixed(2) } };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

/**
 * @param sheet     sheet row (width/height in PDF points)
 * @param overview  {png, w, h} whole-sheet image
 * @param tiles     [{png, w, h, x0, y0, x1, y1, cx0, cy0, cx1, cy1}] tile bounds and "core" bounds in PDF points
 * @param textItems [{i, s, x, y}] PDF text in points (top-left origin)
 */
export async function analyzeSheet({ sheet, overview, tiles, textItems, specText = "", lookfor = [] }) {
  // The estimator's "Look for" list: only these device types, with what each symbol looks like on this job.
  const lookText = lookfor.length ? `The estimator only wants these device types counted. Report nothing else:\n${lookfor.map((l) => `- ${l.type}${l.label ? ` (${l.label})` : ""}${l.note ? `: ${l.note}` : ""}`).join("\n")}` : "";
  const usage = { input: 0, output: 0 };
  const add = (u) => { usage.input += u.input; usage.output += u.output; };

  const ov = await overviewPass({ sheet, overview, textItems, specText, lookText });
  add(ov.usage);
  const byIndex = new Map(textItems.map((t) => [t.i, t]));

  // Room label positions come from the PDF text, so they are exact.
  const rooms = ov.data.rooms.map((r) => {
    const pts = r.label_items.map((i) => byIndex.get(i)).filter(Boolean);
    const x = pts.length ? pts.reduce((a, p) => a + p.x, 0) / pts.length : null;
    const y = pts.length ? pts.reduce((a, p) => a + p.y, 0) / pts.length : null;
    return { number: r.number.trim(), name: r.name.trim(), x, y };
  }).filter((r) => r.name);

  const tileResults = await mapLimit(tiles, TILE_CONCURRENCY, async (tile, idx) => {
    const sx = tile.w / (tile.x1 - tile.x0), sy = tile.h / (tile.y1 - tile.y0);
    const roomsInTile = rooms
      .filter((r) => r.x != null && r.x >= tile.x0 && r.x <= tile.x1 && r.y >= tile.y0 && r.y <= tile.y1)
      .map((r) => ({ ...r, px: (r.x - tile.x0) * sx, py: (r.y - tile.y0) * sy }));
    const res = await tilePass({ tile, legend: ov.data.legend, roomsInTile, levelName: ov.data.level_name, idx, total: tiles.length, specText, lookText });
    add(res.usage);
    // Convert to sheet points; keep only devices in this tile's core so overlaps are not double counted.
    return res.data.devices
      .map((d) => ({ ...d, x: tile.x0 + d.x / sx, y: tile.y0 + d.y / sy }))
      .filter((d) => d.x >= tile.cx0 && d.x < tile.cx1 && d.y >= tile.cy0 && d.y < tile.cy1);
  });

  const devices = dedupe(tileResults.flat());
  return {
    sheet_title: ov.data.sheet_title,
    level_name: ov.data.level_name,
    is_electrical_plan: ov.data.is_electrical_plan,
    scale_text: ov.data.scale_text,
    legend: ov.data.legend,
    notes: ov.data.notes,
    equipment: ov.data.equipment.map((e) => {
      const pts = e.label_items.map((i) => byIndex.get(i)).filter(Boolean);
      return { kind: e.kind, label: e.label, x: pts.length ? pts.reduce((a, p) => a + p.x, 0) / pts.length : null, y: pts.length ? pts.reduce((a, p) => a + p.y, 0) / pts.length : null };
    }),
    generator_evidence: ov.data.generator_evidence,
    rooms,
    devices,
    usage: { ...usage, cost_usd: +(usage.input * PRICE_IN + usage.output * PRICE_OUT).toFixed(2), model: MODEL },
  };
}

/** Drop near-duplicate detections of the same type (within ~4 pt) that can survive at tile seams. */
function dedupe(devs) {
  const kept = [];
  for (const d of devs.sort((a, b) => b.confidence - a.confidence)) {
    if (!kept.some((k) => k.type === d.type && Math.hypot(k.x - d.x, k.y - d.y) < 4)) kept.push(d);
  }
  return kept;
}
