import { describe, expect, it } from "vitest";
import { availableDecisions, DecisionInput, describeDbError } from "@/lib/decisions";
import { computeOps } from "@/lib/metrics";
import { buildNetwork, type NetTxn } from "@/lib/network";
import type { EvidenceItem } from "@/lib/queue-types";
import { buildTimeline, buildTrail, explainScore, type TimelineTxn } from "@/lib/replay";
import { assessTransactions } from "@/lib/risk/engine";
import { toApplyRows } from "@/lib/risk/runner";
import { generateDataset } from "../../scripts/seed/generator";

const d = generateDataset();
const rows = toApplyRows(assessTransactions(d.transactions));
const alerts = rows.filter((r) => r.alert);
const txById = new Map(d.transactions.map((t) => [t.id, t]));
const refOf = new Map(d.customers.map((c) => [c.id, c.externalRef]));
const toTl = (id: string): TimelineTxn & NetTxn => {
  const t = txById.get(id)!;
  return { ...t, customerRef: refOf.get(t.customerId)! };
};
const firstWith = (code: string) => alerts.find((a) => (a.reason_codes as string[]).includes(code) && a.evidence.some((e) => e.code === code && e.via === null))!;

describe("decisions", () => {
  const id = "3f2b1c4d-1111-4222-8333-444455556666";
  it("claim needs no note; everything else needs ≥ 10 chars", () => {
    expect(DecisionInput.safeParse({ alertId: id, decision: "claim" }).success).toBe(true);
    expect(DecisionInput.safeParse({ alertId: id, decision: "escalate", note: "short" }).success).toBe(false);
    expect(DecisionInput.safeParse({ alertId: id, decision: "confirm_fraud", note: "   padded   " }).success).toBe(false);
    expect(DecisionInput.safeParse({ alertId: id, decision: "false_positive", note: "Customer confirmed travel" }).success).toBe(true);
    expect(DecisionInput.safeParse({ alertId: "nope", decision: "claim" }).success).toBe(false);
    expect(DecisionInput.safeParse({ alertId: id, decision: "approve_loan" }).success).toBe(false);
  });

  it("offers only valid actions per status/role/assignee", () => {
    const me = "me";
    expect(availableDecisions("open", { isSupervisor: false, assignedTo: null, viewerId: me }).actions).toEqual(["claim", "escalate"]);
    expect(availableDecisions("in_review", { isSupervisor: false, assignedTo: me, viewerId: me }).actions).toEqual(["confirm_fraud", "false_positive", "escalate"]);
    expect(availableDecisions("in_review", { isSupervisor: false, assignedTo: "other", viewerId: me }).actions).toEqual([]);
    expect(availableDecisions("in_review", { isSupervisor: true, assignedTo: "other", viewerId: me }).actions).toHaveLength(3);
    expect(availableDecisions("escalated", { isSupervisor: false, assignedTo: me, viewerId: me }).actions).toEqual([]);
    expect(availableDecisions("escalated", { isSupervisor: true, assignedTo: me, viewerId: me }).actions).toEqual(["confirm_fraud", "false_positive"]);
    expect(availableDecisions("confirmed_fraud", { isSupervisor: true, assignedTo: me, viewerId: me }).actions).toEqual([]);
  });

  it("maps every DB guard error to a specific message", () => {
    for (const code of ["invalid_transition open -> x", "note_required", "not_assignee", "alert_closed", "assign_forbidden"]) {
      expect(describeDbError(code)).not.toBe(describeDbError("something else"));
    }
  });
});

describe("decision replay — score arithmetic", () => {
  it("reproduces the stored score for every alert from persisted evidence", () => {
    for (const a of alerts) {
      const x = explainScore(a.evidence as EvidenceItem[], a.score);
      expect(x.consistent, a.transaction_id).toBe(true);
    }
  });

  it("detects tampered evidence", () => {
    const a = alerts[0];
    const tampered = (a.evidence as EvidenceItem[]).map((e, i) => (i === 0 ? { ...e, weight: e.weight - 30 } : e));
    expect(explainScore(tampered, a.score).consistent).toBe(false);
  });

  it("reports signal capping", () => {
    const ev: EvidenceItem[] = [
      { code: "STRUCTURING", pattern: "STRUCTURING", weight: 60, text: "", via: null },
      ...["A", "B", "C", "D", "E"].map((c) => ({ code: c, pattern: null, weight: 10, text: "", via: null })),
    ];
    const x = explainScore(ev, 100);
    expect(x).toMatchObject({ signalSum: 50, signalCounted: 45, signalCapped: true, total: 100, cappedAt100: true, consistent: true });
  });
});

describe("decision replay — timeline", () => {
  it("velocity: every burst member is marked, the completing txn says 'completes'", () => {
    const a = firstWith("VELOCITY_BURST");
    const ev = a.evidence as EvidenceItem[];
    const members = ev.find((e) => e.code === "VELOCITY_BURST")!.members!;
    expect(members.length).toBeGreaterThanOrEqual(6);
    const tl = buildTimeline(toTl(a.transaction_id), ev, members.filter((m) => m !== a.transaction_id).map(toTl));
    expect(tl.filter((t) => t.clusters.includes("VELOCITY_BURST"))).toHaveLength(members.length);
    expect(tl.find((t) => t.isAlert)!.completes).toContain("VELOCITY_BURST");
    expect(tl.map((t) => t.occurredAt)).toEqual([...tl.map((t) => t.occurredAt)].sort((x, y) => x - y));
  });

  it("an expanded member alert points to the txn that completed its cluster", () => {
    const a = alerts.find((x) => x.evidence.some((e) => e.via))!;
    const e = (a.evidence as EvidenceItem[]).find((x) => x.via)!;
    const tl = buildTimeline(toTl(a.transaction_id), a.evidence as EvidenceItem[], e.members!.filter((m) => m !== a.transaction_id).map(toTl));
    const completer = tl.find((t) => t.id === e.via)!;
    expect(completer.completes).toContain(e.code);
    expect(tl.find((t) => t.isAlert)!.completes).not.toContain(e.code);
  });

  it("mule ring: other customers are flagged as other customers", () => {
    const a = firstWith("MULE_RING");
    const members = (a.evidence as EvidenceItem[]).find((e) => e.code === "MULE_RING")!.members!;
    const tl = buildTimeline(toTl(a.transaction_id), a.evidence as EvidenceItem[], members.filter((m) => m !== a.transaction_id).map(toTl));
    expect(tl.filter((t) => t.isOtherCustomer).length).toBeGreaterThanOrEqual(4);
  });

  it("impossible travel: marks the new city", () => {
    const a = firstWith("IMPOSSIBLE_TRAVEL");
    const alertTx = toTl(a.transaction_id);
    const history = d.transactions.filter((t) => t.customerId === alertTx.customerId && t.occurredAt < alertTx.occurredAt).slice(-5).map((t) => toTl(t.id));
    const tl = buildTimeline(alertTx, a.evidence as EvidenceItem[], history);
    expect(tl.find((t) => t.isAlert)!.newCity).toBe(true);
  });
});

describe("decision replay — trail", () => {
  it("renders human steps and hides bookkeeping rows", () => {
    const trail = buildTrail(
      [
        { id: 1, actor_id: null, action: "alert.created", details: { risk_score: 88, severity: "critical" }, created_at: "2026-09-26T06:00:00Z" },
        { id: 2, actor_id: "u1", action: "ai.summary_generated", details: { source: "llm" }, created_at: "2026-09-26T06:01:00Z" },
        { id: 3, actor_id: null, action: "alert.ai_summary", details: {}, created_at: "2026-09-26T06:01:00Z" },
        { id: 4, actor_id: "u1", action: "alert.status_changed", details: { to: "in_review" }, created_at: "2026-09-26T06:02:00Z" },
        { id: 5, actor_id: "u2", action: "alert.status_changed", details: { to: "confirmed_fraud", note: "Customer denied" }, created_at: "2026-09-26T06:05:00Z" },
      ],
      new Map([["u2", "Sue (supervisor)"]]),
      "u1",
    );
    expect(trail.map((s) => `${s.actor}: ${s.label}`)).toEqual([
      "Rules engine: Alert created (score 88, critical)",
      "You: Requested AI brief (llm)",
      "You: claimed for review",
      "Sue (supervisor): confirmed as fraud",
    ]);
    expect(trail[3].note).toBe("Customer denied");
  });
});

describe("money network", () => {
  it("fan-in: the ring's customers all point at the mule account", () => {
    const a = firstWith("MULE_RING");
    const alertTx = toTl(a.transaction_id);
    const net = buildNetwork("fan_in", alertTx, d.transactions.map((t) => toTl(t.id)))!;
    expect(net.left.length).toBeGreaterThanOrEqual(5);
    expect(net.center.label).toBe(alertTx.counterparty);
    expect(net.edges.filter((e) => e.highlight)).toHaveLength(1);
  });

  it("pass-through: senders → mule → recipients", () => {
    const a = firstWith("MULE_PASS_THROUGH");
    const alertTx = toTl(a.transaction_id);
    const net = buildNetwork("pass_through", alertTx, d.transactions.filter((t) => t.customerId === alertTx.customerId).map((t) => toTl(t.id)))!;
    expect(net.left.length).toBeGreaterThanOrEqual(4);
    expect(net.right.length).toBeGreaterThanOrEqual(4);
    expect(net.title).toMatch(/in from \d+ senders/);
  });

  it("returns null for a lone payment", () => {
    const t = d.transactions.find((x) => x.direction === "debit" && x.merchantCategory === null && !alerts.some((a) => a.transaction_id === x.id))!;
    expect(buildNetwork("fan_in", toTl(t.id), [toTl(t.id)])).toBeNull();
  });
});

describe("rule performance", () => {
  it("computes per-code precision from analyst outcomes", () => {
    const at = (m: number) => new Date(Date.UTC(2026, 8, 26, 6, m)).toISOString();
    const ops = computeOps([
      { reason_codes: ["STRUCTURING", "NEAR_THRESHOLD"], status: "confirmed_fraud", created_at: at(0), resolved_at: at(10) },
      { reason_codes: ["STRUCTURING"], status: "false_positive", created_at: at(0), resolved_at: at(30) },
      { reason_codes: ["STRUCTURING"], status: "open", created_at: at(0), resolved_at: null },
      { reason_codes: ["VELOCITY_BURST"], status: "in_review", created_at: at(0), resolved_at: null },
    ]);
    expect(ops).toMatchObject({ total: 4, pending: 2, confirmed: 1, falsePositive: 1, medianMinutesToClose: 20 });
    expect(ops.rules[0]).toEqual({ code: "STRUCTURING", triggered: 3, confirmed: 1, falsePositive: 1, pending: 1, precision: 0.5 });
    expect(ops.rules.find((r) => r.code === "VELOCITY_BURST")!.precision).toBeNull();
  });

  it("handles no alerts", () => {
    expect(computeOps([])).toMatchObject({ total: 0, medianMinutesToClose: null, rules: [] });
  });
});
