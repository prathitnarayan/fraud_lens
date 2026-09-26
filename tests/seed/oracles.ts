/**
 * Test-only reference detectors. They define each pattern precisely so tests can prove that
 * (a) every planted scenario satisfies its pattern and (b) no unlabelled transaction does.
 * Deliberately independent from the P2 risk engine.
 */
import { IMPOSSIBLE_SPEED_KMH, STRUCTURING_THRESHOLD } from "@/lib/fraud-patterns";
import { impliedSpeedKmh } from "@/lib/geo";
import type { Dataset, GenTxn } from "../../scripts/seed/types";

const MIN = 60_000;
const HOUR = 60 * MIN;

export function byCustomer(d: Dataset): Map<string, GenTxn[]> {
  const m = new Map<string, GenTxn[]>();
  for (const t of d.transactions) {
    const list = m.get(t.customerId) ?? [];
    list.push(t);
    m.set(t.customerId, list);
  }
  for (const list of m.values()) list.sort((a, b) => a.occurredAt - b.occurredAt);
  return m;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** ≥ 6 debits by one customer within 5 minutes → returns the txns in any such window. */
export function velocityHits(txns: GenTxn[]): Set<string> {
  const hits = new Set<string>();
  const debits = txns.filter((t) => t.direction === "debit");
  for (let i = 0; i < debits.length; i++) {
    let j = i;
    while (j + 1 < debits.length && debits[j + 1].occurredAt - debits[i].occurredAt <= 5 * MIN) j++;
    if (j - i + 1 >= 6) for (let k = i; k <= j; k++) hits.add(debits[k].id);
  }
  return hits;
}

/** Debit ≥ ₹50k on a never-before-seen device, ≥ 8× the customer's prior median debit (needs ≥ 5 priors). */
export function newDeviceHighValueHits(txns: GenTxn[]): Set<string> {
  const hits = new Set<string>();
  const seen = new Set<string>();
  const priorDebits: number[] = [];
  for (const t of txns) {
    if (
      t.direction === "debit" &&
      !seen.has(t.deviceId) &&
      t.amount >= 50_000 &&
      priorDebits.length >= 5 &&
      t.amount >= 8 * median(priorDebits)
    ) {
      hits.add(t.id);
    }
    seen.add(t.deviceId);
    if (t.direction === "debit") priorDebits.push(t.amount);
  }
  return hits;
}

/** Txn whose city implies travel faster than IMPOSSIBLE_SPEED_KMH from the previous txn. */
export function geoHits(txns: GenTxn[]): Set<string> {
  const hits = new Set<string>();
  for (let i = 1; i < txns.length; i++) {
    const a = txns[i - 1];
    const b = txns[i];
    if (impliedSpeedKmh(a.city, b.city, b.occurredAt - a.occurredAt) > IMPOSSIBLE_SPEED_KMH) hits.add(b.id);
  }
  return hits;
}

/** ≥ 4 debits each in [45k, 50k) within 24h. */
export function structuringHits(txns: GenTxn[]): Set<string> {
  const hits = new Set<string>();
  const band = txns.filter((t) => t.direction === "debit" && t.amount >= 45_000 && t.amount < STRUCTURING_THRESHOLD);
  for (let i = 0; i < band.length; i++) {
    let j = i;
    while (j + 1 < band.length && band[j + 1].occurredAt - band[i].occurredAt <= 24 * HOUR) j++;
    if (j - i + 1 >= 4) for (let k = i; k <= j; k++) hits.add(band[k].id);
  }
  return hits;
}

/** ≥ 5 distinct customers paying the same P2P counterparty within 6h (merchants excluded). */
export function fanInRingHits(d: Dataset): Set<string> {
  const hits = new Set<string>();
  const byCp = new Map<string, GenTxn[]>();
  for (const t of d.transactions) {
    if (t.direction !== "debit" || t.merchantCategory !== null) continue;
    byCp.set(t.counterparty, [...(byCp.get(t.counterparty) ?? []), t]);
  }
  for (const list of byCp.values()) {
    list.sort((a, b) => a.occurredAt - b.occurredAt);
    for (let i = 0; i < list.length; i++) {
      const win = list.filter((t) => t.occurredAt >= list[i].occurredAt && t.occurredAt - list[i].occurredAt <= 6 * HOUR);
      if (new Set(win.map((t) => t.customerId)).size >= 5) win.forEach((t) => hits.add(t.id));
    }
  }
  return hits;
}

/** ≥ 4 P2P credits from distinct senders in 24h, then ≥ 4 P2P debits to distinct payees within 2h after. */
export function passThroughHits(txns: GenTxn[]): Set<string> {
  const hits = new Set<string>();
  const credits = txns.filter((t) => t.direction === "credit" && t.merchantCategory === null);
  for (let i = 0; i < credits.length; i++) {
    const windowCredits = credits.filter(
      (c) => c.occurredAt >= credits[i].occurredAt && c.occurredAt - credits[i].occurredAt <= 24 * HOUR,
    );
    if (new Set(windowCredits.map((c) => c.counterparty)).size < 4) continue;
    const last = windowCredits[windowCredits.length - 1].occurredAt;
    const outs = txns.filter(
      (t) => t.direction === "debit" && t.merchantCategory === null && t.occurredAt > last && t.occurredAt - last <= 2 * HOUR,
    );
    if (new Set(outs.map((t) => t.counterparty)).size >= 4) {
      windowCredits.forEach((c) => hits.add(c.id));
      outs.forEach((t) => hits.add(t.id));
    }
  }
  return hits;
}
