import { describe, expect, it } from "vitest";
import { agreementOf, combine, MODEL_FLAG_THRESHOLD, scoreModels } from "@/lib/models";
import { behaviourModel, beneficiaryModel, networkModel } from "@/lib/models/detectors";
import { detectorStats } from "@/lib/models/metrics";
import { assessTransactions } from "@/lib/risk/engine";
import { assessAll, toApplyRows } from "@/lib/risk/runner";
import type { TxnInput } from "@/lib/risk/types";
import { generateDataset } from "../../scripts/seed/generator";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 8, 20, 6, 30);
let seq = 0;
const tx = (p: Partial<TxnInput> = {}): TxnInput => ({
  id: `m${String(++seq).padStart(5, "0")}`, customerId: "c1", amount: 1000, channel: "UPI", direction: "debit",
  counterparty: "merchant:shop", merchantCategory: "grocery", city: "Pune", deviceId: "d1", occurredAt: T0, ...p,
});
const history = (k = 20, p: Partial<TxnInput> = {}) =>
  Array.from({ length: k }, (_, i) => tx({ occurredAt: T0 - (k - i) * DAY + (i % 5) * HOUR, ...p }));

describe("combine (noisy-OR)", () => {
  it("is bounded, monotonic and attributable", () => {
    const one = combine("behaviour", [{ key: "a", weight: 0.6, strength: 1, text: "" }]);
    const two = combine("behaviour", [{ key: "a", weight: 0.6, strength: 1, text: "" }, { key: "b", weight: 0.5, strength: 1, text: "" }]);
    expect(one.score).toBe(60);
    expect(two.score).toBe(80);
    expect(two.factors[0].key).toBe("a");
    expect(combine("behaviour", [{ key: "a", weight: 1, strength: 5, text: "" }]).score).toBe(100);
    expect(combine("beneficiary", [{ key: "a", weight: 1, strength: 1, text: "" }], false).score).toBe(0);
  });
});

describe("behaviour model", () => {
  it("is silent with too little history", () => {
    expect(behaviourModel(tx(), history(3)).score).toBe(0);
  });
  it("normal repeat behaviour scores low; new device + 40× amount + new city scores high", () => {
    const h = history(20);
    expect(behaviourModel(tx({ occurredAt: T0 + HOUR }), h).score).toBeLessThan(30);
    const odd = behaviourModel(tx({ amount: 40_000, deviceId: "new", city: "Kolkata", counterparty: "x@y", merchantCategory: null }), h);
    expect(odd.score).toBeGreaterThanOrEqual(MODEL_FLAG_THRESHOLD);
    expect(odd.factors.map((f) => f.key)).toEqual(expect.arrayContaining(["amount", "device", "city"]));
  });
});

describe("beneficiary model", () => {
  const pay = (customerId: string, at: number) => tx({ customerId, counterparty: "helpdesk@ybl", merchantCategory: null, occurredAt: at, amount: 9999 });
  it("only applies to person-to-person debits", () => {
    expect(beneficiaryModel(tx(), [], []).applicable).toBe(false);
    expect(beneficiaryModel(tx({ direction: "credit", merchantCategory: null }), [], []).applicable).toBe(false);
  });
  it("one payer → low; five different customers in 24h → flagged", () => {
    expect(beneficiaryModel(pay("a", T0), [], history(10)).score).toBeLessThan(40);
    const prior = ["a", "b", "c", "d"].map((c, i) => pay(c, T0 + i * HOUR));
    expect(beneficiaryModel(pay("e", T0 + 5 * HOUR), prior, history(10)).score).toBeGreaterThanOrEqual(MODEL_FLAG_THRESHOLD);
  });
});

describe("network model", () => {
  it("a business paying its own suppliers after sales is not flagged", () => {
    const h = [...history(20), ...[0, 1].map((i) => tx({ direction: "credit", counterparty: "regular@upi", merchantCategory: null, amount: 30_000, occurredAt: T0 + i * HOUR }))];
    expect(networkModel(tx({ counterparty: "supplier@upi", merchantCategory: null, amount: 50_000, occurredAt: T0 + 3 * HOUR }), h).score).toBeLessThan(MODEL_FLAG_THRESHOLD);
  });
  it("many senders → most of it sent onward fast → flagged", () => {
    const credits = [0, 1, 2, 3, 4].map((i) => tx({ direction: "credit", counterparty: `s${i}@upi`, merchantCategory: null, amount: 30_000, occurredAt: T0 + i * 30 * MIN }));
    const outs = [0, 1, 2].map((i) => tx({ counterparty: `o${i}@upi`, merchantCategory: null, amount: 40_000, occurredAt: T0 + 3 * HOUR + i * 5 * MIN }));
    const all = [...history(20), ...credits, ...outs];
    const last = tx({ counterparty: "o3@upi", merchantCategory: null, amount: 20_000, occurredAt: T0 + 3.5 * HOUR });
    expect(networkModel(last, all).score).toBeGreaterThanOrEqual(MODEL_FLAG_THRESHOLD);
  });
});

describe("models catch what the rules don't (research case: one victim → many new accounts)", () => {
  // Matrimonial/'gift' scam pattern: victim pays 10 different new accounts over ~2.5h, no inbound money.
  const h = history(25);
  const burst = Array.from({ length: 10 }, (_, i) =>
    tx({ counterparty: `acct${i}@ibl`, merchantCategory: null, amount: 18_000 + i * 700, occurredAt: T0 + 2 * HOUR + i * 15 * MIN }),
  );
  const all = [...h, ...burst];
  const rules = assessTransactions(all);
  const models = scoreModels(all, new Map(rules.map((a) => [a.transactionId, a.score])));
  const last = burst.at(-1)!;

  it("rules raise no alert anywhere in the sequence", () => {
    expect(rules.filter((a) => a.alert)).toEqual([]);
  });
  it("network model flags it, and it surfaces as a model-only candidate", () => {
    const m = models.get(last.id)!;
    expect(m.network.score).toBeGreaterThanOrEqual(MODEL_FLAG_THRESHOLD);
    expect(m.modelOnly).toBe(true);
    expect(m.network.factors[0].key).toBe("many_new_recipients");
  });
});

describe("agreement", () => {
  const r = (score: number, applicable = true) => ({ model: "behaviour" as const, applicable, score, factors: [] });
  it("HIGH / MIXED / LOW and model-only", () => {
    expect(agreementOf(80, { behaviour: r(70), beneficiary: r(0, false), network: r(0) })).toEqual({ agreement: "HIGH", modelOnly: false });
    expect(agreementOf(80, { behaviour: r(10), beneficiary: r(0, false), network: r(0) })).toEqual({ agreement: "MIXED", modelOnly: false });
    expect(agreementOf(20, { behaviour: r(65), beneficiary: r(0, false), network: r(0) })).toEqual({ agreement: "MIXED", modelOnly: true });
    expect(agreementOf(20, { behaviour: r(10), beneficiary: r(99, false), network: r(0) })).toEqual({ agreement: "LOW", modelOnly: false });
  });
});

describe("on the full dataset", () => {
  const d = generateDataset();
  const { assessments, models } = assessAll(d.transactions);
  const truth = new Set(d.labels.map((l) => l.transactionId));

  it("models never change rules output (score, alert, reasons)", () => {
    expect(assessments).toEqual(assessTransactions(d.transactions));
    const withM = toApplyRows(assessments, models);
    const without = toApplyRows(assessments);
    withM.forEach((row, i) => {
      for (const k of ["score", "severity", "alert", "reason_codes", "evidence", "ruleset_version"] as const) expect(row[k]).toEqual(without[i][k]);
    });
  });

  it("is deterministic and point-in-time", () => {
    const rs = new Map(assessments.map((a) => [a.transactionId, a.score]));
    const cutoff = d.anchor - 3 * DAY;
    const early = scoreModels(d.transactions.filter((t) => t.occurredAt <= cutoff), rs);
    for (const [id, m] of early) {
      const full = models.get(id)!;
      expect([m.behaviour, m.beneficiary, m.network]).toEqual([full.behaviour, full.beneficiary, full.network]);
    }
  });

  it("beneficiary and network models are precise; behaviour lifts fraud well above base rate", () => {
    const rows = assessments.map((a) => {
      const m = models.get(a.transactionId)!;
      return { transaction_id: a.transactionId, score: a.score, behaviour_score: m.behaviour.score, beneficiary_score: m.beneficiary.applicable ? m.beneficiary.score : null, network_score: m.network.score };
    });
    const s = Object.fromEntries(detectorStats(rows, truth).map((x) => [x.detector, x]));
    expect(s["Beneficiary model"].precision).toBeGreaterThanOrEqual(0.9);
    expect(s["Network model"].precision).toBeGreaterThanOrEqual(0.9);
    expect(s["Behaviour model"].precision!).toBeGreaterThan(10 * (truth.size / d.transactions.length));
  });

  it("factor explanations never contain identifiers", () => {
    for (const m of models.values()) {
      for (const f of [...m.behaviour.factors, ...m.beneficiary.factors, ...m.network.factors]) {
        expect(f.text).not.toMatch(/@|dev-|SEED-|[0-9a-f]{8}-[0-9a-f]{4}/i);
      }
    }
  });

  it("scores 5,000 transactions with all models quickly", () => {
    const t = performance.now();
    assessAll(d.transactions);
    expect(performance.now() - t).toBeLessThan(3000);
  });
});
