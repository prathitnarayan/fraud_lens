import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { precheck, type PrecheckResult, type ProposedPayment } from "@/lib/precheck";
import { rowToTxn } from "@/lib/risk/runner";

const COLS = "id, customer_id, amount, channel, direction, counterparty, merchant_category, city, device_id, occurred_at";
const LOOKBACK_MS = 30 * 24 * 3600_000;

export type PrecheckOutcome = { ok: true; result: PrecheckResult; customerRef: string } | { ok: false; status: number; error: string };

/** Loads 30 days of customer + beneficiary history (service role) and runs the check. Audited. */
export async function runPrecheck(admin: SupabaseClient, input: ProposedPayment, actorId: string | null): Promise<PrecheckOutcome> {
  const { data: customer, error: cErr } = await admin.from("customers").select("id, external_ref").eq("external_ref", input.customerRef).maybeSingle();
  if (cErr) return { ok: false, status: 500, error: "lookup failed" };
  if (!customer) return { ok: false, status: 404, error: "unknown customer" };

  const at = input.occurredAt ?? Date.now();
  const since = new Date(at - LOOKBACK_MS).toISOString();
  const until = new Date(at).toISOString();
  const isP2P = input.merchantCategory === null;
  const [own, bene] = await Promise.all([
    admin.from("transactions").select(COLS).eq("customer_id", customer.id).gte("occurred_at", since).lt("occurred_at", until).order("occurred_at").limit(1000),
    isP2P
      ? admin.from("transactions").select(COLS).eq("counterparty", input.counterparty).eq("direction", "debit").is("merchant_category", null)
          .gte("occurred_at", since).lt("occurred_at", until).order("occurred_at").limit(1000)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (own.error || bene.error) return { ok: false, status: 500, error: "history load failed" };

  const result = precheck({ ...input, occurredAt: at, customerId: customer.id }, (own.data ?? []).map(rowToTxn), (bene.data ?? []).map(rowToTxn));

  await admin.from("audit_log").insert({
    actor_id: actorId,
    action: "precheck.decision",
    entity_type: "precheck",
    entity_id: customer.external_ref,
    details: {
      decision: result.decision, rule_score: result.ruleScore, reason_codes: result.reasonCodes,
      agreement: result.models.agreement, amount: input.amount, channel: input.channel,
      policy: result.policyVersion, latency_ms: result.latencyMs,
    },
  });
  return { ok: true, result, customerRef: customer.external_ref };
}
