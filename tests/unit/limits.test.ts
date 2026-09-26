import { describe, expect, it } from "vitest";
import { checkLimits, LIMITS } from "@/lib/limits";
import { decide, precheck } from "@/lib/precheck";
import type { TxnInput } from "@/lib/risk/types";

const HOUR = 3_600_000;
const T = Date.UTC(2026, 8, 26, 6, 30);
let n = 0;
const tx = (p: Partial<TxnInput> = {}): TxnInput => ({ id: `l${++n}`, customerId: "c", amount: 500, channel: "UPI", direction: "debit",
  counterparty: "merchant:shop", merchantCategory: "grocery", city: "Pune", deviceId: "d1", occurredAt: T - 10 * 24 * HOUR, ...p });
const old = Array.from({ length: 10 }, (_, i) => tx({ occurredAt: T - (30 - i) * 24 * HOUR })); // established user on d1
const pay = (p: Partial<TxnInput>): TxnInput => ({ id: "p", customerId: "c", counterparty: "x@y", city: "Pune", amount: 1_000, channel: "UPI", direction: "debit", merchantCategory: null, deviceId: "d1", occurredAt: T, ...p });
const codes = (p: Partial<TxnInput>, h = old) => checkLimits(pay(p), h).map((v) => v.code);

describe("NPCI UPI limits", () => {
  it("P2P per transaction: ₹1,00,000 allowed, ₹1,00,001 declined", () => {
    expect(codes({ amount: 100_000 })).toEqual([]);
    expect(codes({ amount: 100_001 })).toContain("UPIP2PPERTXN");
  });
  it("P2P rolling 24h aggregate", () => {
    const h = [...old, tx({ merchantCategory: null, amount: 80_000, occurredAt: T - 2 * HOUR })];
    expect(codes({ amount: 20_000 }, h)).toEqual([]);
    expect(codes({ amount: 20_001 }, h)).toContain("UPIP2PROLLING24H");
    const outside = [...old, tx({ merchantCategory: null, amount: 80_000, occurredAt: T - 25 * HOUR })];
    expect(codes({ amount: 90_000 }, outside)).toEqual([]);
  });
  it("merchant categories use their NPCI caps", () => {
    expect(codes({ amount: 400_000, merchantCategory: "insurance" })).toEqual([]);
    expect(codes({ amount: 250_000, merchantCategory: "jewellery" })).toContain("UPI_P2M_PER_TXN");
    expect(codes({ amount: 150_000, merchantCategory: "grocery" })).toContain("UPI_P2M_PER_TXN");
  });
  it("new registration / new device: ₹5,000 in the first 24h", () => {
    expect(codes({ amount: 5_000, deviceId: "new-phone" })).toEqual([]);
    expect(codes({ amount: 5_001, deviceId: "new-phone" })).toContain("UPINEWUSER24H");
    const used = [...old, tx({ deviceId: "new-phone", merchantCategory: null, amount: 4_000, occurredAt: T - HOUR })];
    expect(codes({ amount: 1_500, deviceId: "new-phone" }, used)).toContain("UPINEWUSER24H");
    expect(codes({ amount: 1_500, deviceId: "new-phone" }, [])).toEqual([]); // brand-new customer, small amount
  });
  it("credits are never limited", () => {
    expect(checkLimits(pay({ amount: 9_999_999, direction: "credit" }), old)).toEqual([]);
  });
});

describe("bank-configurable limits", () => {
  it("IMPS per transaction and ATM daily", () => {
    expect(codes({ channel: "IMPS", amount: LIMITS.impsPerTxn.value })).toEqual([]);
    expect(codes({ channel: "IMPS", amount: LIMITS.impsPerTxn.value + 1 })).toContain("IMPSPERTXN");
    const atm = [...old, tx({ channel: "ATM", merchantCategory: "cash", amount: 40_000, occurredAt: T - HOUR })];
    expect(codes({ channel: "ATM", merchantCategory: "cash", amount: 10_000 }, atm)).toEqual([]);
    expect(codes({ channel: "ATM", merchantCategory: "cash", amount: 10_001 }, atm)).toContain("ATMPERDAY");
  });
  it("labels every limit with who sets it", () => {
    expect(Object.values(LIMITS).every((l) => l.source === "NPCI" || l.source === "BANK")).toBe(true);
  });
});

describe("precheck integration", () => {
  it("a limit breach → DECLINE with the limit in the customer message, fraud scores still returned", () => {
    const r = precheck({ customerRef: "SEED-00001", customerId: "c", amount: 150_000, channel: "UPI", direction: "debit",
      counterparty: "friend@okaxis", merchantCategory: null, city: "Pune", deviceId: "d1", occurredAt: T }, old, []);
    expect(r.decision).toBe("DECLINE");
    expect(r.customerMessage).toMatch(/₹1,00,000/);
    expect(r.limitViolations[0].source).toBe("NPCI");
    expect(typeof r.ruleScore).toBe("number");
  });
  it("within limits → fraud policy decides as before", () => {
    const r = precheck({ customerRef: "SEED-00001", customerId: "c", amount: 400, channel: "UPI", direction: "debit",
      counterparty: "merchant:shop", merchantCategory: "grocery", city: "Pune", deviceId: "d1", occurredAt: T }, old, []);
    expect(r.limitViolations).toEqual([]);
    expect(r.decision).not.toBe("DECLINE");
    expect(decide(0, [], { version: "v", agreement: "LOW", modelOnly: false,
      behaviour: { model: "behaviour", applicable: true, score: 0, factors: [] },
      beneficiary: { model: "beneficiary", applicable: false, score: 0, factors: [] },
      network: { model: "network", applicable: true, score: 0, factors: [] } }).decision).toBe("ALLOW");
  });
});
