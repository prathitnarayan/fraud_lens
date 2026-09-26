import type { CaseContext } from "./minimize";
import type { CaseSummary, SuggestedAction } from "./schema";

type Playbook = { headline: string; action: SuggestedAction; rationale: string; benign: string[]; questions: string[] };

/** Deterministic analyst playbook per pattern rule — used whenever the LLM is unavailable or rejected. */
export const PLAYBOOKS: Record<string, Playbook> = {
  VELOCITY_BURST: {
    headline: "Burst of rapid debits — possible account takeover or card testing",
    action: "TEMP_BLOCK_AND_ESCALATE",
    rationale: "Rapid repeated debits usually continue until the channel is blocked.",
    benign: ["Customer buying several items or top-ups in one sitting"],
    questions: ["Did you make several payments in the last few minutes?", "Is your phone or card with you right now?"],
  },
  NEW_DEVICE_HIGH_VALUE: {
    headline: "Large transfer from a new device — possible SIM-swap or account takeover",
    action: "CALL_CUSTOMER_VERIFY",
    rationale: "A new device plus an unusually large payment needs the customer's confirmation before funds move further.",
    benign: ["Customer recently changed phone", "Planned large payment (property, fees, family)"],
    questions: ["Did you recently change your phone or SIM?", "Did you authorise this transfer and do you know the payee?"],
  },
  IMPOSSIBLE_TRAVEL: {
    headline: "Card used in two distant cities too quickly — possible cloned card",
    action: "TEMP_BLOCK_AND_ESCALATE",
    rationale: "Physically impossible travel strongly indicates a counterfeit or compromised card.",
    benign: ["Online/card-not-present merchant registered in another city", "Family member using an add-on card"],
    questions: ["Is your card with you?", "Were you in the city where the card was used?"],
  },
  MULE_RING: {
    headline: "Several customers paid the same unknown account — possible scam collection (mule) account",
    action: "CALL_CUSTOMER_VERIFY",
    rationale: "The customer may be a scam victim; confirming the payment's purpose helps recover funds and report the account.",
    benign: ["Popular small business or community collection using a personal UPI handle"],
    questions: ["What was this payment for?", "Were you contacted by someone asking you to pay for a refund, prize or KYC update?"],
  },
  MULE_PASS_THROUGH: {
    headline: "Money received from many senders and quickly sent out — possible mule account",
    action: "TEMP_BLOCK_AND_ESCALATE",
    rationale: "Rapid pass-through of funds is a strong money-mule signal; holding funds limits further dispersal.",
    benign: ["Group expense collection being settled", "Small business settling supplier payments"],
    questions: ["Who sent you these amounts and why?", "Who are the recipients of the outgoing transfers?"],
  },
  STRUCTURING: {
    headline: "Multiple payments kept just under ₹50,000 within 24 hours — possible structuring",
    action: "REQUEST_KYC_DOCUMENTS",
    rationale: "Splitting amounts below a reporting threshold warrants source-of-funds and purpose documentation.",
    benign: ["Instalment payments agreed with a vendor", "Per-transaction limits set by the payee's bank"],
    questions: ["What is the purpose of these payments?", "Why was the amount split into several transfers?"],
  },
};

const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;

export function fallbackSummary(ctx: CaseContext): CaseSummary {
  const primary = ctx.alert.evidence.find((e) => e.code in PLAYBOOKS)?.code ?? ctx.alert.reason_codes[0];
  const book = PLAYBOOKS[primary] ?? {
    headline: "Transaction flagged by the rules engine",
    action: "MONITOR_ACCOUNT" as const,
    rationale: "No specific playbook applies; review the evidence below.",
    benign: [],
    questions: [],
  };
  const t = ctx.transaction;
  const b = ctx.customer_baseline;
  const baseline =
    b.median_debit_inr !== null
      ? `Usual debit is about ${inr(b.median_debit_inr)} over ${b.prior_transactions} prior transactions; home city ${b.home_city}.`
      : `Limited history (${b.prior_transactions ?? 0} prior transactions); home city ${b.home_city}.`;
  return {
    headline: book.headline,
    narrative: [
      `${inr(t.amount_inr)} ${t.direction} via ${t.channel} in ${t.city} at ${t.time_ist} to ${t.counterparty} (${t.counterparty_type}).`,
      ...ctx.alert.evidence.slice(0, 3).map((e) => `${e.code}: ${e.text}.`),
    ].join(" "),
    key_facts: ctx.alert.evidence.slice(0, 6).map((e) => `${e.code} (+${e.weight}): ${e.text}`.slice(0, 200)),
    customer_context: baseline,
    benign_explanations: book.benign,
    suggested_action: book.action,
    action_rationale: book.rationale,
    questions_for_customer: book.questions,
    cited_reason_codes: [...ctx.alert.reason_codes],
  };
}
