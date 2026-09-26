import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { generateDataset } from "../../scripts/seed/generator";
import { datasetToSql } from "../../scripts/seed/sql";
import { as, createTestDb, createUser } from "./harness";

let db: PGlite;
const dataset = generateDataset();
const sql = datasetToSql(dataset);

async function counts() {
  const q = async (t: string) => Number((await db.query<{ n: number }>(`select count(*)::int n from ${t}`)).rows[0].n);
  return {
    customers: await q("public.customers where external_ref like 'SEED-%'"),
    transactions: await q("public.transactions"),
    labels: await q("public.fraud_labels"),
  };
}

beforeAll(async () => {
  db = await createTestDb();
}, 60_000);

describe("seed SQL against the real schema", () => {
  it("loads the full dataset", async () => {
    await db.exec(`begin; ${sql} commit;`);
    expect(await counts()).toEqual({ customers: 200, transactions: 5000, labels: dataset.labels.length });
  });

  it("is idempotent — re-running yields the same rows and ids", async () => {
    const before = (await db.query<{ id: string }>("select id from public.transactions order by id")).rows;
    await db.exec(`begin; ${sql} commit;`);
    await db.exec(`begin; ${sql} commit;`);
    expect(await counts()).toEqual({ customers: 200, transactions: 5000, labels: dataset.labels.length });
    expect((await db.query<{ id: string }>("select id from public.transactions order by id")).rows).toEqual(before);
  });

  it("round-trips amounts and timestamps exactly", async () => {
    const t = dataset.transactions[1234];
    const { rows } = await db.query<{ amount: string; occurred_at: Date }>(
      "select amount::text, occurred_at from public.transactions where id = $1",
      [t.id],
    );
    expect(Number(rows[0].amount)).toBe(t.amount);
    expect(rows[0].occurred_at.getTime()).toBe(t.occurredAt);
  });

  it("re-seed also clears alerts created on seed transactions, and keeps non-seed data", async () => {
    const txn = dataset.transactions[0];
    await db.query(
      "insert into public.alerts (transaction_id, customer_id, risk_score, severity, reason_codes) values ($1, $2, 70, 'high', array['X'])",
      [txn.id, txn.customerId],
    );
    await db.query(
      "insert into public.customers (external_ref, full_name, account_masked, home_city, segment, kyc_tier) values ('REAL-1', 'Keep Me', 'XXXX1111', 'Pune', 'retail', 2)",
    );
    await db.exec(`begin; ${sql} commit;`);
    expect((await db.query("select * from public.alerts")).rows).toHaveLength(0);
    expect((await db.query("select * from public.customers where external_ref = 'REAL-1'")).rows).toHaveLength(1);
  });

  it("a failure mid-seed rolls back completely", async () => {
    const broken = sql.replace("insert into public.fraud_labels", "insert into public.fraud_labelz");
    await expect(db.exec(`begin; ${broken} commit;`)).rejects.toThrow();
    await db.exec("rollback");
    expect(await counts()).toEqual({ customers: 200, transactions: 5000, labels: dataset.labels.length });
  });

  it("rejects unknown pattern codes", async () => {
    await expect(
      db.query("insert into public.fraud_labels (transaction_id, pattern) values ($1, 'suspicious stuff')", [
        dataset.transactions[1].id,
      ]),
    ).rejects.toThrow(/fraud_labels_pattern_chk/);
  });

  it("analysts see seeded transactions but not the ground truth", async () => {
    const analyst = await createUser(db, "analyst");
    await as(db, "authenticated", analyst, async () => {
      expect((await db.query("select id from public.transactions")).rows).toHaveLength(5000);
      expect((await db.query("select * from public.fraud_labels")).rows).toHaveLength(0);
    });
  });
});
