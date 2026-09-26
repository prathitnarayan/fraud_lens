import type { EvidenceItem } from "@/lib/queue-types";
import { SIGNAL_CAP } from "@/lib/risk/rules";

export type ScoreExplanation = {
  patterns: EvidenceItem[];
  signals: EvidenceItem[];
  patternSum: number;
  signalSum: number;
  signalCounted: number;
  signalCapped: boolean;
  total: number;
  cappedAt100: boolean;
  /** False means stored evidence no longer reproduces the stored score (e.g. edited data) — shown as a warning. */
  consistent: boolean;
};

/** Re-derives the score from persisted evidence exactly as the engine does. */
export function explainScore(evidence: EvidenceItem[], storedScore: number): ScoreExplanation {
  const patterns = evidence.filter((e) => e.pattern !== null);
  const signals = evidence.filter((e) => e.pattern === null);
  const patternSum = patterns.reduce((s, e) => s + e.weight, 0);
  const signalSum = signals.reduce((s, e) => s + e.weight, 0);
  const signalCounted = Math.min(SIGNAL_CAP, signalSum);
  const raw = patternSum + signalCounted;
  const total = Math.min(100, raw);
  return {
    patterns,
    signals,
    patternSum,
    signalSum,
    signalCounted,
    signalCapped: signalSum > SIGNAL_CAP,
    total,
    cappedAt100: raw > 100,
    consistent: total === storedScore,
  };
}

export type TimelineTxn = {
  id: string;
  customerId: string;
  customerRef: string;
  amount: number;
  direction: string;
  channel: string;
  city: string;
  counterparty: string;
  deviceId: string;
  occurredAt: number;
};

export type TimelineEntry = TimelineTxn & {
  isAlert: boolean;
  isOtherCustomer: boolean;
  /** Reason codes whose cluster this transaction belongs to. */
  clusters: string[];
  /** Codes whose pattern this transaction completed. */
  completes: string[];
  newDevice: boolean;
  newCity: boolean;
};

/**
 * Evidence timeline: the alerted txn, every cluster member, and recent own history for context.
 * Marks which txn completed which pattern, and device/city firsts relative to earlier entries.
 */
export function buildTimeline(alertTxn: TimelineTxn, evidence: EvidenceItem[], related: TimelineTxn[]): TimelineEntry[] {
  const byId = new Map<string, TimelineTxn>([[alertTxn.id, alertTxn], ...related.map((t) => [t.id, t] as const)]);
  const clusters = new Map<string, Set<string>>();
  const completes = new Map<string, Set<string>>();
  for (const e of evidence) {
    for (const m of e.members ?? []) {
      if (!clusters.has(m)) clusters.set(m, new Set());
      clusters.get(m)!.add(e.code);
    }
    const completer = e.via ?? (e.members?.length ? alertTxn.id : null);
    if (completer && e.pattern) {
      if (!completes.has(completer)) completes.set(completer, new Set());
      completes.get(completer)!.add(e.code);
    }
  }
  const sorted = [...byId.values()].sort((a, b) => a.occurredAt - b.occurredAt || a.id.localeCompare(b.id));
  const seenDevices = new Set<string>();
  const seenCities = new Set<string>();
  return sorted.map((t) => {
    const own = t.customerId === alertTxn.customerId;
    const entry: TimelineEntry = {
      ...t,
      isAlert: t.id === alertTxn.id,
      isOtherCustomer: !own,
      clusters: [...(clusters.get(t.id) ?? [])].sort(),
      completes: [...(completes.get(t.id) ?? [])].sort(),
      newDevice: own && seenDevices.size > 0 && !seenDevices.has(t.deviceId),
      newCity: own && seenCities.size > 0 && !seenCities.has(t.city),
    };
    if (own) {
      seenDevices.add(t.deviceId);
      seenCities.add(t.city);
    }
    return entry;
  });
}

export type AuditRow = { id: number; actor_id: string | null; action: string; details: Record<string, unknown>; created_at: string };
export type TrailStep = { at: string; actor: string; label: string; note: string | null };

const STATUS_WORDS: Record<string, string> = {
  in_review: "claimed for review",
  escalated: "escalated",
  confirmed_fraud: "confirmed as fraud",
  false_positive: "marked false positive",
};

/** Human-readable decision trail from the alert's audit rows. */
export function buildTrail(rows: AuditRow[], names: Map<string, string>, viewerId: string): TrailStep[] {
  const who = (id: string | null) => (id === null ? "System" : id === viewerId ? "You" : (names.get(id) ?? "Staff member"));
  return [...rows]
    .sort((a, b) => a.id - b.id)
    .flatMap((r): TrailStep[] => {
      const d = r.details ?? {};
      switch (r.action) {
        case "alert.created":
          return [{ at: r.created_at, actor: "Rules engine", label: `Alert created (score ${String(d.risk_score ?? "?")}, ${String(d.severity ?? "")})`, note: null }];
        case "alert.status_changed": {
          const to = String(d.to ?? "");
          return [{ at: r.created_at, actor: who(r.actor_id), label: STATUS_WORDS[to] ?? `status → ${to}`, note: to === "in_review" ? null : ((d.note as string | null) ?? null) }];
        }
        case "ai.summary_generated":
          return [{ at: r.created_at, actor: who(r.actor_id), label: `Requested AI brief (${String(d.source)}${d.fallback_reason ? `: ${String(d.fallback_reason)}` : ""})`, note: null }];
        default:
          return []; // alert.ai_summary / alert.updated are system bookkeeping duplicates
      }
    });
}
