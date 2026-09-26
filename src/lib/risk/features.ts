import { STRUCTURING_THRESHOLD } from "@/lib/fraud-patterns";
import { distanceKm, impliedSpeedKmh, isKnownCity } from "@/lib/geo";
import type { Features, TxnInput } from "./types";

/** Transaction ids inside each detection window — used for cluster evidence/expansion. */
export type Windows = { velocity: string[]; ring: string[]; credits: string[]; payees: string[]; band: string[] };

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const WINDOWS = {
  velocity: 5 * MIN,
  geo: 6 * HOUR,
  ring: 6 * HOUR,
  credits: 24 * HOUR,
  payees: 2 * HOUR,
  structuring: 24 * HOUR,
} as const;
export const NEAR_THRESHOLD_LOW = 45_000;
export const MIN_HISTORY = 5;

const IST_OFFSET = 5.5 * HOUR;

export const isNearThreshold = (t: TxnInput) =>
  t.direction === "debit" && t.amount >= NEAR_THRESHOLD_LOW && t.amount < STRUCTURING_THRESHOLD;

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mode(xs: string[]): string | null {
  const counts = new Map<string, number>();
  let best: string | null = null;
  let bestN = 0;
  for (const x of xs) {
    const n = (counts.get(x) ?? 0) + 1;
    counts.set(x, n);
    if (n > bestN || (n === bestN && best !== null && x < best)) {
      best = x;
      bestN = n;
    }
  }
  return best;
}

/** Deterministic total order used everywhere: time, then id. */
export const byTime = (a: TxnInput, b: TxnInput) => a.occurredAt - b.occurredAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Computes features for `t` given the customer's prior transactions (strictly before t, sorted)
 * and the P2P debits to t's counterparty by any customer (at or before t, sorted).
 */
export function buildFeatures(
  t: TxnInput,
  prior: TxnInput[],
  counterpartyDebits: TxnInput[],
): { features: Features; windows: Windows } {
  const isDebit = t.direction === "debit";
  const isP2P = t.merchantCategory === null;
  const priorDebits = prior.filter((p) => p.direction === "debit");
  const priorDebitMedian = priorDebits.length >= MIN_HISTORY ? median(priorDebits.map((p) => p.amount)) : null;
  const amountRatio = priorDebitMedian && priorDebitMedian > 0 ? t.amount / priorDebitMedian : null;

  // Velocity (debits inside the trailing 5 minutes, including this one)
  const velocityWindow = priorDebits.filter((p) => t.occurredAt - p.occurredAt <= WINDOWS.velocity);
  const debitsLast5m = velocityWindow.length + (isDebit ? 1 : 0);
  const velocityWindowSec = velocityWindow.length ? (t.occurredAt - velocityWindow[0].occurredAt) / 1000 : 0;

  // Device
  const firstSeen = prior.find((p) => p.deviceId === t.deviceId);
  const deviceAgeMinutes = firstSeen ? (t.occurredAt - firstSeen.occurredAt) / MIN : null;

  // Geo
  const homeCity = mode(prior.map((p) => p.city));
  const kmFromHome = homeCity && isKnownCity(homeCity) && isKnownCity(t.city) ? distanceKm(homeCity, t.city) : null;
  let maxSpeedKmh6h: number | null = null;
  let speedWitness: Features["speedWitness"] = null;
  if (isKnownCity(t.city)) {
    for (const p of prior) {
      const dt = t.occurredAt - p.occurredAt;
      if (dt > WINDOWS.geo || p.city === t.city || !isKnownCity(p.city)) continue;
      const speed = impliedSpeedKmh(p.city, t.city, dt);
      if (maxSpeedKmh6h === null || speed > maxSpeedKmh6h) {
        maxSpeedKmh6h = speed;
        speedWitness = { city: p.city, minutesAgo: Math.round(dt / MIN), km: Math.round(distanceKm(p.city, t.city)) };
      }
    }
  }

  // Counterparty
  const isNewPayee = isDebit && prior.length >= MIN_HISTORY && !priorDebits.some((p) => p.counterparty === t.counterparty);
  const ringWindow = isDebit && isP2P ? counterpartyDebits.filter((c) => t.occurredAt - c.occurredAt <= WINDOWS.ring) : [];
  const ringCustomers6h = new Set(ringWindow.map((c) => c.customerId)).size;
  const recentP2PCredits = prior.filter(
    (p) => p.direction === "credit" && p.merchantCategory === null && t.occurredAt - p.occurredAt <= WINDOWS.credits,
  );
  const creditSenders24h = new Set(recentP2PCredits.map((p) => p.counterparty)).size;
  const lastCredit = recentP2PCredits[recentP2PCredits.length - 1];
  const minutesSinceLastCredit = lastCredit ? (t.occurredAt - lastCredit.occurredAt) / MIN : null;
  const payeeTxns = priorDebits.filter((p) => p.merchantCategory === null && t.occurredAt - p.occurredAt <= WINDOWS.payees);
  if (isDebit && isP2P) payeeTxns.push(t);
  const distinctP2PPayees2h = new Set(payeeTxns.map((p) => p.counterparty)).size;

  // Structuring
  const band = prior.filter((p) => isNearThreshold(p) && t.occurredAt - p.occurredAt <= WINDOWS.structuring);
  if (isNearThreshold(t)) band.push(t);

  const ids = (xs: TxnInput[]) => xs.map((x) => x.id);
  const features: Features = {
    priorCount: prior.length,
    priorDebitMedian,
    amountRatio,
    hourIst: Math.floor(((t.occurredAt + IST_OFFSET) % (24 * HOUR)) / HOUR),
    isP2P,
    debitsLast5m,
    velocityWindowSec,
    deviceSeenBefore: Boolean(firstSeen),
    deviceAgeMinutes,
    homeCity,
    kmFromHome,
    maxSpeedKmh6h,
    speedWitness,
    isNewPayee,
    ringCustomers6h,
    creditSenders24h,
    minutesSinceLastCredit,
    distinctP2PPayees2h,
    nearThresholdDebits24h: band.length,
    nearThresholdSum24h: Math.round(band.reduce((s, p) => s + p.amount, 0) * 100) / 100,
  };
  return {
    features,
    windows: {
      velocity: isDebit ? [...ids(velocityWindow), t.id] : [],
      ring: ids(ringWindow),
      credits: ids(recentP2PCredits),
      payees: ids(payeeTxns),
      band: ids(band),
    },
  };
}
