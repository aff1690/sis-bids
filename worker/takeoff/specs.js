// Job specifications: reusable company standards that decide which parts a takeoff uses,
// how lighting control is built (standard / RF / panelized), which electrical panel is used,
// and what Claude is told.
//
// Layering for a job: base assemblies -> devices spec -> lighting-control spec overrides.
// System equipment (processors, DPMs, panels, breakers, home runs) is sized from zones, circuits
// and the panel / riser locations placed on each sheet.
import { db, findCatalog, jobSettings } from "./db.js";
import { computeTape } from "./tape.js";

export const FIXTURE_TYPES = ["recessed", "recessed_directional", "recessed_wet", "ceiling_light", "pendant", "sconce",
  "track_light", "under_cabinet", "lit_mirror", "fluorescent", "ceiling_fan", "exhaust_fan"];
export const CONTROL_TYPES = ["switch", "switch_dimmer", "switch_3way", "switch_4way", "keypad", "motion_sensor"];
export const ZONE_CONTROLS = ["dpm", "dali", "ketra", "lumaris", "wall"]; // dpm & dali home-run to the DIN panel
const CONSTANT_POWER_RF = ["ketra", "lumaris"]; // wireless, constant power from the PD8 distribution section
const POWER_TYPES = ["receptacle", "receptacle_usb", "receptacle_afci", "receptacle_floor", "receptacle_ceiling"];

export const BASES = {
  job: "Once per job",
  dpm: "Per dimming DPM",
  dpm_switching: "Per switching DPM",
  dali_module: "Per DALI-2 module",
  panel: "Per DPM panel",
  dpm_zone: "Per wired zone",
  dpm_home_run_ft: "Per foot of zone home run",
  dali_bus_ft: "Per foot of DALI bus run",
  pd8_circuit: "Per Ketra/DALI circuit (PD8 distribution)",
  pd8_circuit_home_run_ft: "Per foot of Ketra/DALI circuit home run",
  dpm_feeder_ft: "Per foot of DPM panel feeder",
  rf_processor: "Per RF processor",
  rf_device: "Per RF device",
  elec_panel: "Per electrical panel",
  power_circuit: "Per 20A power circuit",
  gfci_circuit: "Per 20A GFCI-area circuit",
  lighting_circuit: "Per 15A lighting circuit",
  safety_circuit: "Per life-safety (smoke/CO) circuit",
  safety_home_run_ft: "Per foot of life-safety home run",
  circuit_240: "Per 240V circuit",
  pd8_feed: "Per PD8 feed (50A 2-pole breaker)",
  power_home_run_ft: "Per foot of power home run",
  lighting_home_run_ft: "Per foot of lighting home run",
  // LED tape specs
  tape_ft: "Per foot of tape",
  tape_segment: "Per tape segment (feed point)",
  tape_run: "Per tape run",
  tape_driver: "Per driver / power interface",
  channel_piece: "Per channel piece",
  class2_ft: "Per foot of Class 2 feed",
  // backup power specs
  backup_unit: "Per battery / generator unit",
  backup_expansion: "Per battery expansion",
};

export const DEFAULT_RULES = {
  zones_per_dpm: 4,             // each DPM controls 4 zones
  dpms_per_panel: 8,            // PD8-65A-120L3-15 holds 8 DPMs (DALI modules share the slots)
  pd8_circuits_per_panel: 4,    // distribution section at the bottom of each PD8: Ketra/DALI constant-power circuits
  dpm_feeder_spaces: 2,         // breaker spaces each PD8 feeder takes in the electrical panel
  panel_spaces: 42,             // electrical panel spec: breaker spaces available
  dali_fixtures_per_module: 64, // DALI-2 loop address limit
  rf_devices_per_processor: 50, // company standard
  rf_range_ft: 75,              // max distance from processor (less through dense materials)
  rf_device_types: [],          // device types that are RF devices under this spec
  switched_types: ["exhaust_fan"], // loads on switching DPMs (LQSE-4S8) instead of dimming DPMs
  default_zone_control: "wall", // dpm | dali | ketra | wall
  zoning_required: false,       // panelized: lights must be zoned before the DPM count is valid
  receptacles_per_circuit: 10,  // panel specs: general receptacles per 20A circuit
  fixture_watts: 20,            // panel specs: LED fixture load for sizing lighting circuits
  lighting_circuit_amps: 15,
  continuous_load_pct: 80,      // lighting is a continuous load: 80% of the breaker
  kitchen_sa_circuits: 2,       // 20A small-appliance circuits per kitchen (NEC 210.11(C)(1))
  laundry_circuits: 1,          // 20A laundry circuit (NEC 210.11(C)(2))
  breaker_family: "eaton_br",   // eaton_br | leviton: used to pick dedicated-circuit breakers
  // LED tape specs
  tape_type: "lucetta",         // lucetta (driver on a DPM zone) | lumaris (power interface, wireless, constant power)
  watts_per_ft: 3.3,
  max_run_ft: 16.4,             // feed again every 16.4 ft
  driver_watts: 96,             // driver or power-interface size
  driver_load_pct: 80,
  class2_max_watts: 100,        // per Class 2 output
  class2_feed_ft: 15,           // driver to each segment's feed point
  channel_piece_ft: 8,          // channel sold in 96" pieces
  vdrop_pct: 3,                 // Class 2 feed voltage-drop limit (sets the feed gauge)
  // backup power specs: feeder from each unit placed on the plan to the nearest electrical panel
  feeder_breaker: 60,           // amps, 2-pole
  feeder_neutral: true,
  feeder_disconnect: false,
};

// ---------- starter specs ----------
const L = (part_number, qty, description, unit_cost, phase, extra = {}) => ({ match: { part_number }, catalog_id: null, description, qty, unit_cost, phase, ...extra });
const G = (description, qty, unit_cost, labor_hours, phase, extra = {}) => ({ catalog_id: null, description, qty, unit_cost, labor_hours, phase, ...extra });
const R = "Rough", F = "Finish", S = "System";
const BOX1 = { match: { manufacturer: "Carlon", model: "Switch/Outlet Box, 1-Gang, New Work, Non-Metallic" }, catalog_id: null, description: "1-gang new work box", qty: 1, unit_cost: 1.03, phase: R };
const NM12 = (ft) => ({ match: { manufacturer: "Multiple", model: "12/2 NM-B - Solid Copper Yellow 1000'" }, catalog_id: null, description: "12/2 NM-B (ft)", qty: ft, unit_cost: 0.5, phase: R });
const NM14 = (ft) => ({ match: { manufacturer: "Multiple", model: "14/2 NM-B - Solid Copper White 1000'" }, catalog_id: null, description: "14/2 NM-B (ft)", qty: ft, unit_cost: 0.38, phase: R });
const NM143 = (ft) => ({ match: { manufacturer: "Multiple", model: "14/3 NM-B - Solid Copper White 250'" }, catalog_id: null, description: "14/3 NM-B (ft)", qty: ft, unit_cost: 0.45, phase: R });
const NUTS = G("Wire nuts / connectors (allowance)", 1, 0.6, 0, R);
const SW_PLATE = L("SC-1-SW", 1, "Lutron screwless plate 1-gang, Snow White", 7, F);
const LV_RING = G("Low-voltage mounting bracket / ring", 1, 0.8, 0.08, R);
const QS_CABLE = (ft) => G("Lutron QS link cable, GRX-CBL-346S or equal (ft)", ft, 0.55, 0.01, R);
const HQWD = L("HQWD-W6BRL-SW", 1, "HomeWorks QS wired seeTouch 6-button R/L keypad, Snow White", 191.25, F);
const HOME_RUNS = (power, lighting) => [
  { ...NM12(1), description: "12/2 NM-B home runs, power circuits to panel (ft)", basis: "power_home_run_ft" },
  { ...NM14(1), description: "14/2 NM-B home runs, lighting circuits to panel (ft)", basis: "lighting_home_run_ft" },
  { ...power, basis: "power_circuit" }, { ...power, basis: "gfci_circuit" }, { ...lighting, basis: "lighting_circuit" },
  { ...NM143(1), description: "14/3 NM-B home runs, life-safety smoke/CO circuits (ft)", basis: "safety_home_run_ft" },
  { ...lighting, description: `${lighting.description}, life-safety smoke/CO circuit`, basis: "safety_circuit" },
];

const STARTERS = [
  {
    seed_key: "devices-leviton-edge-white", version: 1, name: "Leviton Decora Edge - White", category: "devices",
    data: { description: "Standard devices: Leviton Decora Edge, white, Leviton thermoset plates. (These are the base assemblies.)", claude_notes: "", overrides: {}, system_items: [], rules: {} },
  },
  {
    seed_key: "devices-lutron-claro-snow", version: 1, name: "Lutron Claro / Diva - Snow White", category: "devices",
    data: {
      description: "All wiring devices Lutron: Claro TR receptacles, Lutron GFCI, Claro switches, Diva LED+ dimmers, screwless Snow White plates.",
      claude_notes: "Wiring devices are Lutron. Identify receptacles, GFCIs, switches and dimmers as drawn; brand does not change symbols.",
      overrides: {
        receptacle: [BOX1, NM12(15), L("SCRS-15-TR-SW", 1, "Lutron 15A TR receptacle, Snow White", 22.68, F), SW_PLATE, NUTS],
        receptacle_gfci: [BOX1, NM12(15), L("NTR-20-GFST-SW", 1, "Lutron 20A self-test GFCI, Snow White", 63, F), SW_PLATE, NUTS],
        switch: [BOX1, NM14(15), L("SC-1PS-SW", 1, "Claro 1-pole, Snow White", 14.98, F), SW_PLATE, NUTS],
        switch_dimmer: [BOX1, NM14(15), L("DVSCCL-153P-SW", 1, "Diva LED+ dimmer, Snow White", 29.64, F), SW_PLATE, NUTS],
        switch_3way: [BOX1, NM143(20), L("SC-3PS-SW", 1, "Claro 3-way, Snow White", 15.76, F), SW_PLATE, NUTS],
        switch_4way: [BOX1, NM143(20), L("SC-4PS-SW", 1, "Claro 4-way, Snow White", 20.64, F), SW_PLATE, NUTS],
      },
      system_items: [], rules: {},
    },
  },
  {
    seed_key: "lighting-standard", version: 1, name: "Standard switching", category: "lighting",
    data: {
      control: "standard", description: "Conventional switches and dimmers at each control location. No lighting-control system.",
      claude_notes: "Standard switching: each switch symbol is a switch or dimmer controlling the lights near it.",
      overrides: {}, system_items: [], rules: { default_zone_control: "wall" },
    },
  },
  {
    seed_key: "lighting-hw-rf", version: 1, name: "HomeWorks QSX - RF (Sunnata)", category: "lighting",
    data: {
      control: "rf",
      description: "HomeWorks QSX wireless: Sunnata RF dimmers/switches at each control location (neutral required), companion dimmers at 3/4-way locations, RF keypads. Every RF device counts toward the processor limit.",
      claude_notes: "HomeWorks RF: every switch, dimmer and keypad location is an RF device. Count each control location carefully; 3-way and 4-way locations become companion dimmers.",
      overrides: {
        switch: [BOX1, NM14(15), L("HRST-8ANS-SW", 1, "HomeWorks Sunnata 8A neutral switch, Snow White", 153.5, F), SW_PLATE, NUTS],
        switch_dimmer: [BOX1, NM14(15), L("HRST-PRO-N-SW", 1, "HomeWorks Sunnata PRO neutral dimmer, Snow White", 146.5, F), SW_PLATE, NUTS],
        switch_3way: [BOX1, NM143(20), L("HRST-RD-SW", 1, "HomeWorks Sunnata companion dimmer, Snow White", 57.23, F), SW_PLATE, NUTS],
        switch_4way: [BOX1, NM143(20), L("HRST-RD-SW", 1, "HomeWorks Sunnata companion dimmer, Snow White", 57.23, F), SW_PLATE, NUTS],
        keypad: [BOX1, NM14(15), L("HQRD-W6BRL-SW", 1, "HomeWorks RF seeTouch 6-button R/L keypad, Snow White", 250, F), SW_PLATE, NUTS],
      },
      system_items: [{ ...L("HQP7-RF-2", 1, "HomeWorks QSX dual-radio RF processor", 852.5, S), basis: "rf_processor" }],
      rules: { rf_device_types: ["switch", "switch_dimmer", "keypad", "motion_sensor"], default_zone_control: "wall" },
    },
  },
  {
    seed_key: "lighting-hw-panelized", version: 4, name: "HomeWorks QSX - Panelized (DPM)", category: "lighting",
    data: {
      control: "panelized",
      description: "HomeWorks QSX panelized: dimmed zones home-run to LQSE-4A5 DPMs, exhaust fans to LQSE-4S8 switching DPMs (4 zones each), all in PD8-65A-120L3-15 panels (8 modules each). DALI-2 fixtures are controlled by LQSE2-1DALUNV modules (64 fixtures each) over a DALI bus. Ketra and DALI-2 fixtures get constant-power lighting circuits that land in the PD8's distribution section (4 circuits per PD8). Wall locations are wired QS keypads. Ketra fixtures count toward the 50-device RF processor limit.",
      claude_notes: "HomeWorks panelized: there are no dimmers in the wall. Every switch, dimmer and keypad symbol is a wired keypad location. Lights must be grouped into zones (loads); each wired zone home-runs to the DPM panel. Exhaust fans are switched loads.",
      overrides: Object.fromEntries(["switch", "switch_dimmer", "switch_3way", "switch_4way", "keypad"].map((k) => [k, [LV_RING, QS_CABLE(50), HQWD]])),
      system_items: [
        { ...L("HQP7-2", 1, "HomeWorks QSX 2-link processor", 913, S), basis: "job" },
        { ...L("QSPS-DH-1-75-H", 1, "DIN rail QS power supply", 183.75, S), basis: "job" },
        { ...L("PD8-65A-120L3-15", 1, "PD8 DIN panel, 8 modules, built-in 15A AFCI", 2125, S), basis: "panel" },
        { ...L("PDW-QS-8", 1, "QS wire harness, 8-module panel", 140.25, S), basis: "panel" },
        { ...L("LQSE-4A5-120-D", 1, "LQSE-4A5 phase-adaptive dimming DPM (4 zones)", 540.5, S), basis: "dpm" },
        { ...L("LQSE-4S8-120-D", 1, "LQSE-4S8 switching DPM (4 zones)", 380, S), basis: "dpm_switching" },
        { ...L("LQSE2-1DALUNV-D", 1, "DALI-2 power module (Gen 2)", 2140, S), basis: "dali_module" },
        { ...NM14(1), description: "14/2 NM-B home runs, zones to DPM panel (ft)", basis: "dpm_home_run_ft" },
        { ...NM14(1), description: "14/2 NM-B home runs, Ketra/DALI circuits to PD8 distribution (ft)", basis: "pd8_circuit_home_run_ft" },
        { ...G("DALI bus cable, 2-conductor 16 AWG or equal (ft)", 1, 0.35, 0.01, R), basis: "dali_bus_ft" },
        { ...L("0070164", 1, "6/3 NM-B feeder, electrical panel to PD8, 50A 240V (ft)", 3.61, R), basis: "dpm_feeder_ft" },
        { ...L("HQP7-RF-2", 1, "HomeWorks QSX dual-radio RF processor (Ketra / RF devices)", 852.5, S), basis: "rf_processor" },
      ],
      rules: { default_zone_control: "dpm", zoning_required: true, rf_device_types: [], switched_types: ["exhaust_fan"] },
    },
  },
  {
    seed_key: "lighting-ra3", version: 1, name: "RadioRA 3 (Sunnata RF)", category: "lighting",
    data: {
      control: "rf",
      description: "RadioRA 3: Sunnata RF dimmers/switches, companion dimmers at 3/4-way locations, Sunnata RF keypads, RA3 processor.",
      claude_notes: "RadioRA 3: every switch, dimmer and keypad location is an RF device.",
      overrides: {
        switch: [BOX1, NM14(15), L("RRST-8ANS-SW", 1, "Sunnata RF switch, Snow White", 104.5, F), SW_PLATE, NUTS],
        switch_dimmer: [BOX1, NM14(15), L("RRST-PRO-N-SW", 1, "Sunnata RF PRO LED+ dimmer, Snow White", 104.5, F), SW_PLATE, NUTS],
        switch_3way: [BOX1, NM143(20), L("RRST-RD-SW", 1, "Sunnata RF companion dimmer, Snow White", 54.5, F), SW_PLATE, NUTS],
        switch_4way: [BOX1, NM143(20), L("RRST-RD-SW", 1, "Sunnata RF companion dimmer, Snow White", 54.5, F), SW_PLATE, NUTS],
        keypad: [BOX1, NM14(15), L("RRST-W3RL-SW", 1, "Sunnata RF 3-button R/L keypad, Snow White", 174.5, F), SW_PLATE, NUTS],
      },
      system_items: [{ ...L("RR-PROC3-KIT", 1, "RadioRA 3 processor kit", 249.5, S), basis: "rf_processor" }],
      rules: { rf_device_types: ["switch", "switch_dimmer", "keypad", "motion_sensor"], default_zone_control: "wall" },
    },
  },
  // ----- electrical panels -----
  {
    seed_key: "panel-span", version: 3, name: "SPAN smart panel", category: "panels",
    data: {
      description: "SPAN 48-space smart panel (200A), Eaton BR breakers: AFCI on power and lighting circuits. Default when a generator is involved.",
      claude_notes: "Electrical panel is a SPAN smart panel.",
      overrides: {},
      system_items: [
        { ...L("PL7R-48MLO225-FG", 1, "SPAN smart panel, 48 space", 3492.57, S), basis: "elec_panel" },
        { ...L("P-00FTK48-3-0", 1, "SPAN 48-space semi-recessed trim kit", 75, F), basis: "elec_panel" },
        ...HOME_RUNS(L("BRP120AF", 1, "Eaton BR 20A AFCI breaker", 38.84, F), L("BRP115AF", 1, "Eaton BR 15A AFCI breaker", 38.84, F)),
        { ...L("BR230", 1, "Eaton BR 30A 2-pole breaker", 14.59, F), basis: "circuit_240" },
        { ...L("BR250", 1, "Eaton BR 50A 2-pole breaker, PD8 feed", 14.59, F), basis: "pd8_feed" },
      ],
      rules: { receptacles_per_circuit: 10, panel_spaces: 48, breaker_family: "eaton_br" },
    },
  },
  {
    seed_key: "panel-leviton-smart", version: 3, name: "Leviton smart panel", category: "panels",
    data: {
      description: "Leviton LP 66-space load center with 2nd-gen smart breakers (AFCI on power and lighting). Default when a generator is involved.",
      claude_notes: "Electrical panel is a Leviton smart load center with smart breakers.",
      overrides: {},
      system_items: [
        { ...L("LP620-BPD", 1, "Leviton 66-space load center, 200A main", 225.72, S), basis: "elec_panel" },
        { ...L("LDC66", 1, "Leviton 66-space cover and door", 177.19, F), basis: "elec_panel" },
        { ...L("LWHEM-2", 1, "Leviton whole-home energy monitor", 218.34, F), basis: "elec_panel" },
        ...HOME_RUNS(L("LB120-AST", 1, "Leviton 20A smart AFCI breaker", 112.77, F), L("LB115-AST", 1, "Leviton 15A smart AFCI breaker", 112.77, F)),
        { ...L("LB230-T", 1, "Leviton 30A 2-pole breaker", 11.92, F), basis: "circuit_240" },
        { ...L("LB250-T", 1, "Leviton 50A 2-pole breaker, PD8 feed", 11.92, F), basis: "pd8_feed" },
      ],
      rules: { receptacles_per_circuit: 10, panel_spaces: 66, breaker_family: "leviton" },
    },
  },
  {
    seed_key: "panel-standard", version: 3, name: "Standard panel (Eaton BR)", category: "panels",
    data: {
      description: "Standard Eaton BR load center with BR breakers: AFCI on power and lighting circuits.",
      claude_notes: "Electrical panel is a standard load center.",
      overrides: {},
      system_items: [
        { ...L("1285921", 1, "Eaton BR load center 225A main lug", 517.86, S), basis: "elec_panel" },
        ...HOME_RUNS(L("BRP120AF", 1, "Eaton BR 20A AFCI breaker", 38.84, F), L("BRP115AF", 1, "Eaton BR 15A AFCI breaker", 38.84, F)),
        { ...L("BR230", 1, "Eaton BR 30A 2-pole breaker", 14.59, F), basis: "circuit_240" },
        { ...L("BR250", 1, "Eaton BR 50A 2-pole breaker, PD8 feed", 14.59, F), basis: "pd8_feed" },
      ],
      rules: { receptacles_per_circuit: 10, panel_spaces: 60, breaker_family: "eaton_br" },
    },
  },
  // ----- LED tape -----
  {
    seed_key: "tape-lucetta-argento", version: 1, name: "Lucetta Argento COB 250 (DPM)", category: "tape",
    data: {
      description: "Lucetta Argento COB 3.3 W/ft, 24V. Each run is a dimmed DPM zone feeding Lucetta Bianco U drivers (electronic/ELV dimming, never 0-10V). Feed every 16.4 ft; Class 2 from the driver to each feed point.",
      claude_notes: "LED tape is Lucetta on DPM zones.",
      overrides: {},
      system_items: [
        { ...L("LCI-24-AGT-COB-250-27-016", 1, "Lucetta Argento COB 250 tape, 2700K (ft)", 6.5, F), description: "Lucetta Argento COB 250 tape (ft)", basis: "tape_ft" },
        { ...L("LCI-BNCU-24V96W-J", 1, "Lucetta Bianco U 24V 96W driver with J-box", 158.5, F), basis: "tape_driver" },
        { ...L("LCI-CHAN-FS1-96-A", 1, "Lucetta FS1 surface channel, 96in", 38, F), basis: "channel_piece" },
        { ...L("LCI-CHAN-FS1-ACC", 1, "Channel end caps / clips set", 2.5, F), basis: "tape_run" },
        { ...G("Tape feed lead, connector and solder/termination", 1, 4, 0.25, F), basis: "tape_segment" },
        { ...G("Class 2 tape feed cable, CL2/CL3 stranded, gauge per voltage drop (ft)", 1, 0.3, 0.01, R), basis: "class2_ft" },
      ],
      rules: { tape_type: "lucetta", watts_per_ft: 3.3, max_run_ft: 16.4, driver_watts: 96, driver_load_pct: 80, class2_max_watts: 100, class2_feed_ft: 15, channel_piece_ft: 8, vdrop_pct: 3 },
    },
  },
  {
    seed_key: "tape-lutron-lumaris", version: 1, name: "Lutron Lumaris tunable white (wireless)", category: "tape",
    data: {
      description: "Lutron Lumaris tunable white tape on LU-PH3 96W power interfaces. Wireless (Clear Connect) like Ketra: constant power from the PD8 distribution section; every power interface counts toward the RF processor limit. Feed every 16.4 ft.",
      claude_notes: "LED tape is Lutron Lumaris (wireless, constant power).",
      overrides: {},
      system_items: [
        { ...L("LU-T05-TW-IN", 1, "Lumaris tunable white tape (ft)", 16.25, F), description: "Lumaris tunable white tape (ft)", basis: "tape_ft" },
        { ...L("LU-PH3-B", 1, "Lumaris LU-PH3 96W power interface", 175, F), basis: "tape_driver" },
        { ...L("LU-CK1-6W", 1, "Lumaris 6-pin tape connectors (10 pack)", 17.5, F), basis: "tape_run" },
        { ...L("LCI-CHAN-FS1-96-A", 1, "Surface channel, 96in", 38, F), basis: "channel_piece" },
        { ...G("Tape feed lead and termination", 1, 4, 0.25, F), basis: "tape_segment" },
        { ...G("Class 2 tape feed cable, gauge per voltage drop (ft)", 1, 0.3, 0.01, R), basis: "class2_ft" },
      ],
      rules: { tape_type: "lumaris", watts_per_ft: 3.6, max_run_ft: 16.4, driver_watts: 96, driver_load_pct: 80, class2_max_watts: 100, class2_feed_ft: 15, channel_piece_ft: 8, vdrop_pct: 3 },
    },
  },
  // ----- backup power -----
  {
    seed_key: "backup-powerwall3", version: 2, name: "Tesla Powerwall 3", category: "backup",
    data: {
      description: "Tesla Powerwall 3 (13.5 kWh) with Backup Gateway. Place each Powerwall on the plan; its 60A 2-pole feeder is measured to the nearest electrical panel. Pair with a SPAN or Leviton smart panel.",
      claude_notes: "Backup power is Tesla Powerwall.",
      overrides: {},
      system_items: [
        { ...L("1707000-21-y", 1, "Tesla Powerwall 3", 6500, S), basis: "backup_unit" },
        { ...L("1807000-20-y", 1, "Tesla Powerwall 3 Expansion", 6000, S), basis: "backup_expansion" },
        { ...L("1841000-02-B", 1, "Tesla Backup Gateway", 1354.55, S), basis: "job" },
      ],
      rules: { feeder_breaker: 60, feeder_neutral: true, feeder_disconnect: false },
    },
  },
  {
    seed_key: "backup-kohler-26", version: 2, name: "Kohler 26 kW generator + ATS", category: "backup",
    data: {
      description: "Kohler 26RCA cold-weather generator with a 200A service-entrance ATS and concrete pad. Place the generator on the plan; its 110A 2-pole feeder (SER) is measured to the nearest electrical panel. Pair with a SPAN or Leviton smart panel.",
      claude_notes: "Backup power is a standby generator with an automatic transfer switch.",
      overrides: {},
      system_items: [
        { ...L("26RCA-QS50", 1, "Kohler 26 kW generator, cold weather", 7118.25, S), basis: "backup_unit" },
        { ...L("RXT-JFNC-200ASEQS4", 1, "Kohler RXT 200A service-entrance ATS", 828.4, S), basis: "job" },
        { ...L("GM104820-KP2-QS", 1, "4in concrete pad", 242, S), basis: "backup_unit" },
      ],
      rules: { feeder_breaker: 110, feeder_neutral: true, feeder_disconnect: false },
    },
  },
];

/** Resolve `match` -> catalog_id on every line of a spec's data. */
async function linkSpecData(data) {
  const link = async (it) => { if (!it.catalog_id && it.match) { const hit = await findCatalog(it.match); if (hit) it.catalog_id = hit.id; } };
  for (const lines of Object.values(data.overrides || {})) for (const it of lines) await link(it);
  for (const it of data.system_items || []) await link(it);
  return data;
}

/** Insert starter specs; upgrade a starter to a newer version only if nobody has edited it. */
export async function seedSpecs() {
  const have = new Map((await db.prepare("SELECT id, data, seed_key FROM specs WHERE seed_key IS NOT NULL").all()).map((r) => [r.seed_key, r]));
  for (const s of STARTERS) {
    const row = have.get(s.seed_key);
    if (row) { const cur = JSON.parse(row.data); if (cur.user_edited || (cur.seed_version || 1) >= s.version) continue; }
    const data = JSON.stringify(await linkSpecData({ ...structuredClone(s.data), seed_version: s.version }));
    if (!row) await db.prepare("INSERT INTO specs (name, category, data, seed_key) VALUES (?, ?, ?, ?)").run(s.name, s.category, data, s.seed_key);
    else await db.prepare("UPDATE specs SET name = ?, data = ? WHERE id = ?").run(s.name, data, row.id);
  }
  await loadSpecs();
}

/** Re-link unlinked spec lines (e.g. after a catalog import). */
export async function relinkSpecs() {
  const upd = db.prepare("UPDATE specs SET data = ? WHERE id = ?");
  const writes = [];
  for (const r of await db.prepare("SELECT id, data FROM specs").all()) writes.push(upd.bind(JSON.stringify(await linkSpecData(JSON.parse(r.data))), r.id));
  await db.batch(writes);
  await loadSpecs();
}

// Specs are few and read everywhere (sizing, estimate, prompts), so each request loads them once (loadSpecs) and
// getSpec reads that copy. Anything that changes a spec calls loadSpecs again.
let specCache = new Map();
const shapeSpec = (r) => {
  const data = JSON.parse(r.data);
  return { ...r, data: { overrides: {}, system_items: [], ...data, rules: { ...DEFAULT_RULES, ...(data.rules || {}) } } };
};
export async function loadSpecs() {
  specCache = new Map((await db.prepare("SELECT * FROM specs ORDER BY category, name").all()).map((r) => [r.id, shapeSpec(r)]));
}

export function getSpec(id) {
  return (id && specCache.get(Number(id))) || null;
}

export function listSpecs() {
  return [...specCache.values()];
}

/** Fixture types that can be Ketra or DALI-2. */
export const KD_TYPES = ["recessed", "recessed_directional", "recessed_wet"];

/** The specs a job uses plus job-level options. */
export function jobSpecs(settings) {
  const s = settings.specs || {};
  return {
    devices: getSpec(s.devices), lighting: getSpec(s.lighting), panels: getSpec(s.panels), tape: getSpec(s.tape), backup: getSpec(s.backup),
    backup_units: Number(s.backup_units ?? 1), backup_expansions: Number(s.backup_expansions ?? 0),
    // Ketra and DALI-2 apply to recessed lights only, and a type is one or the other (Tony, 2026-11-09). Older jobs that ticked
    // both for a type keep Ketra; anything that isn't recessed is ignored.
    // "Both" (kd_mixed): the job has Ketra and DALI-2 fixtures of that type; Claude decides per fixture from the legend/fixture schedule.
    kd_mixed: (s.kd_mixed || []).filter((t) => KD_TYPES.includes(t)),
    ketra_types: (s.ketra_types || []).filter((t) => KD_TYPES.includes(t) && !(s.kd_mixed || []).includes(t)),
    dali_types: (s.dali_types || []).filter((t) => KD_TYPES.includes(t) && !(s.ketra_types || []).includes(t) && !(s.kd_mixed || []).includes(t)),
  };
}

/** Text for Claude describing the job's specs. */
export function specPrompt(settings) {
  const js = jobSpecs(settings);
  const parts = [];
  if (js.devices) parts.push(`Wiring devices spec: ${js.devices.name}. ${js.devices.data.claude_notes || ""}`);
  if (js.lighting) parts.push(`Lighting control spec: ${js.lighting.name}. ${js.lighting.data.claude_notes || ""}`);
  if (js.panels) parts.push(`Electrical panel spec: ${js.panels.name}. ${js.panels.data.claude_notes || ""}`);
  if (js.tape) parts.push(`LED tape spec: ${js.tape.name}. ${js.tape.data.claude_notes || ""}`);
  if (js.backup) parts.push(`Backup power: ${js.backup.name}.`);
  if (js.ketra_types.length) parts.push(`These fixture types are Ketra (RF, no DPM, constant power): ${js.ketra_types.join(", ")}.`);
  if (js.dali_types.length) parts.push(`These fixture types are DALI-2 (DALI bus control, constant power): ${js.dali_types.join(", ")}.`);
  const sched = (settings.fixture_schedule || []).filter((f) => f.tag || f.description);
  if (sched.length) parts.push(`Lighting fixture schedule for this job (fixture type marks on the plans refer to these; use the type and control given here):\n${sched.map((f) =>
    `- ${f.tag || "(no tag)"}: ${[f.description, [f.manufacturer, f.model].filter(Boolean).join(" ")].filter(Boolean).join(", ")} -> takeoff type ${f.type}${f.control ? `, control ${f.control === "dali" ? "DALI-2" : f.control}` : ""}${f.watts ? `, ${f.watts} W` : ""}${f.location ? `, used in ${f.location}` : ""}`).join("\n")}`);
  if (js.kd_mixed.length) parts.push(`On this job, fixture types ${js.kd_mixed.join(", ")} include BOTH Ketra and DALI-2 fixtures. Decide each fixture from the fixture schedule, legend, fixture type tags or notes (manufacturer Ketra / Lutron Ketra = Ketra; DALI, DALI-2 or Lutron Lumaris DALI drivers = DALI-2). When nothing says, use DALI-2 and say so in the zone note.`);
  return parts.join("\n");
}

// ---------- zone codes: 104.01, K104.02 (Ketra), D104.03 (DALI-2) ----------
const ZONE_PREFIX = { ketra: "K", dali: "D", lumaris: "L" };
function roomCode(room) {
  if (!room) return "Z";
  return String(room.number || "").trim() || "Z"; // every room gets a number from assignRoomNumbers()
}
/**
 * Give unnumbered rooms (halls, closets…) a number that continues the sheet's series (e.g. 108, 109 after 100–107).
 * Tool-assigned numbers are recalculated each time so they never collide with real numbers found later.
 */
export async function assignRoomNumbers(jobId) {
  // Work on the rows in memory (tool numbers cleared), then write only the rooms whose number changes.
  const all = await db.prepare("SELECT * FROM rooms WHERE job_id = ?").all(jobId);
  const before = new Map(all.map((r) => [r.id, { number: r.number, auto: r.auto_number }]));
  const rooms = all.map((r) => (r.auto_number ? { ...r, number: "", auto_number: 0 } : r));
  const num = (r) => { const n = parseInt(r.number, 10); return Number.isFinite(n) ? n : null; };
  const used = new Set(rooms.map(num).filter((n) => n != null));
  const maxOf = (list) => list.map(num).filter((n) => n != null).reduce((a, b) => Math.max(a, b), -Infinity);
  const assigned = new Map();
  const set = { run: (number, id) => assigned.set(id, number) };
  const bySheet = new Map();
  for (const r of rooms.filter((rm) => !String(rm.number || "").trim())) (bySheet.get(r.sheet_id) || bySheet.set(r.sheet_id, []).get(r.sheet_id)).push(r);
  for (const [sid, list] of bySheet) {
    const sameSheet = rooms.filter((r) => r.sheet_id === sid);
    const level = sameSheet[0]?.level;
    let next = maxOf(sameSheet);
    if (!Number.isFinite(next)) next = maxOf(rooms.filter((r) => r.level === level));
    if (!Number.isFinite(next)) next = maxOf(rooms);
    if (!Number.isFinite(next)) next = 99;
    for (const r of list.sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0))) {
      do next++; while (used.has(next));
      used.add(next);
      set.run(String(next), r.id);
    }
  }
  const upd = db.prepare("UPDATE rooms SET number = ?, auto_number = ? WHERE id = ?");
  const writes = [];
  for (const r of rooms) {
    const number = assigned.has(r.id) ? assigned.get(r.id) : r.number, auto = assigned.has(r.id) ? 1 : 0;
    const b = before.get(r.id);
    if (b.number !== number || Number(b.auto) !== auto) writes.push(upd.bind(number, auto, r.id));
  }
  await db.batch(writes);
}

/**
 * Company rule: a zone never crosses rooms. Any zone whose lights (or tape runs) sit in more than one room is split:
 * the room with the most fixtures keeps the zone, each other room gets its own zone with the same control.
 * Returns how many new zones were created.
 */
export async function splitCrossRoomZones(jobId) {
  const rooms = new Map((await db.prepare("SELECT id, number, name FROM rooms WHERE job_id = ?").all(jobId)).map((r) => [r.id, r]));
  const all = [
    ...await db.prepare("SELECT id, room_id, zone_id, 'device' AS kind FROM devices WHERE job_id = ? AND zone_id IS NOT NULL").all(jobId),
    ...await db.prepare("SELECT id, room_id, zone_id, 'tape' AS kind FROM tape_runs WHERE job_id = ? AND zone_id IS NOT NULL").all(jobId),
  ];
  const byZone = new Map();
  for (const m of all) (byZone.get(m.zone_id) || byZone.set(m.zone_id, []).get(m.zone_id)).push(m);
  const setRoom = db.prepare("UPDATE zones SET room_id = ? WHERE id = ?");
  const writes = [];
  let made = 0;
  for (const z of await db.prepare("SELECT * FROM zones WHERE job_id = ?").all(jobId)) {
    if (z.exterior) continue; // exterior wall-face zones run along the outside of several rooms by design (Tony, 2026-11-09)
    const members = byZone.get(z.id) || [];
    const byRoom = new Map();
    for (const m of members) (byRoom.get(m.room_id ?? 0) || byRoom.set(m.room_id ?? 0, []).get(m.room_id ?? 0)).push(m);
    if (byRoom.size <= 1) {
      const only = [...byRoom.keys()][0];
      if (only && only !== z.room_id) writes.push(setRoom.bind(only, z.id));
      continue;
    }
    const groups = [...byRoom.entries()].sort((a, b) => b[1].length - a[1].length);
    writes.push(setRoom.bind(groups[0][0] || null, z.id));
    for (const [roomId, list] of groups.slice(1)) {
      const rm = rooms.get(roomId);
      const nz = (await db.prepare("INSERT INTO zones (job_id, sheet_id, room_id, name, control, source, note) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id")
        .get(jobId, z.sheet_id, roomId || null, rm ? `${rm.name} ${z.name.replace(/^\S+\s+/, "")}`.trim() : z.name, z.control, z.source, "Split: zones never cross rooms")).id;
      for (const m of list) writes.push(db.prepare(`UPDATE ${m.kind === "tape" ? "tape_runs" : "devices"} SET zone_id = ? WHERE id = ?`).bind(nz, m.id));
      made++;
    }
  }
  await db.batch(writes);
  return made;
}

/**
 * Safety net for zoning: when a room has two or more Claude-made zones with the same control and the same single
 * fixture type, and any of them holds just one fixture, fold those lone-fixture zones into the largest one.
 * (Same type in the same room is one zone unless the room genuinely has distinct areas.)
 */
export async function mergeLoneFixtureZones(jobId) {
  const zones = await db.prepare("SELECT * FROM zones WHERE job_id = ? AND source = 'ai' AND room_id IS NOT NULL").all(jobId);
  const devs = await db.prepare("SELECT id, type, zone_id FROM devices WHERE job_id = ? AND zone_id IS NOT NULL").all(jobId);
  const members = (z) => devs.filter((d) => d.zone_id === z.id);
  const writes = [];
  const groups = new Map();
  for (const z of zones) {
    const m = members(z);
    const types = [...new Set(m.map((d) => d.type))];
    if (types.length !== 1) continue;
    const key = `${z.room_id}|${z.control}|${types[0]}`;
    (groups.get(key) || groups.set(key, []).get(key)).push({ z, n: m.length });
  }
  let merged = 0;
  for (const list of groups.values()) {
    if (list.length < 2 || !list.some((x) => x.n === 1)) continue;
    list.sort((a, b) => b.n - a.n);
    const keep = list[0].z;
    for (const { z, n } of list.slice(1)) {
      if (n !== 1 && list[0].n > 1) continue; // two real groups (e.g. theater north/south) stay separate
      writes.push(db.prepare("UPDATE devices SET zone_id = ? WHERE zone_id = ?").bind(keep.id, z.id));
      writes.push(db.prepare("DELETE FROM zones WHERE id = ?").bind(z.id));
      merged++;
    }
  }
  await db.batch(writes);
  return merged;
}

/** Exterior zones of one fixture type and control whose fixtures all sit on one line (one wall face) become one zone. */
export async function mergeExteriorWallZones(jobId, ppf = 18) {
  const zones = await db.prepare("SELECT * FROM zones WHERE job_id = ? AND exterior = 1").all(jobId);
  if (zones.length < 2) return 0;
  const devs = await db.prepare("SELECT id, type, zone_id, x, y, sheet_id FROM devices WHERE job_id = ? AND zone_id IS NOT NULL AND x IS NOT NULL").all(jobId);
  const tol = 2.5 * ppf; // fixtures on one face sit within ~2.5 ft of the same line
  const info = zones.map((z) => { const m = devs.filter((d) => d.zone_id === z.id); return { z, m, types: [...new Set(m.map((d) => d.type))] }; })
    .filter((g) => g.m.length && g.types.length === 1);
  const line = (pts) => { const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    return Math.max(...ys) - Math.min(...ys) <= tol ? "h" : Math.max(...xs) - Math.min(...xs) <= tol ? "v" : null; };
  const writes = []; const gone = new Set(); let merged = 0;
  for (const a of info) {
    if (gone.has(a.z.id)) continue;
    for (const b of info) {
      if (b === a || gone.has(b.z.id) || b.z.sheet_id !== a.z.sheet_id || b.z.control !== a.z.control || b.types[0] !== a.types[0]) continue;
      if (!line([...a.m, ...b.m])) continue;
      writes.push(db.prepare("UPDATE devices SET zone_id = ? WHERE zone_id = ?").bind(a.z.id, b.z.id), db.prepare("DELETE FROM zones WHERE id = ?").bind(b.z.id));
      a.m.push(...b.m); gone.add(b.z.id); merged++;
    }
  }
  if (writes.length) await db.batch(writes);
  return merged;
}

export async function renumberZones(jobId) {
  await assignRoomNumbers(jobId);
  const rooms = new Map((await db.prepare("SELECT * FROM rooms WHERE job_id = ?").all(jobId)).map((r) => [r.id, r]));
  const zones = await db.prepare("SELECT * FROM zones WHERE job_id = ? ORDER BY id").all(jobId);
  const seq = new Map();
  const upd = db.prepare("UPDATE zones SET code = ? WHERE id = ?");
  const writes = [];
  for (const z of zones) {
    const base = z.exterior ? "EXT" : roomCode(rooms.get(z.room_id));
    const n = (seq.get(base) || 0) + 1;
    seq.set(base, n);
    const code = `${ZONE_PREFIX[z.control] || ""}${base}.${String(n).padStart(2, "0")}`;
    if (code !== z.code) writes.push(upd.bind(code, z.id)); // only the codes that changed
  }
  await db.batch(writes);
}

// ---------- distances ----------
/** PDF points per real foot from a scale like 1/4" = 1'-0" (defaults to 1/4"). */
export function pointsPerFoot(scaleText) {
  const t = String(scaleText || "");
  let m = t.match(/(\d+)\s*\/\s*(\d+)\s*"?\s*=\s*1\s*'/);
  if (m) return 72 * (Number(m[1]) / Number(m[2]));
  m = t.match(/(\d+(?:\.\d+)?)\s*"\s*=\s*1\s*'/);
  if (m) return 72 * Number(m[1]);
  return 72 * 0.25;
}

/** Greedy count of processors needed so every point is within `radius` of one. */
function coverCount(points, radius) {
  let left = points.slice(), n = 0;
  while (left.length) {
    let bestHit = [];
    for (const c of left) {
      const hit = left.filter((p) => Math.hypot(p.x - c.x, p.y - c.y) <= radius);
      if (hit.length > bestHit.length) bestHit = hit;
    }
    left = left.filter((p) => !bestHit.includes(p));
    n++;
  }
  return n;
}

/**
 * Home-run origins per sheet: the panel itself, or a riser that leads to it.
 * target "elec" -> electrical panel, "dpm" -> lighting (DPM) panel.
 */
function originFinder(equipment) {
  return (sheetId, target) => {
    const onSheet = equipment.filter((e) => e.sheet_id === sheetId && e.x != null);
    const panels = onSheet.filter((e) => e.kind === (target === "elec" ? "elec_panel" : "dpm_panel")).map((e) => ({ ...e, extra_ft: 0 }));
    const risers = onSheet.filter((e) => e.kind === "riser" && (e.serves === "both" || e.serves === target));
    return [...panels, ...risers];
  };
}

/** Home run from the nearest of `pts` to the nearest origin: {ft, origin}, or null if no origin on the sheet. */
function homeRun(pts, origins, ppf, s) {
  if (!origins.length || !pts.length) return null;
  let best = null;
  for (const p of pts) for (const o of origins) {
    const ft = ((Math.abs(p.x - o.x) + Math.abs(p.y - o.y)) / ppf) * s.homerun_route_factor + Number(o.extra_ft || 0);
    if (!best || ft < best.ft) best = { ft, origin: o };
  }
  return { ft: best.ft + Number(s.homerun_vertical_ft), origin: best.origin };
}

const md = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y); // right-angle (along X, then Y) distance

/**
 * Daisy-chain run through a group of devices, measured at right angles.
 * Starts at the device nearest `from` (the panel end), then nearest-neighbour.
 * Returns the device order (for drawing) and feet of cable including `slack` per box.
 */
function chainRun(pts, from, ppf, slack) {
  const left = pts.filter((p) => p && p.x != null);
  if (!left.length) return { order: [], ft: 0 };
  let cur = from ? left.reduce((b, p) => (md(p, from) < md(b, from) ? p : b)) : left[0];
  left.splice(left.indexOf(cur), 1);
  const order = [cur];
  let len = 0;
  while (left.length) {
    let bi = 0, bd = Infinity;
    left.forEach((p, i) => { const d = md(p, cur); if (d < bd) { bd = d; bi = i; } });
    len += bd;
    cur = left.splice(bi, 1)[0];
    order.push(cur);
  }
  return { order: order.map((p) => ({ id: p.id ?? null, x: p.x, y: p.y })), ft: len / ppf + slack * order.length };
}

/** Split devices into circuits of at most `per`, keeping rooms together where possible. */
function packCircuits(devs, per) {
  const byRoom = new Map();
  for (const d of devs) (byRoom.get(d.room_id ?? `s${d.sheet_id}`) || byRoom.set(d.room_id ?? `s${d.sheet_id}`, []).get(d.room_id ?? `s${d.sheet_id}`)).push(d);
  const circuits = [];
  let cur = [], load = 0;
  for (const group of [...byRoom.values()].sort((a, b) => (a[0].x ?? 0) - (b[0].x ?? 0))) {
    for (const d of group) {
      const w = d.weight || 1; // e.g. a 96W tape power interface counts as several 20W fixtures
      if (cur.length && load + w > per) { circuits.push(cur); cur = []; load = 0; }
      cur.push(d); load += w;
    }
  }
  if (cur.length) circuits.push(cur);
  return circuits;
}

/**
 * Size lighting control, circuits and home runs for a job.
 * Returns quantities for each basis plus details and warnings.
 */
export async function sizeSystem(jobId, settingsIn) {
  const s = settingsIn?.labor_rate ? settingsIn : jobSettings(await db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId));
  const js = jobSpecs(s);
  const rules = js.lighting?.data.rules || DEFAULT_RULES;
  const prules = js.panels?.data.rules || DEFAULT_RULES;
  const devices = await db.prepare("SELECT id, type, zone_id, room_id, sheet_id, x, y FROM devices WHERE job_id = ?").all(jobId);
  const zones = await db.prepare("SELECT * FROM zones WHERE job_id = ?").all(jobId);
  const equipment = await db.prepare("SELECT * FROM equipment WHERE job_id = ?").all(jobId);
  const sheets = Object.fromEntries((await db.prepare("SELECT id, sheet_no, page, kind, analysis FROM sheets WHERE job_id = ?").all(jobId))
    .map((sh) => [sh.id, { ...sh, analysis: sh.analysis ? JSON.parse(sh.analysis) : null }]));
  const ppfOf = (sid) => pointsPerFoot(sheets[sid]?.analysis?.scale_text);
  // LED tape runs join the zones / circuits / RF counts as stand-in devices.
  const tape = await computeTape(jobId, (s.specs || {}).tape, ppfOf);
  devices.push(...tape.pseudo);
  const origins = originFinder(equipment);
  const sheetName = (sid) => sheets[sid]?.sheet_no || `page ${sheets[sid]?.page}`;
  const missing = { elec: new Set(), dpm: new Set() };

  // ----- zones -----
  const zoneDevices = new Map(zones.map((z) => [z.id, []]));
  for (const d of devices) if (d.zone_id && zoneDevices.has(d.zone_id)) zoneDevices.get(d.zone_id).push(d);
  const used = zones.filter((z) => zoneDevices.get(z.id).length);
  const isSwitched = (z) => zoneDevices.get(z.id).every((d) => rules.switched_types.includes(d.type));
  const dpmZones = used.filter((z) => z.control === "dpm");
  const dimZones = dpmZones.filter((z) => !isSwitched(z)).length;
  const swZones = dpmZones.filter(isSwitched).length;
  const daliZones = used.filter((z) => z.control === "dali");
  const daliFixtures = daliZones.reduce((a, z) => a + zoneDevices.get(z.id).length, 0);
  const ketraZones = used.filter((z) => CONSTANT_POWER_RF.includes(z.control)); // Ketra and Lumaris
  const lights = devices.filter((d) => FIXTURE_TYPES.includes(d.type) || d.type === "tape" || d.type === "tape_pi");
  const unzoned = lights.filter((d) => !d.zone_id).length;

  const dpms = Math.ceil(dimZones / Math.max(1, rules.zones_per_dpm));
  const dpmsSwitching = Math.ceil(swZones / Math.max(1, rules.zones_per_dpm));
  const daliModules = Math.ceil(daliFixtures / Math.max(1, rules.dali_fixtures_per_module));

  // ----- per-panel schedule (which panel each run lands in) -----
  const byId = new Map(equipment.map((e) => [e.id, e]));
  const schedule = new Map(); // panel id | "unplaced-elec" | "unplaced-dpm" -> counts
  const panelFor = (origin, kind) => {
    if (!origin) return `unplaced-${kind}`;
    if (origin.kind !== "riser") return origin.id;
    const t = origin.target_id && byId.get(origin.target_id);
    if (t) return t.id;
    const only = equipment.filter((e) => e.kind === (kind === "elec" ? "elec_panel" : "dpm_panel"));
    return only.length === 1 ? only[0].id : `unplaced-${kind}`;
  };
  const tally = (key, field, n = 1) => {
    if (!schedule.has(key)) schedule.set(key, { power: 0, gfci: 0, lighting: 0, safety: 0, c240: 0, feeders: 0, dedicated: 0, dim_zones: 0, switched_zones: 0, dali_fixtures: 0, pd8_circuits: 0 });
    schedule.get(key)[field] += n;
  };
  /** Run from a group of devices to the panel of `kind`; falls back to the default length. */
  const run = (pts, sid, kind) => {
    const hr = homeRun(pts.filter((d) => d.x != null), origins(sid, kind), ppfOf(sid), s);
    if (!hr) missing[kind].add(sheetName(sid));
    return { ft: hr ? hr.ft : Number(s.default_homerun_ft), panel: panelFor(hr?.origin, kind), origin: hr?.origin || null };
  };
  // Geometry for drawing zones and circuits on the sheets.
  const draw = { zones: [], circuits: [] };
  const endOf = (o) => (o && o.x != null ? { x: o.x, y: o.y } : null);
  // Device-to-device order, for drawing only. Cable between devices comes from each device's assembly
  // allotment (company takeoff method); only home runs are measured.
  const chainFor = (pts, origin, sid) => chainRun(pts, origin, ppfOf(sid), 0);
  const lightsPerCircuit = Math.max(1, Math.floor(prules.lighting_circuit_amps * 120 * (prules.continuous_load_pct / 100) / prules.fixture_watts));

  // Capacity-aware choice of lighting panel: nearest PD8 that still has room for this zone's module.
  /** Would this PD8 still fit after adding `add` = {dim, sw, dali (fixtures), pd8 (circuits)}? */
  const fits = (key, add) => {
    const c = schedule.get(key) || { dim_zones: 0, switched_zones: 0, dali_fixtures: 0, pd8_circuits: 0 };
    const modules = Math.ceil((c.dim_zones + (add.dim || 0)) / rules.zones_per_dpm) + Math.ceil((c.switched_zones + (add.sw || 0)) / rules.zones_per_dpm)
      + Math.ceil((c.dali_fixtures + (add.dali || 0)) / rules.dali_fixtures_per_module);
    return modules <= rules.dpms_per_panel && c.pd8_circuits + (add.pd8 || 0) <= rules.pd8_circuits_per_panel;
  };
  /** Nearest PD8 (or riser to one) with room for `add`; falls back to the nearest when all are full. */
  const runToPd8 = (pts, sid, add) => {
    const live = pts.filter((d) => d.x != null);
    const cands = origins(sid, "dpm");
    if (!live.length || !cands.length) return run(pts, sid, "dpm");
    const ranked = cands.map((o) => homeRun(live, [o], ppfOf(sid), s)).sort((a, b) => a.ft - b.ft);
    for (const hr of ranked) {
      const key = panelFor(hr.origin, "dpm");
      if (fits(key, add)) return { ft: hr.ft, panel: key, origin: hr.origin };
    }
    return { ft: ranked[0].ft, panel: panelFor(ranked[0].origin, "dpm"), origin: ranked[0].origin }; // all full: flagged by the schedule check
  };

  // Zone home runs (dimming and switching DPM zones) to the DPM panel or a riser.
  let dpmHomeRunFt = 0;
  const zoneRuns = [];
  for (const z of dpmZones) {
    const pts = zoneDevices.get(z.id);
    const r = runToPd8(pts, pts[0]?.sheet_id ?? z.sheet_id, isSwitched(z) ? { sw: 1 } : { dim: 1 });
    dpmHomeRunFt += r.ft;
    tally(r.panel, isSwitched(z) ? "switched_zones" : "dim_zones");
    zoneRuns.push({ zone_id: z.id, code: z.code, ft: Math.round(r.ft) });
    const sid = pts[0]?.sheet_id ?? z.sheet_id;
    const ch = chainFor(pts, r.origin, sid, "14/2");
    draw.zones.push({ zone_id: z.id, sheet_id: sid, end: endOf(r.origin), ft: Math.round(r.ft), run_ft: Math.round(ch.ft), order: ch.order, panel: r.panel });
  }
  // DALI bus runs from the DALI module (in the DPM panel) to each DALI zone.
  let daliBusFt = 0;
  for (const z of daliZones) {
    const pts = zoneDevices.get(z.id);
    const r = runToPd8(pts, pts[0]?.sheet_id ?? z.sheet_id, { dali: pts.length });
    tally(r.panel, "dali_fixtures", pts.length);
    const sid = pts[0]?.sheet_id ?? z.sheet_id;
    const ch = chainFor(pts, r.origin, sid);
    daliBusFt += r.ft;
    draw.zones.push({ zone_id: z.id, sheet_id: sid, end: endOf(r.origin), ft: Math.round(r.ft), run_ft: Math.round(ch.ft), order: ch.order, panel: r.panel });
  }
  for (const z of [...ketraZones, ...used.filter((u) => u.control === "wall")]) {
    const pts = zoneDevices.get(z.id);
    const sid = pts[0]?.sheet_id ?? z.sheet_id;
    const ch = chainFor(pts, null, sid);
    draw.zones.push({ zone_id: z.id, sheet_id: sid, end: null, ft: 0, run_ft: Math.round(ch.ft), order: ch.order, panel: null });
  }
  // Ketra and DALI fixtures need constant-power lighting circuits; these land in the PD8 distribution section.
  let pd8Circuits = 0, pd8Ft = 0;
  const constantPower = devices.filter((d) => [...ketraZones, ...daliZones].some((z) => z.id === d.zone_id));
  const cpBySheet = new Map();
  for (const d of constantPower) (cpBySheet.get(d.sheet_id) || cpBySheet.set(d.sheet_id, []).get(d.sheet_id)).push(d);
  for (const [sid, devs] of cpBySheet) {
    for (const c of packCircuits(devs, lightsPerCircuit)) {
      const r = runToPd8(c, sid, { pd8: 1 });
      pd8Circuits++; pd8Ft += r.ft;
      tally(r.panel, "pd8_circuits");
      const ch = chainFor(c, r.origin, sid, "14/2");
      draw.circuits.push({ cls: "pd8", name: "Ketra/DALI constant power", sheet_id: sid, device_ids: c.map((d) => d.id), order: ch.order, run_ft: Math.round(ch.ft), end: endOf(r.origin), ft: Math.round(r.ft), panel: r.panel });
    }
  }
  // PD8 count: enough module slots AND enough distribution spots.
  const panelsBySlots = Math.ceil((dpms + dpmsSwitching + daliModules) / Math.max(1, rules.dpms_per_panel));
  const panelsByCircuits = Math.ceil(pd8Circuits / Math.max(1, rules.pd8_circuits_per_panel));
  const pd8Panels = Math.max(panelsBySlots, panelsByCircuits);

  // DPM panel feeders from the electrical panel (one per PD8).
  let feederFt = 0;
  const dpmPanelsPlaced = equipment.filter((e) => e.kind === "dpm_panel" && e.x != null);
  for (const p of dpmPanelsPlaced) {
    const r = run([p], p.sheet_id, "elec");
    feederFt += r.ft;
    tally(r.panel, "feeders");
    draw.circuits.push({ cls: "feeder", name: `${p.name} feed, 50A 2-pole`, sheet_id: p.sheet_id, points: [{ x: p.x, y: p.y }], end: endOf(r.origin), ft: Math.round(r.ft), panel: r.panel, poles: 2 });
  }
  if (pd8Panels > dpmPanelsPlaced.length) {
    feederFt += (pd8Panels - dpmPanelsPlaced.length) * Number(s.default_homerun_ft);
    const elecPanelsAll = equipment.filter((e) => e.kind === "elec_panel");
    tally(elecPanelsAll.length === 1 ? elecPanelsAll[0].id : "unplaced-elec", "feeders", pd8Panels - dpmPanelsPlaced.length);
  }

  // ----- RF -----
  const rfDevices = devices.filter((d) => rules.rf_device_types.includes(d.type) || ketraZones.some((z) => z.id === d.zone_id));
  let rfProcessors = 0, rfReason = "";
  if (rfDevices.length) {
    const byCount = Math.ceil(rfDevices.length / Math.max(1, rules.rf_devices_per_processor));
    let byRange = 0;
    const perSheet = new Map();
    for (const d of rfDevices) if (d.x != null && d.sheet_id) (perSheet.get(d.sheet_id) || perSheet.set(d.sheet_id, []).get(d.sheet_id)).push(d);
    for (const [sid, pts] of perSheet) byRange += coverCount(pts, rules.rf_range_ft * ppfOf(sid));
    rfProcessors = Math.max(byCount, byRange);
    rfReason = `${rfDevices.length} RF devices / ${rules.rf_devices_per_processor} per processor = ${byCount}; ${rules.rf_range_ft} ft range check across ${perSheet.size} sheet(s) = ${byRange}`;
  }

  // ----- branch circuits & home runs to the electrical panel -----
  // Lighting loads fed from the PD8 (DPM zones, Ketra, DALI) are not electrical-panel circuits.
  const pd8Fed = new Set([...dpmZones, ...daliZones, ...ketraZones].map((z) => z.id));
  const circ = { power: [], gfci: [], lighting: [], c240: [], safety: [] };
  const bySheet = new Map();
  for (const d of devices) (bySheet.get(d.sheet_id) || bySheet.set(d.sheet_id, []).get(d.sheet_id)).push(d);
  for (const [, devs] of bySheet) {
    circ.power.push(...packCircuits(devs.filter((d) => POWER_TYPES.includes(d.type)), prules.receptacles_per_circuit));
    const gf = devs.filter((d) => d.type === "receptacle_gfci");
    const byRoom = new Map();
    for (const d of gf) (byRoom.get(d.room_id ?? "x") || byRoom.set(d.room_id ?? "x", []).get(d.room_id ?? "x")).push(d);
    for (const g of byRoom.values()) circ.gfci.push(...packCircuits(g, prules.receptacles_per_circuit));
    const lightLoads = devs.filter((d) => FIXTURE_TYPES.includes(d.type) && !pd8Fed.has(d.zone_id));
    circ.lighting.push(...packCircuits(lightLoads, lightsPerCircuit));
    // Smoke/CO detectors are life safety, not lighting: their own 15A circuit with 14/3 for the interconnect.
    const smokes = devs.filter((d) => d.type === "smoke_co");
    if (smokes.length) circ.safety.push(Object.assign(smokes, { name: "Life safety: smoke/CO interconnect" }));
    circ.c240.push(...devs.filter((d) => d.type === "receptacle_240").map((d) => [d]));
  }
  // Code-required general circuits not drawn as devices: kitchen small-appliance and laundry.
  const rooms = await db.prepare("SELECT * FROM rooms WHERE job_id = ?").all(jobId);
  const roomPt = (r) => ({ id: null, x: r.x, y: r.y, sheet_id: r.sheet_id, room_id: r.id });
  for (const r of rooms.filter((rm) => rm.sheet_id && rm.x != null)) {
    if (/KITCHEN/i.test(r.name) && !/KITCHENETTE/i.test(r.name)) for (let i = 0; i < prules.kitchen_sa_circuits; i++) circ.power.push(Object.assign([roomPt(r)], { name: `${r.name} small-appliance ${i + 1}` }));
    if (/LAUNDRY/i.test(r.name)) for (let i = 0; i < prules.laundry_circuits; i++) circ.power.push(Object.assign([roomPt(r)], { name: `${r.name} laundry` }));
  }
  const CABLE = { power: "12/2", gfci: "12/2", lighting: "14/2", safety: "14/3" };
  const runFt = (list, field, cls) => list.reduce((a, c) => {
    const r = run(c, c[0].sheet_id, "elec");
    const cable = field === "c240" ? null : c.cable || CABLE[field]; // 240V circuits keep their assembly cable
    const ch = chainFor(c, r.origin, c[0].sheet_id, cable);
    if (js.panels) tally(r.panel, field);
    draw.circuits.push({ cls, name: c.name || "", sheet_id: c[0].sheet_id, device_ids: c.filter((d) => d.id).map((d) => d.id),
      order: ch.order, run_ft: Math.round(ch.ft), cable, end: endOf(r.origin), ft: Math.round(r.ft), panel: r.panel, poles: field === "c240" ? 2 : 1 });
    return a + r.ft;
  }, 0);
  // Device-to-device runs are always measured; home runs are only priced with a panel spec.
  const powerHr = runFt(circ.power, "power", "power") + runFt(circ.gfci, "gfci", "gfci");
  const lightingHr = runFt(circ.lighting, "lighting", "lighting");
  const safetyHr = runFt(circ.safety, "safety", "safety");
  runFt(circ.c240, "c240", "c240"); // 240V runs are already in the device assembly; this only tallies spaces
  const powerFt = js.panels ? powerHr : 0;
  const lightingFt = js.panels ? lightingHr : 0;
  const safetyFt = js.panels ? safetyHr : 0;

  // Dedicated circuits for appliances and mechanical equipment (from the Equipment tab).
  const loadRows = await db.prepare("SELECT * FROM loads WHERE job_id = ? AND include = 1").all(jobId);
  const roomById = new Map(rooms.map((r) => [r.id, r]));
  const loadCircuits = [];
  for (const l of loadRows) {
    const rm = roomById.get(l.room_id);
    const pt = rm && rm.x != null ? roomPt(rm) : null;
    const r = pt ? run([pt], pt.sheet_id, "elec") : { ft: Number(s.default_homerun_ft), panel: (() => { const ep = equipment.filter((e) => e.kind === "elec_panel"); return ep.length === 1 ? ep[0].id : "unplaced-elec"; })(), origin: null };
    if (js.panels) tally(r.panel, "dedicated", l.poles);
    loadCircuits.push({ load_id: l.id, ft: r.ft, panel: r.panel });
    // Loads with no room still get a circuit number (sheet_id null = nothing to draw).
    draw.circuits.push({ cls: "dedicated", load_id: l.id, name: `${l.name}${l.tag ? ` (${l.tag})` : ""}, ${l.breaker}A ${l.poles}P`,
      sheet_id: pt?.sheet_id ?? null, points: pt ? [{ x: pt.x, y: pt.y }] : [], end: endOf(r.origin), ft: Math.round(r.ft), panel: r.panel, poles: l.poles });
  }

  // Backup power: each Powerwall / generator placed on the plan gets a 2-pole feeder measured to the nearest panel.
  const backupRules = js.backup ? { ...DEFAULT_RULES, ...js.backup.data.rules } : null;
  const backupPlaced = equipment.filter((e) => e.kind === "backup" && e.x != null);
  const backupFeeders = [];
  let backupUnits = 0;
  if (js.backup) {
    backupUnits = backupPlaced.length || Math.max(1, js.backup_units);
    const onlyElec = equipment.filter((e) => e.kind === "elec_panel");
    for (let i = 0; i < backupUnits; i++) {
      const u = backupPlaced[i];
      const r = u ? run([u], u.sheet_id, "elec") : { ft: Number(s.default_homerun_ft), panel: onlyElec.length === 1 ? onlyElec[0].id : "unplaced-elec", origin: null };
      tally(r.panel, "dedicated", 2);
      const name = u?.name || `${js.backup.name} ${i + 1} (not placed)`;
      const c = { cls: "backup", name: `${name} feeder, ${backupRules.feeder_breaker}A 2-pole`, sheet_id: u?.sheet_id ?? null, points: u ? [{ x: u.x, y: u.y }] : [],
        end: endOf(r.origin), ft: Math.round(r.ft), panel: r.panel, poles: 2 };
      draw.circuits.push(c);
      backupFeeders.push({ name, ft: r.ft, placed: !!u, circuit: c });
    }
  }

  // Circuit labels per panel: EP1-01, EP1-02 … / LP1-01 … in the order they were sized.
  const shortName = new Map();
  for (const kind of ["elec_panel", "dpm_panel"]) {
    equipment.filter((e) => e.kind === kind).sort((a, b) => a.id - b.id).forEach((e, i) => shortName.set(e.id, `${kind === "elec_panel" ? "EP" : "LP"}${i + 1}`));
  }
  const seq = new Map();
  for (const c of draw.circuits) {
    const sn = shortName.get(c.panel) || (String(c.panel).endsWith("dpm") ? "LP?" : "EP?");
    const n = (seq.get(sn) || 0) + 1;
    seq.set(sn, n);
    c.label = `${sn}-${String(n).padStart(2, "0")}`;
  }
  for (const lc of loadCircuits) lc.label = draw.circuits.find((c) => c.load_id === lc.load_id)?.label || "";

  // Panel schedule rows with space checks.
  const panelSchedule = [...schedule.entries()].map(([key, c]) => {
    const e = typeof key === "number" ? byId.get(key) : null;
    const isElec = e ? e.kind === "elec_panel" : String(key).endsWith("elec");
    const spaces = c.power + c.gfci + c.lighting + c.safety + c.c240 * 2 + c.feeders * rules.dpm_feeder_spaces + c.dedicated;
    const modules = Math.ceil(c.dim_zones / rules.zones_per_dpm) + Math.ceil(c.switched_zones / rules.zones_per_dpm) + Math.ceil(c.dali_fixtures / rules.dali_fixtures_per_module);
    return {
      key, name: e ? e.name : isElec ? "Electrical panel (not placed)" : "Lighting panel (not placed)",
      kind: isElec ? "elec_panel" : "dpm_panel", sheet: e ? sheetName(e.sheet_id) : "",
      ...c, spaces, capacity: isElec ? prules.panel_spaces : null,
      modules, module_capacity: isElec ? null : rules.dpms_per_panel, pd8_capacity: isElec ? null : rules.pd8_circuits_per_panel,
    };
  }).filter((p) => p.kind === "dpm_panel" ? p.modules || p.pd8_circuits : p.spaces);

  // ----- warnings -----
  const warnings = [];
  if (js.lighting && rules.zoning_required && unzoned) warnings.push(`${unzoned} light fixture(s) are not in a zone yet. The DPM and panel count only covers zoned lights. Zone them on the Plans tab.`);
  if (rfDevices.length && rfProcessors > Math.ceil(rfDevices.length / rules.rf_devices_per_processor)) warnings.push(`RF processors increased to ${rfProcessors} for the ${rules.rf_range_ft} ft range. Confirm processor locations on site; dense materials shorten range.`);
  for (const p of panelSchedule) {
    if (p.capacity && p.spaces > p.capacity) warnings.push(`${p.name}${p.sheet ? ` (${p.sheet})` : ""} needs ${p.spaces} breaker spaces; the spec allows ${p.capacity}. Add a panel or sub-panel.`);
    if (p.kind === "dpm_panel" && typeof p.key === "number" && (p.modules > p.module_capacity || p.pd8_circuits > p.pd8_capacity)) {
      warnings.push(`${p.name} (${p.sheet}) needs ${p.modules} modules and ${p.pd8_circuits} Ketra/DALI circuits; a PD8 holds ${p.module_capacity} modules and ${p.pd8_capacity} circuits. Place another lighting panel and split the zones.`);
    }
  }
  if (pd8Panels > dpmPanelsPlaced.length && dpmPanelsPlaced.length) warnings.push(`This job needs ${pd8Panels} PD8 lighting panels; ${dpmPanelsPlaced.length} placed. Place the others on the plan (they can sit side by side) so zones and feeders are allocated to them.`);
  if (panelsByCircuits > panelsBySlots) warnings.push(`${pd8Circuits} Ketra/DALI circuits need ${panelsByCircuits} PD8 panel(s) for distribution spots (${rules.pd8_circuits_per_panel} each), more than the ${panelsBySlots} needed for modules.`);
  if (missing.dpm.size && (dimZones + swZones + daliZones.length + pd8Circuits)) warnings.push(`No lighting (DPM) panel or riser placed on ${[...missing.dpm].join(", ")}: zone home runs there use the ${s.default_homerun_ft} ft default.`);
  if (missing.elec.size && js.panels) warnings.push(`No electrical panel or riser placed on ${[...missing.elec].join(", ")}: circuit home runs there use the ${s.default_homerun_ft} ft default.`);
  if (js.backup && !backupPlaced.length) warnings.push(`Place the ${js.backup.name} unit(s) on the plan (Panels & risers → Backup unit) so the feeder is measured; using the ${s.default_homerun_ft} ft default for now.`);
  if (js.backup && js.panels && !/span|leviton/i.test(js.panels.name)) warnings.push(`Backup power (${js.backup.name}) is on this job. Company default is a SPAN or Leviton smart panel.`);
  const untaped = tape.runs.filter((r) => !r.zone_id).length;
  if (untaped && js.lighting && rules.zoning_required) warnings.push(`${untaped} LED tape run(s) are not in a zone. Lucetta runs need a DPM zone; Lumaris runs a Lumaris zone.`);
  const gen = s.generator;
  if (gen?.hits?.length && js.panels && !/span|leviton/i.test(js.panels.name)) warnings.push(`The plans mention a generator (${gen.hits[0].sheet}). Company default is a SPAN or Leviton smart panel.`);
  if (gen?.hits?.length && !js.panels) warnings.push(`The plans mention a generator (${gen.hits[0].sheet}). Pick a SPAN or Leviton smart panel spec on the Specs tab.`);

  const elecPanels = Math.max(1, equipment.filter((e) => e.kind === "elec_panel").length);
  return {
    spec: js.lighting ? { id: js.lighting.id, name: js.lighting.name, control: js.lighting.data.control } : null,
    panel_spec: js.panels ? { id: js.panels.id, name: js.panels.name } : null,
    rules, zones: used.length, dpm_zones: dimZones + swZones, dim_zones: dimZones, switched_zones: swZones,
    dali_zones: daliZones.length, dali_fixtures: daliFixtures, ketra_zones: ketraZones.length, unzoned_lights: unzoned,
    dpms, dpms_switching: dpmsSwitching, dali_modules: daliModules, panels: pd8Panels, pd8_circuits: pd8Circuits,
    rf_devices: rfDevices.length, rf_processors: rfProcessors, rf_reason: rfReason,
    circuits: { power: circ.power.length, gfci: circ.gfci.length, lighting: circ.lighting.length, safety: circ.safety.length, c240: circ.c240.length, pd8: pd8Circuits, dedicated: loadRows.length },
    lights_per_circuit: lightsPerCircuit,
    tape: { runs: tape.runs, qty_by_spec: Object.fromEntries(tape.qtyBySpec) },
    backup: js.backup ? {
      units: backupUnits, placed: backupPlaced.length, breaker: backupRules.feeder_breaker, neutral: !!backupRules.feeder_neutral, disconnect: !!backupRules.feeder_disconnect,
      feeders: backupFeeders.map((f) => ({ name: f.name, ft: Math.round(f.ft), placed: f.placed, label: f.circuit.label })),
    } : null,
    load_circuits: loadCircuits,
    drawing: draw,
    home_runs: { zones_ft: Math.round(dpmHomeRunFt), dali_bus_ft: Math.round(daliBusFt), pd8_ft: Math.round(pd8Ft), power_ft: Math.round(powerFt), lighting_ft: Math.round(lightingFt), feeder_ft: Math.round(feederFt), zone_runs: zoneRuns },
    panel_schedule: panelSchedule,
    qty: {
      job: js.lighting ? 1 : 0, dpm: dpms, dpm_switching: dpmsSwitching, dali_module: daliModules, panel: pd8Panels,
      dpm_zone: dimZones + swZones, dpm_home_run_ft: dpmHomeRunFt, dpm_feeder_ft: pd8Panels ? feederFt : 0,
      dali_bus_ft: daliBusFt, pd8_circuit: pd8Circuits, pd8_circuit_home_run_ft: pd8Ft,
      rf_processor: rfProcessors, rf_device: rfDevices.length,
      elec_panel: js.panels ? elecPanels : 0, power_circuit: js.panels ? circ.power.length : 0, gfci_circuit: js.panels ? circ.gfci.length : 0,
      lighting_circuit: js.panels ? circ.lighting.length : 0, circuit_240: js.panels ? circ.c240.length : 0,
      safety_circuit: js.panels ? circ.safety.length : 0, safety_home_run_ft: safetyFt,
      power_home_run_ft: powerFt, lighting_home_run_ft: lightingFt, pd8_feed: js.panels ? pd8Panels : 0,
    },
    warnings,
  };
}
