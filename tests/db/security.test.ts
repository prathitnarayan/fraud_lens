import type { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { SIGNAL_CAP } from "@/lib/risk/rules";
import { createTestDb } from "./harness";

let db: PGlite;
beforeAll(async () => {
  db = await createTestDb();
}, 60_000);

/** Schema-wide invariants — they also catch tables/functions added in future migrations. */
describe("schema security invariants", () => {
  it("every public table has RLS enabled", async () => {
    const { rows } = await db.query<{ relname: string; relrowsecurity: boolean }>(
      "select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'",
    );
    expect(rows.length).toBeGreaterThanOrEqual(7);
    expect(rows.filter((r) => !r.relrowsecurity).map((r) => r.relname)).toEqual([]);
  });

  it("anon has no privileges on any public table", async () => {
    const { rows } = await db.query<{ relname: string }>(`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('anon', c.oid, 'insert')
          or has_table_privilege('anon', c.oid, 'update') or has_table_privilege('anon', c.oid, 'delete'))`);
    expect(rows).toEqual([]);
  });

  it("authenticated can never delete or truncate", async () => {
    const { rows } = await db.query<{ relname: string }>(`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and (has_table_privilege('authenticated', c.oid, 'delete') or has_table_privilege('authenticated', c.oid, 'truncate'))`);
    expect(rows).toEqual([]);
  });

  it("authenticated cannot insert into scoring/evidence tables", async () => {
    for (const t of ["customers", "transactions", "fraud_labels", "alerts", "risk_assessments"]) {
      const { rows } = await db.query<{ ok: boolean }>(`select has_table_privilege('authenticated', 'public.${t}', 'insert') ok`);
      expect(rows[0].ok, t).toBe(false);
    }
  });

  it("every SECURITY DEFINER function pins search_path", async () => {
    const { rows } = await db.query<{ proname: string }>(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private') and p.prosecdef
        and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`);
    expect(rows).toEqual([]);
  });

  it("the write-path RPC is service-role only", async () => {
    for (const role of ["anon", "authenticated"]) {
      const { rows } = await db.query<{ ok: boolean }>(`select has_function_privilege('${role}', 'public.apply_risk_assessments(jsonb)', 'execute') ok`);
      expect(rows[0].ok, role).toBe(false);
    }
  });

  it("SQL priority cap matches the engine's SIGNAL_CAP", () => {
    const dir = join(process.cwd(), "supabase", "migrations");
    const sql = readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
    expect(sql).toContain(`least(${SIGNAL_CAP},`);
  });
});
