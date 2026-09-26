/**
 * RBI regulatory mapping. Figures are encoded as data so they can be updated when drafts are finalised.
 * Sources (checked 26 Sep 2026):
 *  - RBI (Authentication Mechanisms for Digital Payment Transactions) Directions, 2025 — in force 1 Apr 2026
 *  - Draft SOP on suspected money-mule accounts — comments till 2 Oct 2026, proposed effective 1 Apr 2027
 *  - Draft framework on compensation for digital banking fraud — issued 6 Mar 2026, proposed 1 Jul 2026
 *  - Master Directions on Fraud Risk Management (Jul 2024) — EWS & red-flagging
 */

export type RegStatus = "in_force" | "draft";

export const REGULATIONS = {
  auth2fa: {
    name: "RBI Authentication Mechanisms for Digital Payment Transactions Directions, 2025",
    status: "in_force" as RegStatus,
    effective: "2026-04-01",
    summary: "2FA with at least one dynamic factor; issuers must apply risk-based checks to suspicious transactions.",
  },
  muleSop: {
    name: "RBI draft SOP on suspected money-mule accounts",
    status: "draft" as RegStatus,
    effective: "2027-04-01",
    minAmount: 1_000,
    explanationDays: 20,
    decisionDaysAfterExplanation: 10,
    decisionDaysIfNoExplanation: 30,
    maxHoldDays: 60,
  },
  compensation: {
    name: "RBI draft framework on compensation for digital banking fraud",
    status: "draft" as RegStatus,
    effective: "2026-07-01",
    reportWithinDays: 5,
    maxLoss: 50_000,
    share: 0.85,
    cap: 25_000,
  },
  frm: {
    name: "RBI Master Directions on Fraud Risk Management (Jul 2024)",
    status: "in_force" as RegStatus,
    effective: "2024-07-15",
    summary: "Board-approved Early Warning Signals framework and red-flagging of accounts.",
  },
} as const;

const DAY = 86_400_000;
const addDays = (ms: number, d: number) => ms + d * DAY;

export const MULE_CODES = ["MULE_PASS_THROUGH", "MULE_RING"] as const;
/** Alerts where the customer is the likely victim (compensation relevant). */
export const VICTIM_CODES = ["NEW_DEVICE_HIGH_VALUE", "VELOCITY_BURST", "IMPOSSIBLE_TRAVEL", "MULE_RING"] as const;

export type MuleHoldPlan = {
  applies: boolean;
  reason: string;
  /** For MULE_RING the suspected mule is the external beneficiary → report, not hold our customer. */
  target: "customer_account" | "beneficiary" | null;
  holdStart: number | null;
  explanationDue: number | null;
  decisionDue: number | null;
  maxHoldUntil: number | null;
  daysRemaining: number | null;
};

/** Draft mule-SOP clock. `explanationAt` shortens the decision window (10 days after reply vs 30 without). */
export function muleHoldPlan(input: { reasonCodes: string[]; amount: number; holdStart: number | null; explanationAt?: number | null; now: number }): MuleHoldPlan {
  const sop = REGULATIONS.muleSop;
  const none = { holdStart: null, explanationDue: null, decisionDue: null, maxHoldUntil: null, daysRemaining: null };
  const passThrough = input.reasonCodes.includes("MULE_PASS_THROUGH");
  const ring = input.reasonCodes.includes("MULE_RING");
  if (!passThrough && !ring) return { applies: false, reason: "No mule pattern on this alert.", target: null, ...none };
  if (input.amount < sop.minAmount) return { applies: false, reason: `Below the ₹${sop.minAmount.toLocaleString("en-IN")} threshold.`, target: null, ...none };
  if (!passThrough) {
    return { applies: true, target: "beneficiary", reason: "Suspected mule is the receiving account (outside this customer) — report beneficiary via NCRP-CFCFRMS / receiving bank.", ...none };
  }
  if (input.holdStart === null) {
    return { applies: true, target: "customer_account", reason: "Eligible for an immediate temporary debit hold once an analyst confirms suspicion.", ...none };
  }
  const explanationDue = addDays(input.holdStart, sop.explanationDays);
  const decisionDue = input.explanationAt
    ? addDays(input.explanationAt, sop.decisionDaysAfterExplanation)
    : addDays(explanationDue, sop.decisionDaysIfNoExplanation);
  const maxHoldUntil = addDays(input.holdStart, sop.maxHoldDays);
  return {
    applies: true,
    target: "customer_account",
    reason: "Debit hold running under the draft SOP timeline.",
    holdStart: input.holdStart,
    explanationDue,
    decisionDue: Math.min(decisionDue, maxHoldUntil),
    maxHoldUntil,
    daysRemaining: Math.max(0, Math.ceil((maxHoldUntil - input.now) / DAY)),
  };
}

export type Compensation = {
  applies: boolean;
  reason: string;
  reportBy: number | null;
  withinWindow: boolean | null;
  estimatedInr: number | null;
};

/** Draft compensation framework: losses ≤ ₹50k → min(85%, ₹25,000), if reported within 5 days (once per lifetime). */
export function compensationEstimate(input: { reasonCodes: string[]; amount: number; direction: string; occurredAt: number; now: number }): Compensation {
  const c = REGULATIONS.compensation;
  const victim = input.reasonCodes.some((x) => (VICTIM_CODES as readonly string[]).includes(x)) && input.direction === "debit";
  if (!victim) return { applies: false, reason: "Not a customer-loss pattern.", reportBy: null, withinWindow: null, estimatedInr: null };
  const reportBy = addDays(input.occurredAt, c.reportWithinDays);
  const withinWindow = input.now <= reportBy;
  if (input.amount > c.maxLoss) {
    return { applies: false, reason: `Loss above ₹${c.maxLoss.toLocaleString("en-IN")} — outside the draft scheme; standard dispute route.`, reportBy, withinWindow, estimatedInr: null };
  }
  return {
    applies: true,
    reason: "If confirmed as fraud and reported to the bank and cyber portal in time (once per lifetime).",
    reportBy,
    withinWindow,
    estimatedInr: Math.round(Math.min(input.amount * c.share, c.cap)),
  };
}
