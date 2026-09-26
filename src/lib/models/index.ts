import { byTime } from "@/lib/risk/features";
import { ALERT_THRESHOLD } from "@/lib/risk/rules";
import type { TxnInput } from "@/lib/risk/types";
import { behaviourModel, beneficiaryModel, networkModel } from "./detectors";
import { MODEL_FLAG_THRESHOLD, MODEL_VERSION, type Agreement, type ModelScores } from "./types";

export * from "./types";

/**
 * Agreement across all detectors (rules included).
 * HIGH: ≥ 2 detectors flag · MIXED: exactly 1 · LOW: none.
 */
export function agreementOf(ruleScore: number, m: Pick<ModelScores, "behaviour" | "beneficiary" | "network">): { agreement: Agreement; modelOnly: boolean } {
  const modelFlags = [m.behaviour, m.beneficiary, m.network].filter((r) => r.applicable && r.score >= MODEL_FLAG_THRESHOLD).length;
  const ruleFlag = ruleScore >= ALERT_THRESHOLD ? 1 : 0;
  const flags = modelFlags + ruleFlag;
  return {
    agreement: flags >= 2 ? "HIGH" : flags === 1 ? "MIXED" : "LOW",
    modelOnly: ruleFlag === 0 && modelFlags > 0,
  };
}

/**
 * Scores every transaction with all three models in one point-in-time pass.
 * Models are ADVISORY: they never change risk_score or create alerts (enforced by tests).
 */
export function scoreModels(input: readonly TxnInput[], ruleScores: ReadonlyMap<string, number>): Map<string, ModelScores> {
  const sorted = [...input].sort(byTime);
  const perCustomer = new Map<string, TxnInput[]>();
  const perCounterparty = new Map<string, TxnInput[]>();
  const out = new Map<string, ModelScores>();

  for (const t of sorted) {
    const prior = perCustomer.get(t.customerId) ?? [];
    const cp = t.direction === "debit" && t.merchantCategory === null ? (perCounterparty.get(t.counterparty) ?? []) : [];
    const m = {
      behaviour: behaviourModel(t, prior),
      beneficiary: beneficiaryModel(t, cp, prior),
      network: networkModel(t, prior),
    };
    out.set(t.id, { version: MODEL_VERSION, ...m, ...agreementOf(ruleScores.get(t.id) ?? 0, m) });
    perCustomer.set(t.customerId, [...prior, t]);
    if (t.direction === "debit" && t.merchantCategory === null) perCounterparty.set(t.counterparty, [...cp, t]);
  }
  return out;
}
