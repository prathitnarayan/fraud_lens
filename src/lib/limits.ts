import type { TxnInput } from "@/lib/risk/types";

/**
 * Payment-rail limits checked BEFORE fraud scoring. Each limit records who sets it:
 *  - NPCI: UPI P2P ₹1L/txn and ₹1L rolling 24h; new-user ₹5,000 in first 24h; P2M category caps
 *    for verified merchants (NPCI circular 28 Aug 2025, effective 15 Sep 2025).
 *  - BANK: IMPS / ATM / daily UPI count — set by each bank; defaults here are configurable examples.
 * Checked 26 Sep 2026. Update this table as circulars change.
 */
export type LimitSource = "NPCI" | "BANK";

export const LIMITS = {
  upiP2pPerTxn: { value: 100_000, source: "NPCI" as LimitSource, label: "UPI person-to-person per transaction" },
  upiP2pRolling24h: { value: 100_000, source: "NPCI" as LimitSource, label: "UPI person-to-person per rolling 24 hours" },
  upiNewUser24h: { value: 5_000, source: "NPCI" as LimitSource, label: "UPI total in first 24h of a new registration" },
  upiCount24h: { value: 20, source: "BANK" as LimitSource, label: "UPI transactions per 24 hours" },
  impsPerTxn: { value: 500_000, source: "BANK" as LimitSource, label: "IMPS per transaction" },
  atmPerDay: { value: 50_000, source: "BANK" as LimitSource, label: "ATM withdrawal per day" },
} as const;

/** Verified-merchant UPI P2M per-transaction caps by category (else the ₹1L default). */
export const UPI_P2M_CATEGORY_CAPS: Record<string, number> = {
  capital_markets: 500_000,
  insurance: 500_000,
  travel: 500_000,
  loan_repayment: 500_000,
  credit_card_bill: 500_000,
  jewellery: 200_000,
};

export type LimitViolation = { code: string; limit: number; attempted: number; source: LimitSource; label: string };

const DAY = 86_400_000;

/**
 * `history` = the customer's past transactions. "New registration" = the customer's first-ever UPI
 * transaction, or the first UPI use of this device, happened less than 24h ago (device re-registration
 * is treated like a new registration — a bank-policy interpretation of the NPCI new-user cap).
 */
export function checkLimits(p: Pick<TxnInput, "amount" | "channel" | "direction" | "merchantCategory" | "deviceId" | "occurredAt">, history: TxnInput[]): LimitViolation[] {
  if (p.direction !== "debit") return [];
  const v: LimitViolation[] = [];
  const past24 = history.filter((h) => h.occurredAt < p.occurredAt && p.occurredAt - h.occurredAt < DAY);
  const add = (code: keyof typeof LIMITS, attempted: number, limit: number = LIMITS[code].value) =>
    v.push({ code: code.toUpperCase(), limit, attempted: Math.round(attempted), source: LIMITS[code].source, label: LIMITS[code].label });

  if (p.channel === "UPI") {
    const isP2P = p.merchantCategory === null;
    if (isP2P) {
      if (p.amount > LIMITS.upiP2pPerTxn.value) add("upiP2pPerTxn", p.amount);
      const rolling = past24.filter((h) => h.channel === "UPI" && h.direction === "debit" && h.merchantCategory === null).reduce((s, h) => s + h.amount, 0) + p.amount;
      if (rolling > LIMITS.upiP2pRolling24h.value && p.amount <= LIMITS.upiP2pPerTxn.value) add("upiP2pRolling24h", rolling);
    } else {
      const cap = UPI_P2M_CATEGORY_CAPS[p.merchantCategory ?? ""] ?? LIMITS.upiP2pPerTxn.value;
      if (p.amount > cap) v.push({ code: "UPI_P2M_PER_TXN", limit: cap, attempted: Math.round(p.amount), source: "NPCI", label: `UPI merchant payment per transaction (${p.merchantCategory})` });
    }
    const upiHistory = history.filter((h) => h.channel === "UPI" && h.occurredAt < p.occurredAt);
    const firstUpi = upiHistory[0]?.occurredAt ?? null;
    const firstOnDevice = upiHistory.find((h) => h.deviceId === p.deviceId)?.occurredAt ?? null;
    const newRegistration = firstUpi === null || p.occurredAt - firstUpi < DAY || firstOnDevice === null || p.occurredAt - firstOnDevice < DAY;
    if (newRegistration) {
      const since = Math.max(firstOnDevice ?? p.occurredAt, p.occurredAt - DAY);
      const used = upiHistory.filter((h) => h.direction === "debit" && h.deviceId === p.deviceId && h.occurredAt >= since).reduce((s, h) => s + h.amount, 0);
      if (used + p.amount > LIMITS.upiNewUser24h.value) add("upiNewUser24h", used + p.amount);
    }
    const count = past24.filter((h) => h.channel === "UPI").length + 1;
    if (count > LIMITS.upiCount24h.value) add("upiCount24h", count);
  }
  if (p.channel === "IMPS" && p.amount > LIMITS.impsPerTxn.value) add("impsPerTxn", p.amount);
  if (p.channel === "ATM") {
    const withdrawn = past24.filter((h) => h.channel === "ATM" && h.direction === "debit").reduce((s, h) => s + h.amount, 0) + p.amount;
    if (withdrawn > LIMITS.atmPerDay.value) add("atmPerDay", withdrawn);
  }
  return v;
}
