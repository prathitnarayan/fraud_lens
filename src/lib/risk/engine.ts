import { buildFeatures, byTime } from "./features";
import { ALERT_THRESHOLD, PATTERN_RULES, RULESET_VERSION, SIGNAL_RULES, scoreHits, severityFor } from "./rules";
import type { Assessment, Features, ReasonCode, RuleHit, TxnInput } from "./types";

type Working = { t: TxnInput; features: Features; hits: Map<ReasonCode, RuleHit> };

/**
 * Deterministic batch assessment.
 * Pass 1 — point-in-time: each txn sees only data at or before itself.
 * Pass 2 — cluster expansion: when a windowed pattern (burst, ring, pass-through, structuring)
 *          is detected, earlier members of that cluster get the same reason code, with evidence
 *          pointing at the transaction that completed the pattern.
 */
export function assessTransactions(input: readonly TxnInput[]): Assessment[] {
  const sorted = [...input].sort(byTime);
  const perCustomer = new Map<string, TxnInput[]>();
  const perCounterparty = new Map<string, TxnInput[]>();
  const work = new Map<string, Working>();

  for (const t of sorted) {
    if (work.has(t.id)) throw new Error(`duplicate transaction id ${t.id}`);
    const prior = perCustomer.get(t.customerId) ?? [];
    let cp = perCounterparty.get(t.counterparty);
    if (t.direction === "debit" && t.merchantCategory === null) {
      cp = [...(cp ?? []), t];
      perCounterparty.set(t.counterparty, cp);
    }
    const { features, windows } = buildFeatures(t, prior, cp ?? []);
    const hits = new Map<ReasonCode, RuleHit>();
    for (const rule of [...PATTERN_RULES, ...SIGNAL_RULES]) {
      const hit = rule(t, features, windows);
      if (hit && !hits.has(hit.code)) hits.set(hit.code, hit);
    }
    work.set(t.id, { t, features, hits });
    perCustomer.set(t.customerId, [...prior, t]);
  }

  for (const { t, hits } of work.values()) {
    for (const hit of hits.values()) {
      if (!hit.members || hit.via) continue;
      for (const memberId of hit.members) {
        if (memberId === t.id) continue;
        const target = work.get(memberId);
        if (!target || target.hits.has(hit.code)) continue;
        target.hits.set(hit.code, {
          code: hit.code,
          pattern: hit.pattern,
          weight: hit.weight,
          evidence: `${hit.evidence} — part of a cluster completed at ${new Date(t.occurredAt).toISOString()}`,
          via: t.id,
        });
      }
    }
  }

  return sorted.map((t) => {
    const { features, hits } = work.get(t.id)!;
    const ordered = [...hits.values()]
      .map(({ members: _members, ...h }) => h)
      .sort((a, b) => b.weight - a.weight || a.code.localeCompare(b.code));
    const score = scoreHits(ordered);
    return {
      transactionId: t.id,
      customerId: t.customerId,
      score,
      severity: severityFor(score),
      alert: score >= ALERT_THRESHOLD,
      reasonCodes: ordered.map((h) => h.code),
      hits: ordered,
      features,
      rulesetVersion: RULESET_VERSION,
    };
  });
}
