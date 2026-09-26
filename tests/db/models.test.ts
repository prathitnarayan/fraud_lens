import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { assessAll, toApplyRows } from "@/lib/risk/runner";
import { generateDataset } from "../../scripts/seed/generator";
import { datasetToSql } from "../../scripts/seed/sql";
import { as, createTestDb, createUser } from "./harness";

let db: PGlite;
const d = generateDataset();
const { assessments, models } = assessAll(d.transactions);
const rows = toApplyRows(assessments, models);

beforeAll(async () => {
  db = await createTestDb();
  await db.exec(`begin; ${datasetToSql(d)} commit;`);
  await as(db, "service_role", null, () => db.query("select * from public.apply_risk_assessments($1::jsonb)", [JSON.stringify(rows)]));
}, 60_000);

describe("model scores persistence", () => {
  it("stores all model columns for every assessment", async () => {
    const { rows: r } = await db.query<{ n: number; with_models: number; model_only: number }>(
      "select count(*)::int n, count(agreement)::int with_models, count(*) filter (where model_only)::int model_only from public.risk_assessments",
    );
    expect(r[0]).toEqual({ n: 5000, with_models: 5000, model_only: [...models.values()].filter((m) => m.modelOnly).length });
  });

  it("alert count is exactly the rules' count — models create no alerts", async () => {
    const { rows: r } = await db.query<{ n: number }>("select count(*)::int n from public.alerts");
    expect(r[0].n).toBe(assessments.filter((a) => a.alert).length);
  });

  it("re-applying is idempotent and still works without model fields (older runners)", async () => {
    const plain = rows.map(({ behaviour_score: _b, beneficiary_score: _be, network_score: _n, agreement: _a, model_only: _m, model_factors: _f, model_version: _v, ...rest }) => rest);
    await as(db, "service_role", null, () => db.query("select * from public.apply_risk_assessments($1::jsonb)", [JSON.stringify(plain.slice(0, 10))]));
    const { rows: r } = await db.query<{ n: number }>("select count(*)::int n from public.risk_assessments where agreement is null");
    expect(r[0].n).toBe(10);
    await as(db, "service_role", null, () => db.query("select * from public.apply_risk_assessments($1::jsonb)", [JSON.stringify(rows)]));
    const { rows: r2 } = await db.query<{ n: number }>("select count(*)::int n from public.risk_assessments where agreement is null");
    expect(r2[0].n).toBe(0);
  });

  it("users cannot write model scores", async () => {
    const analyst = await createUser(db, "analyst");
    await as(db, "authenticated", analyst, async () => {
      await expect(db.query("update public.risk_assessments set behaviour_score = 0")).rejects.toThrow(/permission denied/);
    });
  });
});
