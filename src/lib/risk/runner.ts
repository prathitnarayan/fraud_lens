import type { SupabaseClient } from "@supabase/supabase-js";
import { assessTransactions } from "./engine";
import { RULESET_VERSION } from "./rules";
import type { Assessment, TxnInput } from "./types";

type TxnRow = {
  id: string;
  customer_id: string;
  amount: number | string;
  channel: string;
  direction: "debit" | "credit";
  counterparty: string;
  merchant_category: string | null;
  city: string;
  device_id: string;
  occurred_at: string;
};

export function rowToTxn(r: TxnRow): TxnInput {
  const occurredAt = Date.parse(r.occurred_at);
  const amount = Number(r.amount);
  if (!Number.isFinite(occurredAt) || !Number.isFinite(amount)) throw new Error(`malformed transaction ${r.id}`);
  return {
    id: r.id,
    customerId: r.customer_id,
    amount,
    channel: r.channel,
    direction: r.direction,
    counterparty: r.counterparty,
    merchantCategory: r.merchant_category,
    city: r.city,
    deviceId: r.device_id,
    occurredAt,
  };
}

/** JSON rows for public.apply_risk_assessments. Evidence keeps code/weight/text; features are kept whole. */
export function toApplyRows(assessments: Assessment[]) {
  return assessments.map((a) => ({
    transaction_id: a.transactionId,
    customer_id: a.customerId,
    score: a.score,
    severity: a.severity,
    alert: a.alert,
    reason_codes: a.reasonCodes,
    evidence: a.hits.map((h) => ({ code: h.code, pattern: h.pattern, weight: h.weight, text: h.evidence, via: h.via ?? null })),
    features: a.features,
    ruleset_version: a.rulesetVersion,
  }));
}

const PAGE = 1000;

/** Reads every row of a table/column set, paging past the PostgREST row cap. */
export async function selectAll<T>(db: SupabaseClient, table: string, columns: string, orderBy: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from(table).select(columns).order(orderBy, { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw new Error(`load ${table}: ${error.message}`);
    out.push(...(data as T[]));
    if (!data || data.length < PAGE) return out;
  }
}

/** Loads all transactions (PostgREST caps responses, so page through them in a stable order). */
export async function loadTransactions(db: SupabaseClient): Promise<TxnInput[]> {
  const out: TxnInput[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("transactions")
      .select("id, customer_id, amount, channel, direction, counterparty, merchant_category, city, device_id, occurred_at")
      .order("occurred_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`load transactions: ${error.message}`);
    out.push(...(data as TxnRow[]).map(rowToTxn));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

export type RunSummary = { evaluated: number; assessed: number; alertsCreated: number; engineMs: number; rulesetVersion: string };

/** Loads → assesses → persists in chunks. Must be called with a service-role client. */
export async function runDetection(db: SupabaseClient): Promise<RunSummary> {
  const txns = await loadTransactions(db);
  const started = performance.now();
  const assessments = assessTransactions(txns);
  const engineMs = Math.round(performance.now() - started);
  const rows = toApplyRows(assessments);

  let assessed = 0;
  let alertsCreated = 0;
  for (let i = 0; i < rows.length; i += PAGE) {
    const { data, error } = await db.rpc("apply_risk_assessments", { p_rows: rows.slice(i, i + PAGE) });
    if (error) throw new Error(`apply assessments: ${error.message}`);
    const r = (data as { assessed: number; alerts_created: number }[])[0];
    assessed += r.assessed;
    alertsCreated += r.alerts_created;
  }
  return { evaluated: txns.length, assessed, alertsCreated, engineMs, rulesetVersion: RULESET_VERSION };
}
