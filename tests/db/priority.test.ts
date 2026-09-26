import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import type { EvidenceItem } from "@/lib/queue-types";
import { explainScore } from "@/lib/replay";
import { assessTransactions } from "@/lib/risk/engine";
import { toApplyRows } from "@/lib/risk/runner";
import { generateDataset } from "../../scripts/seed/generator";
import { datasetToSql } from "../../scripts/seed/sql";
import { as, createTestDb, createUser } from "./harness";

let db: PGlite;
const rows = toApplyRows(assessTransactions(generateDataset().transactions));

beforeAll(async () => {
  db = await createTestDb();
  await db.exec(`begin; ${datasetToSql(generateDataset())} commit;`);
  await as(db, "service_role", null, () => db.query("select * from public.apply_risk_assessments($1::jsonb)", [JSON.stringify(rows)]));
}, 60_000);

describe("alert priority (tie-break)", () => {
  it("DB priority equals the engine's uncapped total for every alert", async () => {
    const { rows: dbRows } = await db.query<{ transaction_id: string; priority: number }>("select transaction_id, priority from public.alerts");
    const byTxn = new Map(rows.map((r) => [r.transaction_id, r]));
    expect(dbRows.length).toBeGreaterThan(0);
    for (const r of dbRows) {
      const x = explainScore(byTxn.get(r.transaction_id)!.evidence as EvidenceItem[], byTxn.get(r.transaction_id)!.score);
      expect(r.priority).toBe(x.patternSum + x.signalCounted);
    }
  });

  it("actually separates alerts that tie at 100", async () => {
    const { rows: ties } = await db.query<{ n: number; distinct_priorities: number }>(
      "select count(*)::int n, count(distinct priority)::int distinct_priorities from public.alerts where risk_score = 100",
    );
    expect(ties[0].n).toBeGreaterThan(1);
    expect(ties[0].distinct_priorities).toBeGreaterThan(1);
  });

  it("users cannot write it", async () => {
    const analyst = await createUser(db, "analyst");
    await as(db, "authenticated", analyst, async () => {
      await expect(db.query("update public.alerts set priority = 999")).rejects.toThrow();
    });
  });
});
