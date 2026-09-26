import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { buildCaseContext } from "@/lib/ai/minimize";
import { buildAiUpdate, summarizeCase } from "@/lib/ai/summarize";
import { assessTransactions } from "@/lib/risk/engine";
import { toApplyRows } from "@/lib/risk/runner";
import { generateDataset } from "../../scripts/seed/generator";
import { datasetToSql } from "../../scripts/seed/sql";
import { as, createTestDb, createUser } from "./harness";

let db: PGlite;
const d = generateDataset();

beforeAll(async () => {
  db = await createTestDb();
  await db.exec(`begin; ${datasetToSql(d)} commit;`);
  const rows = toApplyRows(assessTransactions(d.transactions));
  await as(db, "service_role", null, () => db.query("select * from public.apply_risk_assessments($1::jsonb)", [JSON.stringify(rows)]));
}, 60_000);

const SCORING = "risk_score, severity, reason_codes, evidence, ruleset_version, status, assigned_to, resolution_note";

describe("AI summary persistence against the real schema", () => {
  it("writing the AI update changes only ai_* columns, and is audited", async () => {
    const analyst = await createUser(db, "analyst");
    const { rows: [{ id }] } = await db.query<{ id: string }>("select id from public.alerts order by risk_score desc, id limit 1");
    await as(db, "authenticated", analyst, () => db.query("update public.alerts set status = 'in_review' where id = $1", [id]));
    const before = (await db.query(`select ${SCORING} from public.alerts where id = $1`, [id])).rows[0];

    // Minimal but real record (fallback path — no network in tests).
    const ctx = buildCaseContext({
      alert: { id, riskScore: 90, severity: "critical", reasonCodes: ["STRUCTURING"], evidence: [{ code: "STRUCTURING", pattern: "STRUCTURING", weight: 60, text: "x", via: null }] },
      txn: { ...d.transactions[0] },
      customer: { id: d.customers[0].id, fullName: "A", externalRef: "SEED-1", accountMasked: "XXXX0000", segment: "retail", kycTier: 2, homeCity: "Pune" },
      features: null,
      history: [],
    });
    const update = buildAiUpdate(await summarizeCase(ctx, null));
    const cols = Object.keys(update);
    await as(db, "service_role", null, () =>
      db.query(
        `update public.alerts set ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")} where id = $1`,
        [id, ...cols.map((c) => (c === "ai_summary" ? JSON.stringify(update[c as keyof typeof update]) : update[c as keyof typeof update]))],
      ),
    );

    const after = await db.query<Record<string, unknown>>(`select ${SCORING}, ai_model, ai_summary from public.alerts where id = $1`, [id]);
    const { ai_model, ai_summary, ...scoring } = after.rows[0];
    expect(scoring).toEqual(before);
    expect(ai_model).toBe("fallback:llm_disabled");
    expect((ai_summary as { source: string }).source).toBe("fallback");
    const audit = await db.query("select 1 from public.audit_log where entity_id = $1 and action = 'alert.ai_summary'", [id]);
    expect(audit.rows).toHaveLength(1);
  });

  it("users still cannot write AI fields directly", async () => {
    const analyst = await createUser(db, "analyst");
    await as(db, "authenticated", analyst, async () => {
      const { rows: [{ id }] } = await db.query<{ id: string }>("select id from public.alerts where status = 'open' limit 1");
      await expect(db.query(`update public.alerts set ai_summary = '{"x":1}' where id = $1`, [id])).rejects.toThrow(/alert_field_immutable/);
    });
  });
});
