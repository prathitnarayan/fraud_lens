import { describe, expect, it } from "vitest";
import { FRAUD_PATTERNS } from "@/lib/fraud-patterns";
import { assessTransactions } from "@/lib/risk/engine";
import { evaluate } from "@/lib/risk/evaluate";
import { ALERT_THRESHOLD } from "@/lib/risk/rules";
import { generateDataset } from "../../scripts/seed/generator";

/**
 * Planted-fraud evaluation. NOTE: rules and generator share the same pattern definitions, so
 * these numbers prove the engine is *correct* on known behaviours — not real-world accuracy.
 */
describe.each([20260926, 11, 12345])("seed %i", (seed) => {
  const d = generateDataset({ seed });
  const assessments = assessTransactions(d.transactions);
  const alerted = assessments.filter((a) => a.alert).map((a) => a.transactionId);
  const c = evaluate(d.transactions.map((t) => t.id), alerted, d.labels);
  const score = new Map(assessments.map((a) => [a.transactionId, a.score]));

  it("precision and recall ≥ 95%", () => {
    expect(c.precision).toBeGreaterThanOrEqual(0.95);
    expect(c.recall).toBeGreaterThanOrEqual(0.95);
  });

  it("catches every fraud pattern", () => {
    for (const p of FRAUD_PATTERNS) expect(c.byPattern[p]?.caught ?? 0, p).toBeGreaterThan(0);
  });

  it("no look-alike transaction is alerted", () => {
    for (const s of d.scenarios.filter((x) => x.kind === "lookalike")) {
      for (const id of s.transactionIds) expect(score.get(id)!, s.ref).toBeLessThan(ALERT_THRESHOLD);
    }
  });

  it("fraud rate of alerts is sane (no alert flood)", () => {
    expect(c.alerts).toBeLessThan(d.transactions.length * 0.05);
  });
});
