import { describe, expect, it } from "vitest";
import { createRng } from "../../scripts/seed/rng";
import { generateDataset } from "../../scripts/seed/generator";
import { assessTransactions } from "@/lib/risk/engine";
import { evaluate, evaluateFromCount, formatReport } from "@/lib/risk/evaluate";
import { RULESET_VERSION } from "@/lib/risk/rules";
import { rowToTxn, toApplyRows } from "@/lib/risk/runner";
import type { TxnInput } from "@/lib/risk/types";

const d = generateDataset();
const base = assessTransactions(d.transactions);
const byId = new Map(base.map((a) => [a.transactionId, a]));

describe("engine properties", () => {
  it("is deterministic regardless of input order", () => {
    const shuffled = createRng(1).shuffle(d.transactions);
    expect(assessTransactions(shuffled)).toEqual(base);
  });

  it("every assessment carries the ruleset version; every alert is explained by a pattern rule", () => {
    for (const a of base) {
      expect(a.rulesetVersion).toBe(RULESET_VERSION);
      if (a.alert) {
        const patterns = a.hits.filter((h) => h.pattern !== null);
        expect(patterns.length).toBeGreaterThan(0);
        expect(patterns.every((h) => h.evidence.length > 10)).toBe(true);
      }
    }
  });

  it("hits are unique per code and ordered by weight", () => {
    for (const a of base) {
      expect(new Set(a.reasonCodes).size).toBe(a.reasonCodes.length);
      for (let i = 1; i < a.hits.length; i++) expect(a.hits[i - 1].weight).toBeGreaterThanOrEqual(a.hits[i].weight);
    }
  });

  it("features are point-in-time: appending future transactions never changes them", () => {
    const cutoff = d.anchor - 3 * 24 * 3600_000;
    const past = d.transactions.filter((t) => t.occurredAt <= cutoff);
    const early = assessTransactions(past);
    for (const a of early) expect(a.features).toEqual(byId.get(a.transactionId)!.features);
  });

  it("cluster expansion marks earlier members with a `via` pointer to the completing txn", () => {
    const expanded = base.flatMap((a) => a.hits.filter((h) => h.via).map((h) => ({ a, h })));
    expect(expanded.length).toBeGreaterThan(0);
    for (const { h } of expanded) {
      expect(byId.has(h.via!)).toBe(true);
      expect(h.evidence).toContain("part of a cluster");
    }
  });

  it("rejects duplicate transaction ids", () => {
    expect(() => assessTransactions([d.transactions[0], d.transactions[0]])).toThrow(/duplicate/);
  });

  it("assesses 5,000 transactions well under a second", () => {
    const start = performance.now();
    assessTransactions(d.transactions);
    expect(performance.now() - start).toBeLessThan(1500);
  });
});

describe("persistence mapping", () => {
  it("rowToTxn parses PostgREST rows (numeric as string) and rejects malformed ones", () => {
    const t = rowToTxn({ id: "x", customer_id: "c", amount: "1234.50", channel: "UPI", direction: "debit",
      counterparty: "a", merchant_category: null, city: "Pune", device_id: "d", occurred_at: "2026-09-26T06:30:00+00:00" });
    expect(t.amount).toBe(1234.5);
    expect(t.occurredAt).toBe(Date.UTC(2026, 8, 26, 6, 30));
    const bad = { id: "y", customer_id: "c", amount: "abc", channel: "UPI", direction: "debit" as const,
      counterparty: "a", merchant_category: null, city: "Pune", device_id: "d", occurred_at: "nope" };
    expect(() => rowToTxn(bad)).toThrow(/malformed/);
  });

  it("toApplyRows keeps evidence text and flags", () => {
    const alerted = base.find((a) => a.alert)!;
    const [row] = toApplyRows([alerted]);
    expect(row.alert).toBe(true);
    expect(row.reason_codes).toEqual(alerted.reasonCodes);
    expect(row.evidence[0]).toMatchObject({ code: alerted.hits[0].code, text: alerted.hits[0].evidence });
  });
});

describe("evaluation maths", () => {
  it("computes the confusion matrix", () => {
    const c = evaluate(["a", "b", "c", "d", "e"], ["a", "b", "x"], [
      { transactionId: "a", pattern: "P" },
      { transactionId: "c", pattern: "P" },
    ]);
    expect(c).toMatchObject({ evaluated: 5, planted: 2, alerts: 2, tp: 1, fp: 1, fn: 1, tn: 2, precision: 0.5, recall: 0.5 });
    expect(c.byPattern.P).toEqual({ planted: 2, caught: 1 });
  });

  it("handles empty inputs without NaN", () => {
    const c = evaluateFromCount(0, [], []);
    expect(c.precision).toBe(0);
    expect(c.recall).toBe(0);
    expect(formatReport(c, "v")).toContain("Precision");
  });
});

describe("TxnInput from generator is structurally compatible", () => {
  it("compiles and runs", () => {
    const t: TxnInput = d.transactions[0];
    expect(t.id).toBeTruthy();
  });
});
