// Canonical device types the takeoff counts, and the default assembly for each.
// Assembly lines with `match` are linked to your D-Tools catalog on import
// (manufacturer exact, model prefix). Lines without a catalog link use their own unit_cost.

export const DEVICE_TYPES = [
  // key, label, short code drawn on marker, colour, group, plan-symbol hint for Claude
  { key: "receptacle", label: "Duplex receptacle", code: "R", color: "#2563eb", group: "Power", hint: "circle with two parallel lines through it (duplex outlet), wall-mounted" },
  { key: "receptacle_gfci", label: "GFCI receptacle", code: "GF", color: "#0891b2", group: "Power", hint: "duplex receptacle symbol tagged GFI/GFCI" },
  { key: "receptacle_afci", label: "AFCI receptacle", code: "AF", color: "#0e7490", group: "Power", hint: "duplex receptacle tagged AFCI" },
  { key: "receptacle_usb", label: "USB receptacle", code: "U", color: "#4f46e5", group: "Power", hint: "duplex receptacle tagged USB" },
  { key: "receptacle_floor", label: "Floor receptacle", code: "FR", color: "#7c3aed", group: "Power", hint: "receptacle symbol inside a square/box in the floor area, floor mounted" },
  { key: "receptacle_240", label: "220/240V outlet", code: "240", color: "#9333ea", group: "Power", hint: "receptacle with three lines or labelled 220V/240V, range/dryer" },
  { key: "receptacle_ceiling", label: "Ceiling outlet", code: "CR", color: "#6d28d9", group: "Power", hint: "outlet noted in ceiling e.g. for projector or garage door opener" },
  { key: "switch", label: "Single-pole switch", code: "S", color: "#dc2626", group: "Switching", hint: "$ or S symbol" },
  { key: "switch_dimmer", label: "Dimmer", code: "D", color: "#e11d48", group: "Switching", hint: "$ with D subscript / 'single pole switch with dimmer'" },
  { key: "switch_3way", label: "3-way switch", code: "S3", color: "#ea580c", group: "Switching", hint: "$ with subscript 3" },
  { key: "switch_4way", label: "4-way switch", code: "S4", color: "#c2410c", group: "Switching", hint: "$ with subscript 4" },
  { key: "keypad", label: "Keypad / lighting control", code: "K", color: "#be123c", group: "Switching", hint: "small square with K, keypad light switch" },
  { key: "motion_sensor", label: "Motion / vacancy sensor", code: "M", color: "#b91c1c", group: "Switching", hint: "$ with MD, motion detector" },
  { key: "recessed", label: "Recessed light", code: "RL", color: "#ca8a04", group: "Lighting", hint: "small square or circle with an X or dot, ceiling, recessed can" },
  { key: "recessed_directional", label: "Directional recessed", code: "DR", color: "#a16207", group: "Lighting", hint: "recessed light symbol with arrow/tick showing aim direction" },
  { key: "recessed_wet", label: "Wet-rated shower light", code: "WL", color: "#854d0e", group: "Lighting", hint: "recessed waterproof shower light, square in square" },
  { key: "ceiling_light", label: "Ceiling-mounted light", code: "CL", color: "#d97706", group: "Lighting", hint: "circle with a cross / crosshair, surface ceiling fixture" },
  { key: "pendant", label: "Pendant", code: "P", color: "#b45309", group: "Lighting", hint: "filled/patterned circle or diamond, pendant light" },
  { key: "sconce", label: "Wall sconce", code: "SC", color: "#f59e0b", group: "Lighting", hint: "half circle or circle on a stem against a wall, wall-mounted sconce" },
  { key: "track_light", label: "Track light", code: "TR", color: "#92400e", group: "Lighting", hint: "line with small circles/heads, track" },
  { key: "under_cabinet", label: "Under-cabinet / LED tape", code: "UC", color: "#65a30d", group: "Lighting", hint: "dashed line labelled LED or 'LED under cabinet light' (count each run once)" },
  { key: "lit_mirror", label: "Lit mirror / vanity feed", code: "LM", color: "#4d7c0f", group: "Lighting", hint: "note 'LIT MIRROR', or vanity light over mirror" },
  { key: "fluorescent", label: "Surface strip / fluorescent", code: "FL", color: "#78716c", group: "Lighting", hint: "long rectangle, surface mounted fluorescent / LED strip" },
  { key: "ceiling_fan", label: "Ceiling fan", code: "CF", color: "#059669", group: "Fans & Safety", hint: "fan blades symbol, ceiling fan with optional light" },
  { key: "exhaust_fan", label: "Exhaust fan", code: "EF", color: "#047857", group: "Fans & Safety", hint: "circle or square with fan/F inside, bath exhaust fan" },
  { key: "smoke_co", label: "Smoke / CO detector", code: "SD", color: "#dc2626", group: "Life safety", hint: "circle labelled SD / S/CO / SC" },
  { key: "data", label: "Structured wiring / data", code: "DA", color: "#0284c7", group: "Low voltage", hint: "triangle or box labelled SW / data / TV / phone" },
  { key: "other", label: "Other / unknown", code: "?", color: "#64748b", group: "Other", hint: "any other electrical symbol; describe it in the note" },
];

// Wire SOP: power items are 20A circuits, minimum 12 AWG (12/2 NM-B).
// Lighting items are 15A circuits on 14 AWG (14/2 NM-B; 14/3 where a traveler/interconnect is needed).
const POWER = ["receptacle", "receptacle_gfci", "receptacle_afci", "receptacle_usb", "receptacle_floor", "receptacle_240", "receptacle_ceiling"];
const LIGHTING = ["switch", "switch_dimmer", "switch_3way", "switch_4way", "keypad", "motion_sensor", "recessed", "recessed_directional",
  "recessed_wet", "ceiling_light", "pendant", "sconce", "track_light", "under_cabinet", "lit_mirror", "fluorescent", "ceiling_fan", "exhaust_fan", "smoke_co"];
for (const t of DEVICE_TYPES) t.circuit = POWER.includes(t.key) ? "power" : LIGHTING.includes(t.key) ? "lighting" : "other";

export const TYPE_KEYS = DEVICE_TYPES.map((t) => t.key);

// Helper builders for assembly lines.
const cat = (manufacturer, model, qty, description, unit_cost, phase) => ({
  match: { manufacturer, model }, catalog_id: null, description, qty, unit_cost, phase,
});
const generic = (description, qty, unit_cost, labor_hours, phase) => ({
  catalog_id: null, description, qty, unit_cost, labor_hours, phase,
});

const R = "Rough", F = "Finish";
const NM12 = (ft) => cat("Multiple", "12/2 NM-B - Solid Copper Yellow 1000'", ft, "12/2 NM-B (ft)", 0.5, R);
const NM14 = (ft) => cat("Multiple", "14/2 NM-B - Solid Copper White 1000'", ft, "14/2 NM-B (ft)", 0.38, R);
const NM143 = (ft) => cat("Multiple", "14/3 NM-B - Solid Copper White 250'", ft, "14/3 NM-B (ft)", 0.45, R);
const BOX1 = cat("Carlon", "Switch/Outlet Box, 1-Gang, New Work, Non-Metallic", 1, "1-gang new work box", 1.03, R);
const CEILBOX = cat("Carlon", "4'' Round Ceiling/Fixture Box with Bar Hanger", 1, "4\" round ceiling box w/ bar hanger", 6.4, R);
const PLATE1 = cat("Leviton", "Decora Wallplate, 1-Gang, Thermoset, White", 1, "Decora plate 1-gang", 0.27, F);
const WIRENUTS = generic("Wire nuts / connectors (allowance)", 1, 0.6, 0, R);

export const DEFAULT_ASSEMBLIES = {
  receptacle: [BOX1, NM12(15), cat("Leviton", "15A Decora Edge TR Receptacle, White", 1, "Decora TR receptacle", 3.06, F), PLATE1, WIRENUTS],
  receptacle_gfci: [BOX1, NM12(15), cat("Leviton", "15A, GFCI, 125V Tamper-Resistant Receptacle", 1, "GFCI TR receptacle", 27.87, F), PLATE1, WIRENUTS],
  receptacle_afci: [BOX1, NM12(15), generic("AFCI receptacle", 1, 38, 0.25, F), PLATE1, WIRENUTS],
  receptacle_usb: [BOX1, NM12(15), cat("Leviton", "15A, Decora 125V, USB-C Charger TR", 1, "USB-C TR receptacle", 41.86, F), PLATE1, WIRENUTS],
  receptacle_floor: [cat("Carlon", "Adjustable Floor Box, 1-Gang, Duplex, Brass", 1, "Floor box, brass", 166.96, R), NM12(20), cat("Leviton", "15A Decora Edge TR Receptacle, White", 1, "Decora TR receptacle", 3.06, F), WIRENUTS],
  receptacle_240: [generic("2-gang box / 240V receptacle box", 1, 4, 0.1, R), generic("10/3 NM-B (ft)", 30, 1.6, 0.04, R), generic("30A 240V receptacle", 1, 14, 0.4, F), generic("2-pole breaker allowance", 1, 18, 0.25, R)],
  receptacle_ceiling: [CEILBOX, NM12(20), cat("Leviton", "15A Decora Edge TR Receptacle, White", 1, "Decora TR receptacle", 3.06, F), WIRENUTS],
  switch: [BOX1, NM14(15), cat("Leviton", "15A Decora Edge Rocker Switch, White", 1, "Decora Edge switch", 2.9, F), PLATE1, WIRENUTS],
  switch_dimmer: [BOX1, NM14(15), cat("Leviton", "Decora Digital Universal Dimmer", 1, "Universal dimmer", 26.11, F), PLATE1, WIRENUTS],
  switch_3way: [BOX1, NM143(20),cat("Leviton", "15A Decora Edge Rocker Switch, 3-Way, White", 1, "Decora Edge 3-way", 3.39, F), PLATE1, WIRENUTS],
  switch_4way: [BOX1, NM143(20),cat("Leviton", "4-Way Decora White", 1, "Decora 4-way", 6.97, F), PLATE1, WIRENUTS],
  keypad: [BOX1, NM14(15), generic("Keypad (select in catalog)", 1, 0, 0.5, F), WIRENUTS],
  motion_sensor: [BOX1, NM14(15), generic("Vacancy/occupancy sensor switch", 1, 28, 0.25, F), PLATE1, WIRENUTS],
  recessed: [NM14(12), generic("Recessed light (owner select / allowance)", 1, 0, 0.5, F), WIRENUTS],
  recessed_directional: [NM14(12), generic("Directional recessed (allowance)", 1, 0, 0.5, F), WIRENUTS],
  recessed_wet: [NM14(12), generic("Wet-rated recessed shower light (allowance)", 1, 0, 0.5, F), WIRENUTS],
  ceiling_light: [CEILBOX, NM14(12), generic("Ceiling fixture install (fixture by owner)", 1, 0, 0.5, F), WIRENUTS],
  pendant: [CEILBOX, NM14(12), generic("Pendant install (fixture by owner)", 1, 0, 0.75, F), WIRENUTS],
  sconce: [generic("Sconce box (1-gang / pancake)", 1, 2.5, 0.1, R), NM14(12), generic("Sconce install (fixture by owner)", 1, 0, 0.5, F), WIRENUTS],
  track_light: [CEILBOX, NM14(12), generic("Track install (fixture by owner)", 1, 0, 1, F), WIRENUTS],
  under_cabinet: [NM14(15), generic("LED driver/tape run (allowance)", 1, 45, 1, F), WIRENUTS],
  lit_mirror: [BOX1, NM14(12), generic("Lit mirror / vanity connection", 1, 0, 0.5, F), WIRENUTS],
  fluorescent: [NM14(12), generic("Surface strip fixture (allowance)", 1, 40, 0.5, F), WIRENUTS],
  ceiling_fan: [generic("Fan-rated ceiling box", 1, 12, 0.15, R), NM143(15),generic("Ceiling fan assemble & hang (fan by owner)", 1, 0, 1.25, F), WIRENUTS],
  exhaust_fan: [NM14(15), cat("Panasonic", "WhisperCeiling DC, Exhaust Fan", 1, "Panasonic WhisperCeiling DC", 129.68, F), WIRENUTS],
  smoke_co: [generic("Smoke/CO ring box", 1, 1.5, 0.08, R), NM143(20),cat("Kidde Fire", "Hardwired Smoke & Carbon Monoxide Detector", 1, "Hardwired smoke/CO", 70.73, F)],
  data: [generic("Low-voltage ring / mud ring", 1, 0.8, 0.08, R), generic("Cat6 (ft)", 60, 0.18, 0.01, R), generic("Data jack + plate", 1, 6, 0.25, F)],
  other: [generic("Unclassified device (review)", 1, 0, 0.5, F)],
};
