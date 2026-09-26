import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { DECISION_TO_STATUS, describeDbError } from "@/lib/decisions";
import { assessTransactions } from "@/lib/risk/engine";
import { toApplyRows } from "@/lib/risk/runner";
import { generateDataset } from "../../scripts/seed/generator";
import { datasetToSql } from "../../scripts/seed/sql";
import { as, createTestDb, createUser } from "./harness";

let db: PGlite;
let analyst: string;
let analyst2: string;
let supervisor: string;

beforeAll(async () => {
  db = await createTestDb();
  const d = generateDataset();
  await db.exec(`begin; ${datasetToSql(d)} commit;`);
  await as(db, "service_role", null, () =>
    db.query("select * from public.apply_risk_assessments($1::jsonb)", [JSON.stringify(toApplyRows(assessTransactions(d.transactions)))]),
  );
  await db.query("insert into public.audit_log (action, entity_type, entity_id) values ('risk.run', 'ruleset', 'r1')");
  analyst = await createUser(db, "analyst", "Ana");
  analyst2 = await createUser(db, "analyst", "Ben");
  supervisor = await createUser(db, "supervisor", "Sue");
}, 60_000);

/** Same patch shape as decideAction. */
async function decide(user: string, alertId: string, decision: keyof typeof DECISION_TO_STATUS, note?: string) {
  return as(db, "authenticated", user, async () => {
    const sets = ["status = $2"];
    const params: unknown[] = [alertId, DECISION_TO_STATUS[decision]];
    if (decision === "claim") { sets.push(`assigned_to = $${params.length + 1}`); params.push(user); }
    if (note) { sets.push(`resolution_note = $${params.length + 1}`); params.push(note); }
    return db.query(`update public.alerts set ${sets.join(", ")} where id = $1 returning status`, params);
  });
}
const openAlert = async () =>
  (await db.query<{ id: string }>("select id from public.alerts where status = 'open' order by id limit 1")).rows[0].id;

describe("full triage flow through the DB state machine", () => {
  it("claim → escalate → supervisor confirms, all audited with actors and notes", async () => {
    const id = await openAlert();
    await decide(analyst, id, "claim");
    await decide(analyst, id, "escalate", "Customer unreachable, possible SIM swap");
    await decide(supervisor, id, "confirm_fraud", "Confirmed with telecom SIM swap record");
    const trail = await db.query<{ actor_id: string; details: { to: string; note: string | null } }>(
      "select actor_id, details from public.audit_log where entity_id = $1 and action = 'alert.status_changed' order by id",
      [id],
    );
    expect(trail.rows.map((r) => [r.actor_id, r.details.to])).toEqual([
      [analyst, "in_review"],
      [analyst, "escalated"],
      [supervisor, "confirmed_fraud"],
    ]);
    expect(trail.rows[2].details.note).toMatch(/SIM swap/);
  });

  it("DB rejections map to specific analyst messages", async () => {
    const id = await openAlert();
    await decide(analyst, id, "claim");
    const errs: string[] = [];
    for (const attempt of [
      () => decide(analyst2, id, "false_positive", "Looks fine to me honestly"), // someone else's alert
      () => decide(analyst, id, "false_positive", "short"), // note too short (DB also checks)
    ]) {
      await attempt().catch((e: Error) => errs.push(e.message));
    }
    expect(errs).toHaveLength(2);
    expect(errs.map(describeDbError)).toEqual([
      "Another analyst is working on this alert.",
      "Add a note of at least 10 characters.",
    ]);
  });
});

describe("P4 visibility policies", () => {
  it("analysts read alert history but not other audit entries", async () => {
    await as(db, "authenticated", analyst, async () => {
      const { rows } = await db.query<{ entity_type: string }>("select distinct entity_type from public.audit_log");
      expect(rows.map((r) => r.entity_type)).toEqual(["alert"]);
    });
    await as(db, "authenticated", supervisor, async () => {
      const { rows } = await db.query("select 1 from public.audit_log where entity_type = 'ruleset'");
      expect(rows).toHaveLength(1);
    });
  });

  it("staff see colleagues' names; pending users see nothing", async () => {
    await as(db, "authenticated", analyst, async () => {
      expect((await db.query("select id from public.profiles")).rows.length).toBeGreaterThanOrEqual(3);
    });
    const pending = await createUser(db, null);
    await as(db, "authenticated", pending, async () => {
      expect((await db.query("select id from public.profiles")).rows).toHaveLength(1); // only self
      expect((await db.query("select id from public.audit_log")).rows).toHaveLength(0);
    });
  });
});
