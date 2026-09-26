import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { evaluateFromCount, type Confusion } from "@/lib/risk/evaluate";
import { selectAll } from "@/lib/risk/runner";

export const QUEUE_TABS = {
  open: ["open"],
  in_review: ["in_review"],
  escalated: ["escalated"],
  closed: ["confirmed_fraud", "false_positive"],
  all: ["open", "in_review", "escalated", "confirmed_fraud", "false_positive"],
} as const;
export type QueueTab = keyof typeof QUEUE_TABS;

export function parseTab(v: string | string[] | undefined): QueueTab {
  const s = Array.isArray(v) ? v[0] : v;
  return s && Object.prototype.hasOwnProperty.call(QUEUE_TABS, s) ? (s as QueueTab) : "open";
}

export type EvidenceItem = { code: string; pattern: string | null; weight: number; text: string; via: string | null };

export type QueueRow = {
  id: string;
  risk_score: number;
  severity: "low" | "medium" | "high" | "critical";
  reason_codes: string[];
  evidence: EvidenceItem[];
  status: string;
  created_at: string;
  transactions: { amount: number; channel: string; direction: string; counterparty: string; city: string; occurred_at: string } | null;
  customers: { full_name: string; account_masked: string; external_ref: string } | null;
};

/** Reads run as the signed-in user — RLS decides what they can see. */
export async function loadQueue(db: SupabaseClient, tab: QueueTab): Promise<QueueRow[]> {
  const { data, error } = await db
    .from("alerts")
    .select(
      "id, risk_score, severity, reason_codes, evidence, status, created_at, " +
        "transactions(amount, channel, direction, counterparty, city, occurred_at), " +
        "customers(full_name, account_masked, external_ref)",
    )
    .in("status", [...QUEUE_TABS[tab]])
    .order("risk_score", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(`load queue: ${error.message}`);
  return data as unknown as QueueRow[];
}

export async function loadCounts(db: SupabaseClient): Promise<Record<QueueTab, number>> {
  const entries = await Promise.all(
    (Object.keys(QUEUE_TABS) as QueueTab[]).map(async (tab) => {
      const { count, error } = await db
        .from("alerts")
        .select("id", { count: "exact", head: true })
        .in("status", [...QUEUE_TABS[tab]]);
      if (error) throw new Error(`count ${tab}: ${error.message}`);
      return [tab, count ?? 0] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<QueueTab, number>;
}

/** Supervisor-only (fraud_labels is RLS-restricted): detection quality vs planted ground truth. */
export async function loadEvaluation(db: SupabaseClient): Promise<Confusion | null> {
  const [{ count, error }, labels, alerts] = await Promise.all([
    db.from("transactions").select("id", { count: "exact", head: true }),
    selectAll<{ transaction_id: string; pattern: string }>(db, "fraud_labels", "transaction_id, pattern", "transaction_id"),
    selectAll<{ transaction_id: string }>(db, "alerts", "transaction_id", "transaction_id"),
  ]);
  if (error) throw new Error(`count transactions: ${error.message}`);
  if (!count) return null;
  return evaluateFromCount(
    count,
    alerts.map((a) => a.transaction_id),
    labels.map((l) => ({ transactionId: l.transaction_id, pattern: l.pattern })),
  );
}
