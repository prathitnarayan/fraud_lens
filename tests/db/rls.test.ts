import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { as, createTestDb, createUser, seedAlert } from "./harness";

let db: PGlite;
let analyst: string;
let analyst2: string;
let supervisor: string;
let pending: string;
let alertId: string;

beforeAll(async () => {
  db = await createTestDb();
  analyst = await createUser(db, "analyst", "Ana");
  analyst2 = await createUser(db, "analyst", "Ben");
  supervisor = await createUser(db, "supervisor", "Sue");
  pending = await createUser(db, null, "Pending");
}, 60_000);

beforeEach(async () => {
  ({ alertId } = await seedAlert(db));
});

const update = (sql: string, params: unknown[] = []) => db.query(sql, params);

describe("access control", () => {
  it("anon has no table privileges", async () => {
    await expect(as(db, "anon", null, () => db.query("select * from public.alerts"))).rejects.toThrow(
      /permission denied/,
    );
  });

  it("new sign-up gets no role, even if metadata claims admin, and sees no data", async () => {
    const { rows } = await db.query<{ role: string | null }>("select role from public.profiles where id = $1", [
      pending,
    ]);
    expect(rows[0].role).toBeNull();
    const r = await as(db, "authenticated", pending, () => db.query("select id from public.alerts"));
    expect(r.rows).toHaveLength(0);
  });

  it("analyst reads alerts/customers, not fraud labels, and only alert history from the audit log (P4 policy)", async () => {
    await db.query("insert into public.audit_log (action, entity_type, entity_id) values ('risk.run', 'ruleset', 'r1')");
    await as(db, "authenticated", analyst, async () => {
      expect((await db.query("select id from public.alerts")).rows.length).toBeGreaterThan(0);
      expect((await db.query("select id from public.customers")).rows.length).toBeGreaterThan(0);
      expect((await db.query("select * from public.fraud_labels")).rows).toHaveLength(0);
      const types = (await db.query<{ entity_type: string }>("select distinct entity_type from public.audit_log")).rows;
      expect(types.map((r) => r.entity_type)).toEqual(["alert"]);
    });
  });

  it("supervisor reads fraud labels and audit log", async () => {
    await as(db, "authenticated", supervisor, async () => {
      expect((await db.query("select * from public.fraud_labels")).rows.length).toBeGreaterThan(0);
      expect((await db.query("select * from public.audit_log")).rows.length).toBeGreaterThan(0);
    });
  });

  it("analyst cannot insert alerts or transactions", async () => {
    await as(db, "authenticated", analyst, async () => {
      await expect(
        db.query(
          "insert into public.alerts (transaction_id, customer_id, risk_score, severity, reason_codes) select transaction_id, customer_id, 1, 'low', array['X'] from public.alerts limit 1",
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(db.query("delete from public.alerts")).rejects.toThrow(/permission denied/);
    });
  });

  it("analyst cannot escalate own role", async () => {
    await as(db, "authenticated", analyst, async () => {
      await expect(update("update public.profiles set role = 'admin' where id = $1", [analyst])).rejects.toThrow(
        /profile_role_immutable/,
      );
    });
  });

  it("analyst cannot tamper with risk score or AI summary", async () => {
    await as(db, "authenticated", analyst, async () => {
      await expect(update("update public.alerts set risk_score = 1 where id = $1", [alertId])).rejects.toThrow(
        /alert_field_immutable/,
      );
      await expect(
        update(`update public.alerts set ai_summary = '{"x":1}' where id = $1`, [alertId]),
      ).rejects.toThrow(/alert_field_immutable/);
    });
  });
});

describe("alert state machine", () => {
  it("open → in_review auto-assigns the analyst", async () => {
    await as(db, "authenticated", analyst, () =>
      update("update public.alerts set status = 'in_review' where id = $1", [alertId]),
    );
    const { rows } = await db.query<{ assigned_to: string }>("select assigned_to from public.alerts where id = $1", [
      alertId,
    ]);
    expect(rows[0].assigned_to).toBe(analyst);
  });

  it("open → confirmed_fraud is rejected", async () => {
    await as(db, "authenticated", analyst, async () => {
      await expect(
        update(
          "update public.alerts set status = 'confirmed_fraud', resolution_note = 'long enough note' where id = $1",
          [alertId],
        ),
      ).rejects.toThrow(/invalid_transition/);
    });
  });

  it("resolution requires a note ≥ 10 chars and sets resolved_at; closed alerts are frozen", async () => {
    await as(db, "authenticated", analyst, async () => {
      await update("update public.alerts set status = 'in_review' where id = $1", [alertId]);
      await expect(
        update("update public.alerts set status = 'false_positive', resolution_note = 'ok' where id = $1", [alertId]),
      ).rejects.toThrow(/note_required/);
      await update(
        "update public.alerts set status = 'false_positive', resolution_note = 'Customer confirmed travel' where id = $1",
        [alertId],
      );
      await expect(
        update("update public.alerts set resolution_note = 'changed my mind!' where id = $1", [alertId]),
      ).rejects.toThrow(/alert_closed/);
    });
    const { rows } = await db.query<{ resolved_at: Date | null }>(
      "select resolved_at from public.alerts where id = $1",
      [alertId],
    );
    expect(rows[0].resolved_at).not.toBeNull();
  });

  it("analyst cannot act on another analyst's alert or assign to others", async () => {
    await as(db, "authenticated", analyst, () =>
      update("update public.alerts set status = 'in_review' where id = $1", [alertId]),
    );
    await as(db, "authenticated", analyst2, async () => {
      await expect(
        update(
          "update public.alerts set status = 'escalated', resolution_note = 'escalating this one' where id = $1",
          [alertId],
        ),
      ).rejects.toThrow(/not_assignee/);
      await expect(
        update("update public.alerts set assigned_to = $2 where id = $1", [alertId, supervisor]),
      ).rejects.toThrow(/assign_forbidden/);
    });
  });

  it("only a supervisor can close an escalated alert", async () => {
    await as(db, "authenticated", analyst, async () => {
      await update(
        "update public.alerts set status = 'escalated', resolution_note = 'Needs supervisor call' where id = $1",
        [alertId],
      );
      await expect(
        update(
          "update public.alerts set status = 'confirmed_fraud', resolution_note = 'Confirmed by customer' where id = $1",
          [alertId],
        ),
      ).rejects.toThrow(/invalid_transition/);
    });
    await as(db, "authenticated", supervisor, () =>
      update(
        "update public.alerts set status = 'confirmed_fraud', resolution_note = 'Confirmed by customer call' where id = $1",
        [alertId],
      ),
    );
    const { rows } = await db.query<{ status: string }>("select status from public.alerts where id = $1", [alertId]);
    expect(rows[0].status).toBe("confirmed_fraud");
  });
});

describe("audit log", () => {
  it("records status changes with the acting user", async () => {
    await as(db, "authenticated", analyst, () =>
      update("update public.alerts set status = 'in_review' where id = $1", [alertId]),
    );
    const { rows } = await db.query<{ actor_id: string; action: string; details: { to: string } }>(
      "select actor_id, action, details from public.audit_log where entity_id = $1 order by id",
      [alertId],
    );
    expect(rows.map((r) => r.action)).toEqual(["alert.created", "alert.status_changed"]);
    expect(rows[1].actor_id).toBe(analyst);
    expect(rows[1].details.to).toBe("in_review");
  });

  it("is append-only for everyone, including service_role and superuser", async () => {
    await expect(db.query("delete from public.audit_log")).rejects.toThrow(/audit_log_append_only/);
    await expect(db.query("update public.audit_log set action = 'x'")).rejects.toThrow(/audit_log_append_only/);
    await as(db, "service_role", null, async () => {
      await expect(db.query("delete from public.audit_log")).rejects.toThrow(/permission denied/);
    });
  });

  it("users can only write audit rows as themselves", async () => {
    await as(db, "authenticated", analyst, async () => {
      await expect(
        db.query(
          "insert into public.audit_log (actor_id, action, entity_type, entity_id) values ($1, 'alert.viewed', 'alert', 'x')",
          [supervisor],
        ),
      ).rejects.toThrow(/row-level security/);
      await db.query(
        "insert into public.audit_log (actor_id, action, entity_type, entity_id) values ($1, 'alert.viewed', 'alert', 'x')",
        [analyst],
      );
    });
  });
});
