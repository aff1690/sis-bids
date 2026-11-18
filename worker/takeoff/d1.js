// Cloudflare D1 driver (the SIS Tools site). Same async interface as node/sqlite.js.
import { prefixSql, bindArgs, isTxControl } from "./sqlutil.js";

export function d1Driver(D1, prefix = "takeoff_") {
  const stmt = (sql, args) => { const b = bindArgs(prefixSql(sql, prefix), args); return D1.prepare(b.sql).bind(...b.args); };
  const driver = {
    table: (name) => `${prefix}${name}`,
    prepare(sql) {
      return {
        get: async (...a) => (await stmt(sql, a).first()) ?? undefined,
        all: async (...a) => (await stmt(sql, a).all()).results || [],
        run: async (...a) => { const r = await stmt(sql, a).run(); return { changes: r.meta?.changes ?? 0, lastId: r.meta?.last_row_id ?? null }; },
        bind: (...a) => ({ sql, args: a }),
      };
    },
    /** Several writes in one round trip, applied together (D1 batches are atomic). */
    async batch(list) {
      const items = (list || []).filter(Boolean);
      for (let i = 0; i < items.length; i += 100) await D1.batch(items.slice(i, i + 100).map((b) => stmt(b.sql, b.args)));
    },
    async exec(sql) { if (!isTxControl(sql)) await D1.prepare(prefixSql(sql, prefix)).run(); },
  };
  return driver;
}
