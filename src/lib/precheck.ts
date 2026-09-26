import { z } from "zod";
import { isKnownCity } from "@/lib/geo";
import { checkLimits, type LimitViolation } from "@/lib/limits";
import { MODEL_FLAG_THRESHOLD, scoreModels, type ModelScores } from "@/lib/models";
import { assessTransactions } from "@/lib/risk/engine";
import { ALERT_THRESHOLD } from "@/lib/risk/rules";
import type { RuleHit, TxnInput } from "@/lib/risk/types";

export const PRECHECK_POLICY_VERSION = "precheck-2026.09.26-p1";
export const PROPOSED_ID = "00000000-0000-4000-8000-000000000000";

export const DECISIONS = ["ALLOW", "WARN", "STEP_UP", "HOLD", "DECLINE"] as const;
export type PrecheckDecision = (typeof DECISIONS)[number];

/** A payment that has NOT happened yet. */
export const ProposedPayment = z.object({
  customerRef: z.string().regex(/^[A-Z]+-\d{3,}$/),
  amount: z.number().positive().max(10_000_000),
  channel: z.enum(["UPI", "CARD", "NETBANKING", "IMPS", "ATM"]),
  direction: z.literal("debit").default("debit"),
  counterparty: z.string().trim().min(3).max(120),
  merchantCategory: z.string().trim().max(40).nullable().default(null),
  city: z.string().refine(isKnownCity, "unknown city"),
  deviceId: z.string().trim().min(2).max(80),
  occurredAt: z.number().int().positive().optional(),
});
export type ProposedPayment = z.infer<typeof ProposedPayment>;

export type PrecheckResult = {
  decision: PrecheckDecision;
  policyVersion: string;
  ruleScore: number;
  reasonCodes: string[];
  ruleEvidence: { code: string; weight: number; text: string }[];
  models: Pick<ModelScores, "behaviour" | "beneficiary" | "network" | "agreement" | "modelOnly">;
  /** Why the policy chose this decision. */
  policyReasons: string[];
  /** Payment-rail limit breaches (NPCI / bank). Any breach → DECLINE before fraud scoring. */
  limitViolations: LimitViolation[];
  /** What the customer sees in the app before confirming. Never reveals internal scores. */
  customerMessage: string | null;
  latencyMs: number;
};

/**
 * Decision policy — rules can HOLD; models (advisory) can only add friction (WARN / STEP_UP).
 */
export function decide(ruleScore: number, hits: Pick<RuleHit, "code" | "pattern">[], m: ModelScores): { decision: PrecheckDecision; reasons: string[] } {
  const reasons: string[] = [];
  const modelFlag = (k: "behaviour" | "beneficiary" | "network") => m[k].applicable && m[k].score >= MODEL_FLAG_THRESHOLD;
  if (ruleScore >= 70 || (ruleScore >= ALERT_THRESHOLD && m.agreement === "HIGH")) {
    reasons.push(ruleScore >= 70 ? `rules score ${ruleScore} ≥ 70` : `rules score ${ruleScore} with HIGH detector agreement`);
    return { decision: "HOLD", reasons };
  }
  if (ruleScore >= ALERT_THRESHOLD) reasons.push(`rules score ${ruleScore} ≥ ${ALERT_THRESHOLD}`);
  for (const k of ["behaviour", "beneficiary", "network"] as const) if (modelFlag(k)) reasons.push(`${k} model ${m[k].score} ≥ ${MODEL_FLAG_THRESHOLD}`);
  if (reasons.length) return { decision: "STEP_UP", reasons };
  if (m.beneficiary.applicable && m.beneficiary.score >= 40) return { decision: "WARN", reasons: [`beneficiary model ${m.beneficiary.score} ≥ 40`] };
  if (hits.some((h) => h.code === "NEAR_THRESHOLD" || h.code === "AMOUNT_SPIKE")) return { decision: "WARN", reasons: ["unusual amount for this customer"] };
  return { decision: "ALLOW", reasons: ["no rule or model concern"] };
}

function customerMessage(decision: PrecheckDecision, m: ModelScores, codes: string[]): string | null {
  if (decision === "ALLOW") return null;
  const scam =
    "Banks, police, CBI or courier companies will never ask you to move money to 'verify' or 'protect' your account. If someone is on a call asking you to pay, hang up.";
  if (m.beneficiary.applicable && m.beneficiary.score >= 40) {
    return `This account has received payments from several people recently. ${scam}`;
  }
  if (codes.includes("NEW_DEVICE_HIGH_VALUE") || codes.includes("NEW_DEVICE")) {
    return "This is a large payment from a new device. If you did not just set up a new phone or SIM, stop and call us on the number on your card.";
  }
  if (decision === "HOLD") return "We've paused this payment to protect your account. Our fraud team will contact you shortly.";
  return `Please confirm this payment is expected. ${scam}`;
}

/**
 * Checks payment-rail limits first, then scores the proposed payment with the same point-in-time
 * engine used after the fact (fraud scores are still returned on DECLINE for the audit trail).
 * `customerHistory` = this customer's past transactions; `beneficiaryHistory` = past P2P debits
 * by any customer to the same counterparty. Stateless: nothing is written.
 */
export function precheck(
  proposed: ProposedPayment & { customerId: string },
  customerHistory: TxnInput[],
  beneficiaryHistory: TxnInput[],
  now: () => number = Date.now,
): PrecheckResult {
  const started = performance.now();
  const at = proposed.occurredAt ?? now();
  const candidate: TxnInput = {
    id: PROPOSED_ID,
    customerId: proposed.customerId,
    amount: Math.round(proposed.amount * 100) / 100,
    channel: proposed.channel,
    direction: "debit",
    counterparty: proposed.counterparty,
    merchantCategory: proposed.merchantCategory,
    city: proposed.city,
    deviceId: proposed.deviceId,
    occurredAt: at,
  };
  const past = new Map<string, TxnInput>();
  for (const t of [...customerHistory, ...beneficiaryHistory]) if (t.occurredAt < at && t.id !== PROPOSED_ID) past.set(t.id, t);
  const all = [...past.values(), candidate];

  const assessment = assessTransactions(all).find((a) => a.transactionId === PROPOSED_ID)!;
  const m = scoreModels(all, new Map([[PROPOSED_ID, assessment.score]])).get(PROPOSED_ID)!;
  const limitViolations = checkLimits(candidate, customerHistory);
  const scored = decide(assessment.score, assessment.hits, m);
  const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;
  const { decision, reasons } = limitViolations.length
    ? { decision: "DECLINE" as const, reasons: limitViolations.map((l) => `${l.label}: ${inr(l.attempted)} > ${inr(l.limit)} (${l.source})`) }
    : scored;

  return {
    decision,
    policyVersion: PRECHECK_POLICY_VERSION,
    ruleScore: assessment.score,
    reasonCodes: assessment.reasonCodes,
    ruleEvidence: assessment.hits.map((h) => ({ code: h.code, weight: h.weight, text: h.evidence })),
    models: { behaviour: m.behaviour, beneficiary: m.beneficiary, network: m.network, agreement: m.agreement, modelOnly: m.modelOnly },
    policyReasons: reasons,
    limitViolations,
    customerMessage: limitViolations.length
      ? `This payment exceeds the ${limitViolations[0].label.toLowerCase()} limit of ${inr(limitViolations[0].limit)}. Try a smaller amount or another channel.`
      : customerMessage(decision, m, assessment.reasonCodes),
    latencyMs: Math.round((performance.now() - started) * 10) / 10,
  };
}
