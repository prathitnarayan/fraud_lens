import { beforeAll, describe, expect, it } from "vitest";
import { FRAUD_PATTERNS, IMPOSSIBLE_SPEED_KMH, STRUCTURING_THRESHOLD, type FraudPattern } from "@/lib/fraud-patterns";
import { impliedSpeedKmh, isKnownCity } from "@/lib/geo";
import { DEFAULT_ANCHOR, generateDataset } from "../../scripts/seed/generator";
import { buildManifest } from "../../scripts/seed/manifest";
import { parseAnchor } from "../../scripts/seed/seed";
import type { Dataset, GenTxn, ScenarioRecord } from "../../scripts/seed/types";
import {
  byCustomer,
  fanInRingHits,
  geoHits,
  newDeviceHighValueHits,
  passThroughHits,
  structuringHits,
  velocityHits,
} from "./oracles";

let d: Dataset;
let txById: Map<string, GenTxn>;
let labelled: Set<string>;
let perCustomer: Map<string, GenTxn[]>;

const MIN = 60_000;
const scenarios = (p: FraudPattern, kind: "fraud" | "lookalike" = "fraud") =>
  d.scenarios.filter((s) => s.pattern === p && s.kind === kind);
const txnsOf = (s: ScenarioRecord) => s.transactionIds.map((id) => txById.get(id)!);
const labelledOf = (s: ScenarioRecord) =>
  new Set(d.labels.filter((l) => l.scenarioRef === s.ref).map((l) => l.transactionId));

function allHits(): Map<string, Set<string>> {
  const hits = {
    velocity: new Set<string>(),
    newDevice: new Set<string>(),
    geo: new Set<string>(),
    structuring: new Set<string>(),
    passThrough: new Set<string>(),
  };
  for (const list of perCustomer.values()) {
    velocityHits(list).forEach((x) => hits.velocity.add(x));
    newDeviceHighValueHits(list).forEach((x) => hits.newDevice.add(x));
    geoHits(list).forEach((x) => hits.geo.add(x));
    structuringHits(list).forEach((x) => hits.structuring.add(x));
    passThroughHits(list).forEach((x) => hits.passThrough.add(x));
  }
  return new Map([...Object.entries(hits), ["fanInRing", fanInRingHits(d)]]);
}

beforeAll(() => {
  d = generateDataset();
  txById = new Map(d.transactions.map((t) => [t.id, t]));
  labelled = new Set(d.labels.map((l) => l.transactionId));
  perCustomer = byCustomer(d);
});

describe("shape & integrity", () => {
  it("has exactly 200 customers and 5000 transactions with unique ids", () => {
    expect(d.customers).toHaveLength(200);
    expect(d.transactions).toHaveLength(5000);
    expect(new Set(d.transactions.map((t) => t.id)).size).toBe(5000);
    expect(new Set(d.customers.map((c) => c.id)).size).toBe(200);
  });

  it("every transaction references a customer; every label references a transaction once", () => {
    const ids = new Set(d.customers.map((c) => c.id));
    expect(d.transactions.every((t) => ids.has(t.customerId))).toBe(true);
    expect(d.labels.every((l) => txById.has(l.transactionId))).toBe(true);
    expect(labelled.size).toBe(d.labels.length);
  });

  it("values satisfy DB constraints", () => {
    for (const c of d.customers) {
      expect(c.externalRef).toMatch(/^SEED-\d{5}$/);
      expect(c.accountMasked).toMatch(/^X{4,}[0-9]{4}$/);
    }
    for (const t of d.transactions) {
      expect(t.amount).toBeGreaterThan(0);
      expect(Math.abs(t.amount * 100 - Math.round(t.amount * 100))).toBeLessThan(1e-6);
      expect(isKnownCity(t.city)).toBe(true);
      expect(["debit", "credit"]).toContain(t.direction);
    }
  });

  it("all timestamps fall within 31 days before the anchor", () => {
    for (const t of d.transactions) {
      expect(t.occurredAt).toBeLessThanOrEqual(d.anchor);
      expect(d.anchor - t.occurredAt).toBeLessThan(31 * 24 * 60 * MIN);
    }
  });

  it("fraud rate is realistic-but-demoable (1–4%) and all 6 patterns are labelled", () => {
    const m = buildManifest(d);
    expect(m.fraudRatePct).toBeGreaterThanOrEqual(1);
    expect(m.fraudRatePct).toBeLessThanOrEqual(4);
    for (const p of FRAUD_PATTERNS) {
      expect(m.patterns[p].labelled, p).toBeGreaterThan(0);
      expect(m.patterns[p].lookalikes, p).toBeGreaterThan(0);
    }
  });

  it("look-alikes are never labelled", () => {
    for (const s of d.scenarios.filter((x) => x.kind === "lookalike")) {
      expect(s.transactionIds.some((id) => labelled.has(id)), s.ref).toBe(false);
    }
  });
});

describe("determinism", () => {
  it("same seed → identical dataset", () => {
    expect(generateDataset()).toEqual(d);
  });

  it("different seed → different data", () => {
    const other = generateDataset({ seed: 7 });
    expect(other.transactions[0].id).not.toBe(d.transactions[0].id);
    expect(other.transactions).toHaveLength(5000);
  });

  it("works for many seeds and a live anchor without throwing", () => {
    for (const seed of [1, 2, 3, 42, 99991]) {
      expect(generateDataset({ seed }).transactions).toHaveLength(5000);
    }
    // Early-morning and 1st-of-month anchors are the edge cases for time placement.
    for (const iso of ["2026-10-01T00:05:00Z", "2026-03-31T20:00:00Z", "2026-12-01T01:00:00Z"]) {
      const g = generateDataset({ anchor: Date.parse(iso) });
      expect(g.transactions.every((t) => t.occurredAt <= g.anchor)).toBe(true);
    }
  });

  it("parseAnchor handles default, now and ISO; rejects junk", () => {
    expect(parseAnchor(undefined)).toBe(DEFAULT_ANCHOR);
    expect(Math.abs(parseAnchor("now") - Date.now())).toBeLessThan(5000);
    expect(parseAnchor("2026-09-01T00:00:00Z")).toBe(Date.UTC(2026, 8, 1));
    expect(() => parseAnchor("yesterday")).toThrow();
  });
});

describe("planted scenarios satisfy their pattern", () => {
  it("VELOCITY_BURST: ≥ 6 debits inside 5 minutes, all labelled", () => {
    for (const s of scenarios("VELOCITY_BURST")) {
      const txns = txnsOf(s);
      expect(txns.length).toBeGreaterThanOrEqual(6);
      const span = Math.max(...txns.map((t) => t.occurredAt)) - Math.min(...txns.map((t) => t.occurredAt));
      expect(span).toBeLessThanOrEqual(5 * MIN);
      expect(labelledOf(s).size).toBe(txns.length);
    }
  });

  it("NEW_DEVICE_HIGH_VALUE: unseen device, ≥ ₹50k, far above the customer's history", () => {
    for (const s of scenarios("NEW_DEVICE_HIGH_VALUE")) {
      const [first] = txnsOf(s).sort((a, b) => a.occurredAt - b.occurredAt);
      const prior = perCustomer.get(first.customerId)!.filter((t) => t.occurredAt < first.occurredAt);
      expect(prior.length).toBeGreaterThanOrEqual(5);
      expect(prior.some((t) => t.deviceId === first.deviceId)).toBe(false);
      expect(first.amount).toBeGreaterThanOrEqual(50_000);
      expect(newDeviceHighValueHits(perCustomer.get(first.customerId)!).has(first.id)).toBe(true);
    }
  });

  it("GEO_MISMATCH: remote txn follows a home txn at impossible speed; home txn itself not labelled", () => {
    for (const s of scenarios("GEO_MISMATCH")) {
      const [home, remote] = txnsOf(s);
      const speed = impliedSpeedKmh(home.city, remote.city, remote.occurredAt - home.occurredAt);
      expect(speed).toBeGreaterThan(IMPOSSIBLE_SPEED_KMH);
      expect(remote.occurredAt - home.occurredAt).toBeGreaterThanOrEqual(MIN);
      expect(labelledOf(s).has(home.id)).toBe(false);
      expect(labelledOf(s).has(remote.id)).toBe(true);
    }
  });

  it("GEO look-alike travellers move at a plausible speed", () => {
    for (const s of scenarios("GEO_MISMATCH", "lookalike")) {
      const [a, b] = txnsOf(s);
      expect(impliedSpeedKmh(a.city, b.city, b.occurredAt - a.occurredAt)).toBeLessThan(IMPOSSIBLE_SPEED_KMH);
    }
  });

  it("MULE_FAN_IN rings: ≥ 5 distinct customers → one counterparty within 6h", () => {
    const rings = scenarios("MULE_FAN_IN").filter((s) => s.ref.includes("RING"));
    expect(rings.length).toBe(2);
    const hits = fanInRingHits(d);
    for (const s of rings) {
      const txns = txnsOf(s);
      expect(new Set(txns.map((t) => t.counterparty)).size).toBe(1);
      expect(new Set(txns.map((t) => t.customerId)).size).toBeGreaterThanOrEqual(5);
      expect(txns.every((t) => hits.has(t.id))).toBe(true);
    }
  });

  it("MULE_FAN_OUT: mule gets ≥ 4 distinct credits then disperses to ≥ 4 payees within 2h", () => {
    for (const s of scenarios("MULE_FAN_OUT")) {
      const outs = txnsOf(s);
      expect(new Set(outs.map((t) => t.counterparty)).size).toBeGreaterThanOrEqual(4);
      const hits = passThroughHits(perCustomer.get(outs[0].customerId)!);
      expect(outs.every((t) => hits.has(t.id))).toBe(true);
    }
  });

  it("STRUCTURING: each < ₹50k, ≥ 4 within 24h, collectively above the threshold", () => {
    for (const s of scenarios("STRUCTURING")) {
      const txns = txnsOf(s);
      expect(txns.length).toBeGreaterThanOrEqual(4);
      expect(txns.every((t) => t.amount < STRUCTURING_THRESHOLD && t.amount >= 45_000)).toBe(true);
      const span = Math.max(...txns.map((t) => t.occurredAt)) - Math.min(...txns.map((t) => t.occurredAt));
      expect(span).toBeLessThanOrEqual(24 * 60 * MIN);
      expect(txns.reduce((a, t) => a + t.amount, 0)).toBeGreaterThan(3 * STRUCTURING_THRESHOLD);
      expect(new Set(txns.map((t) => Math.round(t.amount))).size).toBeGreaterThan(1);
    }
  });
});

describe("ground truth is clean", () => {
  it("no unlabelled transaction matches any fraud pattern (normal data + look-alikes stay innocent)", () => {
    for (const [name, hits] of allHits()) {
      const accidental = [...hits].filter((id) => !labelled.has(id));
      expect(accidental, `${name} matched unlabelled txns`).toEqual([]);
    }
  });

  it("the same holds for other seeds", () => {
    for (const seed of [11, 12345]) {
      d = generateDataset({ seed });
      txById = new Map(d.transactions.map((t) => [t.id, t]));
      labelled = new Set(d.labels.map((l) => l.transactionId));
      perCustomer = byCustomer(d);
      for (const [name, hits] of allHits()) {
        expect([...hits].filter((id) => !labelled.has(id)), `seed ${seed}: ${name}`).toEqual([]);
      }
    }
  });
});
