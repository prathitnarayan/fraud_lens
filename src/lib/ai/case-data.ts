import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { EvidenceItem } from "@/lib/queue-types";
import type { CaseInput } from "./minimize";
import { AiSummaryRecordSchema, type AiSummaryRecord } from "./schema";

export const AlertIdSchema = z.uuid();

type TxnRow = {
  id: string; amount: number | string; channel: string; direction: string; counterparty: string;
  merchant_category: string | null; city: string; device_id: string; occurred_at: string;
};

const toTxn = (r: TxnRow): CaseInput["txn"] => ({
  id: r.id,
  amount: Number(r.amount),
  channel: r.channel,
  direction: r.direction,
  counterparty: r.counterparty,
  merchantCategory: r.merchant_category,
  city: r.city,
  deviceId: r.device_id,
  occurredAt: Date.parse(r.occurred_at),
});

export type CaseView = {
  input: CaseInput;
  status: string;
  resolutionNote: string | null;
  assignedTo: string | null;
  rulesetVersion: string | null;
  createdAt: string;
  aiRecord: AiSummaryRecord | null;
};

/** Loads an alert case as the signed-in user: if RLS hides it, this returns null. */
export async function loadCase(db: SupabaseClient, alertId: string): Promise<CaseView | null> {
  if (!AlertIdSchema.safeParse(alertId).success) return null;
  const { data: a, error } = await db
    .from("alerts")
    .select(
      "id, risk_score, severity, reason_codes, evidence, status, resolution_note, assigned_to, ruleset_version, created_at, ai_summary, " +
        "transactions(id, amount, channel, direction, counterparty, merchant_category, city, device_id, occurred_at), " +
        "customers(id, full_name, external_ref, account_masked, segment, kyc_tier, home_city)",
    )
    .eq("id", alertId)
    .maybeSingle();
  if (error) throw new Error(`load alert: ${error.message}`);
  if (!a) return null;
  const row = a as unknown as {
    id: string; risk_score: number; severity: string; reason_codes: string[]; evidence: EvidenceItem[]; status: string;
    resolution_note: string | null; assigned_to: string | null; ruleset_version: string | null; created_at: string; ai_summary: unknown;
    transactions: TxnRow | null;
    customers: { id: string; full_name: string; external_ref: string; account_masked: string; segment: string; kyc_tier: number; home_city: string } | null;
  };
  if (!row.transactions || !row.customers) return null;
  const txn = toTxn(row.transactions);

  const [{ data: assessment }, { data: history, error: hErr }] = await Promise.all([
    db.from("risk_assessments").select("features").eq("transaction_id", txn.id).maybeSingle(),
    db
      .from("transactions")
      .select("id, amount, channel, direction, counterparty, merchant_category, city, device_id, occurred_at")
      .eq("customer_id", row.customers.id)
      .lt("occurred_at", row.transactions.occurred_at)
      .order("occurred_at", { ascending: false })
      .limit(12),
  ]);
  if (hErr) throw new Error(`load history: ${hErr.message}`);

  const parsedAi = AiSummaryRecordSchema.safeParse(row.ai_summary);
  return {
    input: {
      alert: { id: row.id, riskScore: row.risk_score, severity: row.severity, reasonCodes: row.reason_codes, evidence: row.evidence ?? [] },
      txn,
      customer: {
        id: row.customers.id,
        fullName: row.customers.full_name,
        externalRef: row.customers.external_ref,
        accountMasked: row.customers.account_masked,
        segment: row.customers.segment,
        kycTier: row.customers.kyc_tier,
        homeCity: row.customers.home_city,
      },
      features: (assessment?.features as CaseInput["features"]) ?? null,
      history: ((history ?? []) as TxnRow[]).map(toTxn),
    },
    status: row.status,
    resolutionNote: row.resolution_note,
    assignedTo: row.assigned_to,
    rulesetVersion: row.ruleset_version,
    createdAt: row.created_at,
    aiRecord: parsedAi.success ? (parsedAi.data as AiSummaryRecord) : null,
  };
}
