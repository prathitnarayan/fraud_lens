import { describe, expect, it } from "vitest";
import { distanceKm } from "@/lib/geo";
import { assessTransactions } from "@/lib/risk/engine";
import { ALERT_THRESHOLD, SIGNAL_CAP, severityFor } from "@/lib/risk/rules";
import type { ReasonCode, TxnInput } from "@/lib/risk/types";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 8, 20, 6, 30); // 12:00 IST

let seq = 0;
function tx(p: Partial<TxnInput> = {}): TxnInput {
  seq++;
  return {
    id: `t${String(seq).padStart(5, "0")}`,
    customerId: "c1",
    amount: 1000,
    channel: "UPI",
    direction: "debit",
    counterparty: "merchant:shop",
    merchantCategory: "grocery",
    city: "Pune",
    deviceId: "d1",
    occurredAt: T0,
    ...p,
  };
}

/** k ordinary daily debits before T0 (median 1000, device d1, Pune). */
function history(k = 10, p: Partial<TxnInput> = {}): TxnInput[] {
  return Array.from({ length: k }, (_, i) => tx({ occurredAt: T0 - (k - i) * DAY, ...p }));
}

function codesOf(txns: TxnInput[], id: string): ReasonCode[] {
  return assessTransactions(txns).find((a) => a.transactionId === id)!.reasonCodes;
}
const has = (txns: TxnInput[], id: string, code: ReasonCode) => codesOf(txns, id).includes(code);

describe("VELOCITY_BURST boundaries", () => {
  const burst = (n: number, gapSec: number) =>
    Array.from({ length: n }, (_, i) => tx({ occurredAt: T0 + i * gapSec * 1000, counterparty: `merchant:g${i}` }));

  it("5 debits in 4 min → no; 6 → yes", () => {
    const five = [...history(), ...burst(5, 48)];
    expect(has(five, five.at(-1)!.id, "VELOCITY_BURST")).toBe(false);
    const six = [...history(), ...burst(6, 48)];
    expect(has(six, six.at(-1)!.id, "VELOCITY_BURST")).toBe(true);
  });

  it("window is inclusive at exactly 5:00 and exclusive beyond", () => {
    const exact = [...history(), ...burst(6, 60)]; // span 300s
    expect(has(exact, exact.at(-1)!.id, "VELOCITY_BURST")).toBe(true);
    const over = [...history(), ...burst(6, 61)]; // span 305s
    expect(has(over, over.at(-1)!.id, "VELOCITY_BURST")).toBe(false);
  });

  it("credits don't count toward velocity", () => {
    const txns = [...history(), ...burst(5, 20), tx({ occurredAt: T0 + 110_000, direction: "credit" })];
    expect(assessTransactions(txns).some((a) => a.reasonCodes.includes("VELOCITY_BURST"))).toBe(false);
  });
});

describe("NEW_DEVICE_HIGH_VALUE boundaries", () => {
  const big = (p: Partial<TxnInput> = {}) =>
    tx({ amount: 50_000, deviceId: "d-new", counterparty: "acct@x", merchantCategory: null, ...p });

  it("needs ≥ 5 prior transactions", () => {
    const four = [...history(4), big()];
    expect(has(four, four.at(-1)!.id, "NEW_DEVICE_HIGH_VALUE")).toBe(false);
    const five = [...history(5), big()];
    expect(has(five, five.at(-1)!.id, "NEW_DEVICE_HIGH_VALUE")).toBe(true);
  });

  it("amount floor ₹50,000 is inclusive", () => {
    const below = [...history(10, { amount: 5000 }), big({ amount: 49_999.99 })];
    expect(has(below, below.at(-1)!.id, "NEW_DEVICE_HIGH_VALUE")).toBe(false);
    const at = [...history(10, { amount: 5000 }), big({ amount: 50_000 })];
    expect(has(at, at.at(-1)!.id, "NEW_DEVICE_HIGH_VALUE")).toBe(true);
  });

  it("ratio 8× is inclusive; 7.99× is not", () => {
    const at = [...history(10, { amount: 6250 }), big()]; // 50000/6250 = 8
    expect(has(at, at.at(-1)!.id, "NEW_DEVICE_HIGH_VALUE")).toBe(true);
    const below = [...history(10, { amount: 6260 }), big()];
    expect(has(below, below.at(-1)!.id, "NEW_DEVICE_HIGH_VALUE")).toBe(false);
  });

  it("device first seen ≤ 24h ago still counts; older does not", () => {
    const seed = (age: number) => [
      ...history(10),
      tx({ deviceId: "d-new", occurredAt: T0 - age, amount: 500 }),
      big(),
    ];
    const recent = seed(DAY);
    expect(has(recent, recent.at(-1)!.id, "NEW_DEVICE_HIGH_VALUE")).toBe(true);
    const old = seed(DAY + MIN);
    expect(has(old, old.at(-1)!.id, "NEW_DEVICE_HIGH_VALUE")).toBe(false);
  });

  it("known device + big amount → only signals, no alert", () => {
    const txns = [...history(10), big({ deviceId: "d1", amount: 120_000 })];
    const a = assessTransactions(txns).at(-1)!;
    expect(a.reasonCodes).not.toContain("NEW_DEVICE_HIGH_VALUE");
    expect(a.alert).toBe(false);
  });
});

describe("IMPOSSIBLE_TRAVEL boundaries", () => {
  const km = distanceKm("Mumbai", "Delhi");
  const trip = (elapsedMs: number) => [
    ...history(10, { city: "Mumbai" }),
    tx({ city: "Mumbai", occurredAt: T0 }),
    tx({ city: "Delhi", occurredAt: T0 + elapsedMs, channel: "CARD" }),
  ];

  it("exactly 900 km/h is allowed; faster is flagged", () => {
    const at = trip(Math.ceil((km / 900) * HOUR) + 1000);
    expect(has(at, at.at(-1)!.id, "IMPOSSIBLE_TRAVEL")).toBe(false);
    const fast = trip(Math.floor((km / 950) * HOUR));
    expect(has(fast, fast.at(-1)!.id, "IMPOSSIBLE_TRAVEL")).toBe(true);
  });

  it("looks back 6h across intermediate same-city txns", () => {
    const txns = [
      ...history(10, { city: "Mumbai" }),
      tx({ city: "Mumbai", occurredAt: T0 }),
      tx({ city: "Delhi", occurredAt: T0 + 10 * MIN }),
      tx({ city: "Delhi", occurredAt: T0 + 20 * MIN, channel: "ATM" }),
    ];
    expect(has(txns, txns.at(-1)!.id, "IMPOSSIBLE_TRAVEL")).toBe(true);
    expect(has(txns, txns.at(-3)!.id, "IMPOSSIBLE_TRAVEL")).toBe(false);
  });

  it("unknown city is ignored, not crashed on", () => {
    const txns = [...history(10), tx({ city: "Atlantis", occurredAt: T0 + MIN })];
    expect(() => assessTransactions(txns)).not.toThrow();
  });
});

describe("MULE_RING boundaries", () => {
  const ring = (n: number, spreadMs: number, p: Partial<TxnInput> = {}) =>
    Array.from({ length: n }, (_, i) =>
      tx({ customerId: `v${i}`, counterparty: "mule@ybl", merchantCategory: null, occurredAt: T0 + (i * spreadMs) / Math.max(1, n - 1), ...p }),
    );

  it("4 customers → no; 5 → yes (and earlier members are expanded)", () => {
    expect(assessTransactions(ring(4, HOUR)).some((a) => a.reasonCodes.includes("MULE_RING"))).toBe(false);
    const five = assessTransactions(ring(5, HOUR));
    expect(five.every((a) => a.reasonCodes.includes("MULE_RING"))).toBe(true);
  });

  it("merchants are never a ring; > 6h spread is not a ring", () => {
    expect(assessTransactions(ring(10, HOUR, { counterparty: "merchant:swiggy", merchantCategory: "food" })).some((a) => a.alert)).toBe(false);
    expect(assessTransactions(ring(5, 6 * HOUR + MIN)).some((a) => a.reasonCodes.includes("MULE_RING"))).toBe(false);
  });
});

describe("MULE_PASS_THROUGH boundaries", () => {
  const scenario = (senders: number, gapMin: number) => {
    const base = history(10);
    const credits = Array.from({ length: senders }, (_, i) =>
      tx({ direction: "credit", counterparty: `s${i}@upi`, merchantCategory: null, amount: 20_000, occurredAt: T0 + i * 30 * MIN }),
    );
    const last = T0 + (senders - 1) * 30 * MIN;
    const outs = Array.from({ length: 4 }, (_, i) =>
      tx({ counterparty: `o${i}@upi`, merchantCategory: null, amount: 18_000, occurredAt: last + gapMin * MIN + i * 5 * MIN }),
    );
    return [...base, ...credits, ...outs];
  };
  const fired = (txns: TxnInput[]) => assessTransactions(txns).some((a) => a.reasonCodes.includes("MULE_PASS_THROUGH"));

  it("4 senders then 4 payouts → yes; 3 senders → no", () => {
    expect(fired(scenario(4, 30))).toBe(true);
    expect(fired(scenario(3, 30))).toBe(false);
  });

  it("4th payout exactly 180 min after last credit counts; 181 min does not", () => {
    // 4th payout is at gap + 15 min, so shift so the *4th* payout lands on the boundary.
    expect(fired(scenario(4, 165))).toBe(true);
    expect(fired(scenario(4, 166.1))).toBe(false);
  });

  it("flags both the inbound credits and the payouts", () => {
    const res = assessTransactions(scenario(4, 30)).filter((a) => a.reasonCodes.includes("MULE_PASS_THROUGH"));
    expect(res).toHaveLength(8);
  });
});

describe("STRUCTURING boundaries", () => {
  const band = (amounts: number[], gap = HOUR) =>
    [...history(10), ...amounts.map((amount, i) => tx({ amount, merchantCategory: null, counterparty: "a@x", occurredAt: T0 + i * gap }))];
  const fired = (txns: TxnInput[]) => assessTransactions(txns).some((a) => a.reasonCodes.includes("STRUCTURING"));

  it("3 near-threshold debits → no; 4 → yes", () => {
    expect(fired(band([46_000, 47_000, 48_000]))).toBe(false);
    expect(fired(band([46_000, 47_000, 48_000, 49_000]))).toBe(true);
  });

  it("band is [45,000, 50,000)", () => {
    expect(fired(band([44_999.99, 47_000, 48_000, 49_000]))).toBe(false);
    expect(fired(band([45_000, 47_000, 48_000, 49_000]))).toBe(true);
    expect(fired(band([50_000, 47_000, 48_000, 49_000]))).toBe(false);
  });

  it("24h window: 4 debits spread over > 24h → no", () => {
    expect(fired(band([46_000, 47_000, 48_000, 49_000], 8 * HOUR + MIN))).toBe(false);
  });
});

describe("scoring", () => {
  it("severity boundaries", () => {
    expect([49, 50, 69, 70, 84, 85].map(severityFor)).toEqual(["low", "medium", "medium", "high", "high", "critical"]);
  });

  it("signals alone are capped below the alert threshold", () => {
    // New device + new payee + amount spike + high value + odd hour + far from home.
    const txns = [
      ...history(10, { city: "Pune" }),
      tx({ deviceId: "zz", counterparty: "p@x", merchantCategory: null, amount: 40_000, city: "Kolkata",
           occurredAt: Date.UTC(2026, 8, 20, 21, 30) }), // 03:00 IST, known-device rule not met (amount < 50k)
    ];
    const a = assessTransactions(txns).at(-1)!;
    expect(a.hits.every((h) => h.pattern === null)).toBe(true);
    expect(a.hits.length).toBeGreaterThanOrEqual(4);
    expect(a.score).toBeLessThanOrEqual(SIGNAL_CAP);
    expect(a.alert).toBe(false);
    expect(a.score).toBeLessThan(ALERT_THRESHOLD);
  });

  it("score never exceeds 100", () => {
    const txns = [
      ...history(10, { city: "Mumbai" }),
      tx({ city: "Mumbai", occurredAt: T0 }),
      tx({ city: "Delhi", occurredAt: T0 + 5 * MIN, deviceId: "new", amount: 200_000, merchantCategory: null, counterparty: "x@y" }),
    ];
    expect(assessTransactions(txns).at(-1)!.score).toBe(100);
  });
});
