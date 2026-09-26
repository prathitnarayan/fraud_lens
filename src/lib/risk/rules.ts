import { IMPOSSIBLE_SPEED_KMH, STRUCTURING_THRESHOLD } from "@/lib/fraud-patterns";
import { MIN_HISTORY, type Windows } from "./features";
import type { Features, RuleHit, Severity, TxnInput } from "./types";

/** Bump whenever a threshold, weight or rule changes — persisted with every assessment. */
export const RULESET_VERSION = "2026.09.26-r1";

export const THRESHOLDS = {
  velocityDebits5m: 6,
  amountSpikeRatio: 8,
  highValue: 100_000,
  newDeviceHighValue: 50_000,
  recentDeviceMinutes: 24 * 60,
  impossibleSpeedKmh: IMPOSSIBLE_SPEED_KMH,
  farFromHomeKm: 500,
  ringCustomers6h: 5,
  passThroughSenders24h: 4,
  passThroughPayees2h: 4,
  passThroughMaxGapMin: 180,
  structuringCount24h: 4,
  oddHourStart: 1,
  oddHourEnd: 5, // exclusive
} as const;

export const ALERT_THRESHOLD = 50;
/** Signals alone may raise severity but never create an alert: a pattern rule must fire. */
export const SIGNAL_CAP = ALERT_THRESHOLD - 5;

export function severityFor(score: number): Severity {
  if (score >= 85) return "critical";
  if (score >= 70) return "high";
  if (score >= ALERT_THRESHOLD) return "medium";
  return "low";
}

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
type Rule = (t: TxnInput, f: Features, w: Windows) => RuleHit | null;

/** Pattern rules — each maps to one fraud behaviour. */
export const PATTERN_RULES: Rule[] = [
  (t, f, w) =>
    t.direction === "debit" && f.debitsLast5m >= THRESHOLDS.velocityDebits5m
      ? { code: "VELOCITY_BURST", pattern: "VELOCITY_BURST", weight: 65, members: w.velocity,
          evidence: `${f.debitsLast5m} debits within ${Math.round(f.velocityWindowSec)}s (threshold ${THRESHOLDS.velocityDebits5m} in 5 min)` }
      : null,

  (t, f) =>
    t.direction === "debit" &&
    f.priorCount >= MIN_HISTORY &&
    (f.deviceAgeMinutes === null || f.deviceAgeMinutes <= THRESHOLDS.recentDeviceMinutes) &&
    t.amount >= THRESHOLDS.newDeviceHighValue &&
    f.amountRatio !== null &&
    f.amountRatio >= THRESHOLDS.amountSpikeRatio
      ? { code: "NEW_DEVICE_HIGH_VALUE", pattern: "NEW_DEVICE_HIGH_VALUE", weight: 70,
          evidence: `${inr(t.amount)} (${f.amountRatio.toFixed(1)}× usual ${inr(f.priorDebitMedian ?? 0)}) from a device ${
            f.deviceAgeMinutes === null ? "never seen before" : `first seen ${Math.round(f.deviceAgeMinutes)} min ago`}` }
      : null,

  (t, f) =>
    f.maxSpeedKmh6h !== null && f.maxSpeedKmh6h > THRESHOLDS.impossibleSpeedKmh && f.speedWitness
      ? { code: "IMPOSSIBLE_TRAVEL", pattern: "GEO_MISMATCH", weight: 70,
          evidence: `${t.city} is ${f.speedWitness.km} km from ${f.speedWitness.city} (txn ${f.speedWitness.minutesAgo} min earlier) → ${
            Number.isFinite(f.maxSpeedKmh6h) ? `${Math.round(f.maxSpeedKmh6h)} km/h` : "no time elapsed"}` }
      : null,

  (t, f, w) =>
    f.ringCustomers6h >= THRESHOLDS.ringCustomers6h
      ? { code: "MULE_RING", pattern: "MULE_FAN_IN", weight: 60, members: w.ring,
          evidence: `${f.ringCustomers6h} different customers paid ${t.counterparty} within 6h` }
      : null,

  (t, f, w) =>
    t.direction === "debit" &&
    f.isP2P &&
    f.creditSenders24h >= THRESHOLDS.passThroughSenders24h &&
    f.minutesSinceLastCredit !== null &&
    f.minutesSinceLastCredit <= THRESHOLDS.passThroughMaxGapMin &&
    f.distinctP2PPayees2h >= THRESHOLDS.passThroughPayees2h
      ? { code: "MULE_PASS_THROUGH", pattern: "MULE_FAN_OUT", weight: 65, members: [...w.credits, ...w.payees],
          evidence: `${f.creditSenders24h} inbound transfers from different senders, then ${f.distinctP2PPayees2h} payouts to different accounts within 2h (${Math.round(f.minutesSinceLastCredit)} min after last credit)` }
      : null,

  (t, f, w) =>
    f.nearThresholdDebits24h >= THRESHOLDS.structuringCount24h
      ? { code: "STRUCTURING", pattern: "STRUCTURING", weight: 60, members: w.band,
          evidence: `${f.nearThresholdDebits24h} debits just under ${inr(STRUCTURING_THRESHOLD)} in 24h totalling ${inr(f.nearThresholdSum24h)}` }
      : null,
];

/** Supporting signals — add context and severity. */
export const SIGNAL_RULES: Rule[] = [
  (t, f) =>
    f.priorCount >= MIN_HISTORY && !f.deviceSeenBefore
      ? { code: "NEW_DEVICE", pattern: null, weight: 10, evidence: `first transaction from device ${t.deviceId}` }
      : null,
  (t, f) =>
    f.isNewPayee ? { code: "NEW_PAYEE", pattern: null, weight: 5, evidence: `first payment to ${t.counterparty}` } : null,
  (t, f) =>
    t.direction === "debit" && f.amountRatio !== null && f.amountRatio >= THRESHOLDS.amountSpikeRatio && t.amount >= 10_000
      ? { code: "AMOUNT_SPIKE", pattern: null, weight: 20, evidence: `${f.amountRatio.toFixed(1)}× the customer's usual debit` }
      : null,
  (t) =>
    t.direction === "debit" && t.amount >= THRESHOLDS.highValue
      ? { code: "HIGH_VALUE", pattern: null, weight: 10, evidence: `${inr(t.amount)} ≥ ${inr(THRESHOLDS.highValue)}` }
      : null,
  (t, f) =>
    t.direction === "debit" && f.hourIst >= THRESHOLDS.oddHourStart && f.hourIst < THRESHOLDS.oddHourEnd
      ? { code: "ODD_HOUR", pattern: null, weight: 5, evidence: `at ${String(f.hourIst).padStart(2, "0")}:xx IST` }
      : null,
  (t, f) =>
    f.kmFromHome !== null && f.kmFromHome >= THRESHOLDS.farFromHomeKm
      ? { code: "FAR_FROM_HOME", pattern: null, weight: 10, evidence: `${Math.round(f.kmFromHome)} km from usual city ${f.homeCity}` }
      : null,
  (t) =>
    t.direction === "debit" && t.amount >= 45_000 && t.amount < STRUCTURING_THRESHOLD
      ? { code: "NEAR_THRESHOLD", pattern: null, weight: 10, evidence: `${inr(t.amount)} just under ${inr(STRUCTURING_THRESHOLD)}` }
      : null,
];

/** Deterministic score from a set of hits (one per code). */
export function scoreHits(hits: RuleHit[]): number {
  const patterns = hits.filter((h) => h.pattern !== null).reduce((s, h) => s + h.weight, 0);
  const signals = Math.min(SIGNAL_CAP, hits.filter((h) => h.pattern === null).reduce((s, h) => s + h.weight, 0));
  return Math.min(100, patterns + signals);
}
