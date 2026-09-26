import { describe, expect, it } from "vitest";
import { apiKeyMatches } from "@/lib/api-key";
import { combine, type ModelScores } from "@/lib/models";
import { decide, precheck, ProposedPayment } from "@/lib/precheck";
import { assessAll } from "@/lib/risk/runner";
import type { TxnInput } from "@/lib/risk/types";
import { generateDataset } from "../../scripts/seed/generator";

const d = generateDataset();
const MIN = 60_000;
const HOUR = 60 * MIN;
const history = (customerId: string, before: number) => d.transactions.filter((t) => t.customerId === customerId && t.occurredAt < before);
const payTo = (cp: string, before: number) => d.transactions.filter((t) => t.counterparty === cp && t.direction === "debit" && t.merchantCategory === null && t.occurredAt < before);

// A quiet retail customer with plenty of history and no planted scenario.
const labelledCustomers = new Set(d.scenarios.flatMap((s) => s.customerIds));
const quiet = d.customers.find((c) => c.segment === "retail" && !labelledCustomers.has(c.id) && history(c.id, d.anchor).length >= 15)!;
const quietHistory = history(quiet.id, d.anchor);
const usual = quietHistory.at(-1)!;
const base = { customerRef: quiet.externalRef, customerId: quiet.id, city: quiet.homeCity, deviceId: usual.deviceId, occurredAt: d.anchor };

describe("pre-transaction check", () => {
  it("normal grocery payment → ALLOW with no customer message", () => {
    const r = precheck({ ...base, amount: 600, channel: "UPI", direction: "debit", counterparty: "merchant:bigbasket", merchantCategory: "grocery" }, quietHistory, []);
    expect(r.decision).toBe("ALLOW");
    expect(r.customerMessage).toBeNull();
  });

  it("SIM-swap pattern (new phone, ₹2L to a new person) → HOLD with a SIM warning", () => {
    const r = precheck({ ...base, amount: 200_000, channel: "IMPS", direction: "debit", counterparty: "new.person@ibl", merchantCategory: null, deviceId: "dev-unknown" }, quietHistory, []);
    expect(r.decision).toBe("HOLD");
    expect(r.reasonCodes).toContain("NEW_DEVICE_HIGH_VALUE");
    expect(r.customerMessage).toMatch(/new device/i);
  });

  it("paying a beneficiary that many customers paid today → friction with a scam warning", () => {
    const ring = d.scenarios.find((s) => s.ref === "MULE_FAN_IN-RING-1")!;
    const cp = String(ring.params.counterparty);
    const last = Math.max(...ring.transactionIds.map((id) => d.transactions.find((t) => t.id === id)!.occurredAt));
    const at = last + 10 * MIN;
    const r = precheck({ ...base, occurredAt: at, amount: 9_999, channel: "UPI", direction: "debit", counterparty: cp, merchantCategory: null }, history(quiet.id, at), payTo(cp, at));
    expect(["STEP_UP", "HOLD"]).toContain(r.decision);
    expect(r.models.beneficiary.score).toBeGreaterThanOrEqual(60);
    expect(r.customerMessage).toMatch(/several people/);
  });

  it("models alone add friction but never HOLD (one victim → many new accounts)", () => {
    const t0 = d.anchor - 3 * HOUR;
    const burst: TxnInput[] = Array.from({ length: 9 }, (_, i) => ({
      // IMPS: the same burst over UPI would breach NPCI's ₹1L rolling cap and be DECLINED (see limits.test.ts).
      id: `b${i}`, customerId: quiet.id, amount: 18_000, channel: "IMPS", direction: "debit", counterparty: `acct${i}@ibl`,
      merchantCategory: null, city: quiet.homeCity, deviceId: usual.deviceId, occurredAt: t0 + i * 15 * MIN,
    }));
    const r = precheck({ ...base, amount: 18_000, channel: "IMPS", direction: "debit", counterparty: "acct9@ibl", merchantCategory: null }, [...quietHistory, ...burst], []);
    expect(r.limitViolations).toEqual([]);
    expect(r.ruleScore).toBeLessThan(50);
    expect(r.models.network.score).toBeGreaterThanOrEqual(60);
    expect(r.decision).toBe("STEP_UP");
  });

  it("ignores any history at or after the proposed time and doesn't mutate inputs", () => {
    const future = { ...usual, id: "future", occurredAt: d.anchor + HOUR, amount: 999_999 };
    const input = [...quietHistory, future];
    const snapshot = JSON.stringify(input);
    const a = precheck({ ...base, amount: 600, channel: "UPI", direction: "debit", counterparty: "merchant:bigbasket", merchantCategory: "grocery" }, input, []);
    const b = precheck({ ...base, amount: 600, channel: "UPI", direction: "debit", counterparty: "merchant:bigbasket", merchantCategory: "grocery" }, quietHistory, []);
    expect({ ...a, latencyMs: 0 }).toEqual({ ...b, latencyMs: 0 });
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("is fast enough for the payment path", () => {
    const r = precheck({ ...base, amount: 600, channel: "UPI", direction: "debit", counterparty: "merchant:bigbasket", merchantCategory: "grocery" }, quietHistory, []);
    expect(r.latencyMs).toBeLessThan(200);
  });

  it("agrees with the batch engine on the same data (one engine, two modes)", () => {
    const planted = d.scenarios.find((s) => s.ref === "NEW_DEVICE_HIGH_VALUE-1")!;
    const t = d.transactions.find((x) => x.id === planted.transactionIds[0])!;
    const c = d.customers.find((x) => x.id === t.customerId)!;
    const r = precheck({ customerRef: c.externalRef, customerId: c.id, amount: t.amount, channel: t.channel, direction: "debit", counterparty: t.counterparty,
      merchantCategory: t.merchantCategory, city: t.city, deviceId: t.deviceId, occurredAt: t.occurredAt }, history(c.id, t.occurredAt), payTo(t.counterparty, t.occurredAt));
    const batch = assessAll(d.transactions).assessments.find((a) => a.transactionId === t.id)!;
    expect(r.ruleScore).toBe(batch.score);
    expect(r.decision).toBe("HOLD");
  });
});

it("the same burst over UPI hits the NPCI rolling cap → DECLINE before scoring", () => {
  const t0 = d.anchor - 3 * HOUR;
  const burst: TxnInput[] = Array.from({ length: 9 }, (_, i) => ({
    id: `u${i}`, customerId: quiet.id, amount: 18_000, channel: "UPI", direction: "debit", counterparty: `acct${i}@ibl`,
    merchantCategory: null, city: quiet.homeCity, deviceId: usual.deviceId, occurredAt: t0 + i * 15 * MIN,
  }));
  const r = precheck({ ...base, amount: 18_000, channel: "UPI", direction: "debit", counterparty: "acct9@ibl", merchantCategory: null }, [...quietHistory, ...burst], []);
  expect(r.decision).toBe("DECLINE");
  expect(r.limitViolations.map((v) => v.code)).toContain("UPIP2PROLLING24H");
});

describe("decision policy", () => {
  const m = (b: number, be: number | null, n: number, agreement: ModelScores["agreement"] = "LOW"): ModelScores => ({
    version: "v", agreement, modelOnly: false,
    behaviour: combine("behaviour", [{ key: "x", weight: b / 100, strength: 1, text: "" }]),
    beneficiary: be === null ? combine("beneficiary", [], false) : combine("beneficiary", [{ key: "x", weight: be / 100, strength: 1, text: "" }]),
    network: combine("network", [{ key: "x", weight: n / 100, strength: 1, text: "" }]),
  });
  it.each([
    [70, m(0, null, 0), "HOLD"],
    [55, m(0, null, 0, "HIGH"), "HOLD"],
    [55, m(0, null, 0, "MIXED"), "STEP_UP"],
    [10, m(65, null, 0), "STEP_UP"],
    [10, m(0, 45, 0), "WARN"],
    [10, m(0, 20, 0), "ALLOW"],
    [0, m(99, 99, 99), "STEP_UP"], // models never hold
  ] as const)("rules %i → %s", (score, models, expected) => {
    expect(decide(score, [], models).decision).toBe(expected);
  });
});

describe("request validation and API auth", () => {
  it("rejects bad payloads", () => {
    const ok = { customerRef: "SEED-00001", amount: 100, channel: "UPI", counterparty: "a@b", city: "Pune", deviceId: "d1" };
    expect(ProposedPayment.safeParse(ok).success).toBe(true);
    for (const bad of [{ amount: -1 }, { amount: 0 }, { city: "Atlantis" }, { channel: "CRYPTO" }, { customerRef: "x; drop table" }, { amount: 1e9 }]) {
      expect(ProposedPayment.safeParse({ ...ok, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("API key: constant-time match, requires Bearer and a strong configured key", () => {
    const key = "k".repeat(32);
    expect(apiKeyMatches(`Bearer ${key}`, key)).toBe(true);
    expect(apiKeyMatches(`Bearer ${key}x`, key)).toBe(false);
    expect(apiKeyMatches(key, key)).toBe(false);
    expect(apiKeyMatches(null, key)).toBe(false);
    expect(apiKeyMatches("Bearer short", "short")).toBe(false); // weak/unset server key disables key auth
    expect(apiKeyMatches(`Bearer ${key}`, undefined)).toBe(false);
  });
});
