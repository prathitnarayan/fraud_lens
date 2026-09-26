import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { assessTransactions } from "@/lib/risk/engine";
import { toApplyRows } from "@/lib/risk/runner";
import { generateDataset } from "../../scripts/seed/generator";
import { datasetToSql } from "../../scripts/seed/sql";
import { as, createTestDb, createUser } from "./harness";

let db: PGlite;
const d = generateDataset();
const rows = toApplyRows(assessTransactions(d.transactions));
const expectedAlerts = rows.filter((r) => r.alert).length;

async function apply(payload: unknown) {
  return as(db, "service_role", null, async () => {
    const r = await db.query<{ assessed: number; alerts_created: number }>(
      "select * from public.apply_risk_assessments($1::jsonb)",
      [JSON.stringify(payload)],
    );
    return r.rows[0];
  });
}
const count = async (sql: string) => Number((await db.query<{ n: number }>(`select count(*)::int n from ${sql}`)).rows[0].n);

beforeAll(async () => {
  db = await createTestDb();
  await db.exec(`begin; ${datasetToSql(d)} commit;`);
}, 60_000);

describe("apply_risk_assessments", () => {
  it("persists every assessment and creates one alert per flagged transaction", async () => {
    let created = 0;
    for (let i = 0; i < rows.length; i += 1000) created += (await apply(rows.slice(i, i + 1000))).alerts_created;
    expect(created).toBe(expectedAlerts);
    expect(await count("public.risk_assessments")).toBe(5000);
    expect(await count("public.alerts")).toBe(expectedAlerts);
  });

  it("stores explainable alerts: reason codes, evidence and ruleset version", async () => {
    const { rows: [a] } = await db.query<{ reason_codes: string[]; evidence: { text: string }[]; ruleset_version: string }>(
      "select reason_codes, evidence, ruleset_version from public.alerts order by risk_score desc limit 1",
    );
    expect(a.reason_codes.length).toBeGreaterThan(0);
    expect(a.evidence[0].text.length).toBeGreaterThan(10);
    expect(a.ruleset_version).toMatch(/^\d{4}\.\d{2}\.\d{2}-r\d+$/);
  });

  it("is idempotent: re-running creates no alerts and keeps counts", async () => {
    const before = (await db.query("select id, risk_score from public.alerts order by id")).rows;
    const r = await apply(rows);
    expect(r.alerts_created).toBe(0);
    expect(r.assessed).toBe(5000);
    expect((await db.query("select id, risk_score from public.alerts order by id")).rows).toEqual(before);
  });

  it("re-running never resets analyst work on existing alerts", async () => {
    const analyst = await createUser(db, "analyst");
    const { rows: [{ id }] } = await db.query<{ id: string }>("select id from public.alerts order by risk_score desc limit 1");
    await as(db, "authenticated", analyst, () =>
      db.query("update public.alerts set status = 'in_review' where id = $1", [id]),
    );
    await apply(rows);
    const { rows: [a] } = await db.query<{ status: string; assigned_to: string }>(
      "select status, assigned_to from public.alerts where id = $1",
      [id],
    );
    expect(a).toEqual({ status: "in_review", assigned_to: analyst });
  });

  it("rejects non-array payloads", async () => {
    await expect(apply({ not: "an array" })).rejects.toThrow(/must be a JSON array/);
  });

  it("each new alert is audited once", async () => {
    expect(await count("public.audit_log where action = 'alert.created'")).toBe(expectedAlerts);
  });
});

describe("access control on P2 objects", () => {
  it("analysts and anon cannot run the apply function", async () => {
    const analyst = await createUser(db, "analyst");
    await as(db, "authenticated", analyst, async () => {
      await expect(db.query("select * from public.apply_risk_assessments('[]'::jsonb)")).rejects.toThrow(/permission denied/);
    });
    await as(db, "anon", null, async () => {
      await expect(db.query("select * from public.apply_risk_assessments('[]'::jsonb)")).rejects.toThrow(/permission denied/);
    });
  });

  it("analysts read assessments but cannot write them or alter alert evidence", async () => {
    const analyst = await createUser(db, "analyst");
    await as(db, "authenticated", analyst, async () => {
      expect(await count("public.risk_assessments")).toBe(5000);
      await expect(db.query("update public.risk_assessments set score = 0")).rejects.toThrow(/permission denied/);
      const { rows: [{ id }] } = await db.query<{ id: string }>(
        "select id from public.alerts where status = 'open' and assigned_to is null limit 1",
      );
      await expect(db.query(`update public.alerts set evidence = '[]' where id = $1`, [id])).rejects.toThrow(/alert_field_immutable/);
      await expect(db.query(`update public.alerts set ruleset_version = 'x' where id = $1`, [id])).rejects.toThrow(/alert_field_immutable/);
    });
  });

  it("pending users see no assessments", async () => {
    const pending = await createUser(db, null);
    await as(db, "authenticated", pending, async () => {
      expect(await count("public.risk_assessments")).toBe(0);
    });
  });

  it("re-seeding cascades assessments and alerts away cleanly", async () => {
    await db.exec(`begin; ${datasetToSql(d)} commit;`);
    expect(await count("public.risk_assessments")).toBe(0);
    expect(await count("public.alerts")).toBe(0);
  });
});
