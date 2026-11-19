// Helpers shared by both database drivers.

export const TABLES = ["jobs", "plans", "sheets", "rooms", "zones", "devices", "catalog", "assemblies", "specs",
  "equipment", "loads", "tape_runs", "code_findings", "usage", "homeruns", "circuits"];
const T = TABLES.join("|");
const KW = new RegExp(`\\b(FROM|INTO|UPDATE|JOIN|REFERENCES|ON|TABLE(?:\\s+IF\\s+NOT\\s+EXISTS)?)(\\s+)(${T})\\b(?!\\s*\\.)`, "g");
const QUAL = new RegExp(`\\b(${T})\\.(?=[a-z_])`, "g");

/**
 * On the SIS Tools site every Takeoff table lives in the shared database with a "takeoff_" prefix
 * (Crew Board already has a "jobs" collection). SQL is written with plain names and prefixed here.
 */
export function prefixSql(sql, prefix) {
  if (!prefix) return sql;
  return sql
    .replace(KW, (m, kw, sp, t) => `${kw}${sp}${prefix}${t}`)
    .replace(QUAL, (m, t) => `${prefix}${t}.`)
    .replace(/INDEX IF NOT EXISTS idx_/g, `INDEX IF NOT EXISTS ${prefix}idx_`);
}

const isPlain = (v) => v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Uint8Array) && !(v instanceof ArrayBuffer);
const clean = (v) => (v === undefined ? null : v === true ? 1 : v === false ? 0 : v);

/** Named parameters (:name with one object argument) become positional ?s; undefined -> null, booleans -> 1/0. */
export function bindArgs(sql, args = []) {
  if (args.length === 1 && isPlain(args[0]) && /:\w/.test(sql)) {
    const o = args[0], out = [];
    const text = sql.replace(/(?<![:\w]):([a-z_]\w*)/gi, (m, k) => { out.push(clean(o[k])); return "?"; });
    return { sql: text, args: out };
  }
  return { sql, args: args.map(clean) };
}

export const isTxControl = (sql) => /^\s*(BEGIN|COMMIT|ROLLBACK|END)\b/i.test(sql);
