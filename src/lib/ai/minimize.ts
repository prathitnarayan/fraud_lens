import type { EvidenceItem } from "@/lib/queue-types";

/** Everything the loader gathers. Contains PII — never sent to the model as-is. */
export type CaseInput = {
  alert: { id: string; riskScore: number; severity: string; reasonCodes: string[]; evidence: EvidenceItem[] };
  txn: {
    id: string;
    amount: number;
    channel: string;
    direction: string;
    counterparty: string;
    merchantCategory: string | null;
    city: string;
    deviceId: string;
    occurredAt: number;
  };
  customer: { id: string; fullName: string; externalRef: string; accountMasked: string; segment: string; kycTier: number; homeCity: string };
  features: {
    priorCount?: number;
    priorDebitMedian?: number | null;
    homeCity?: string | null;
    deviceSeenBefore?: boolean;
    deviceAgeMinutes?: number | null;
  } | null;
  /** Customer's transactions strictly before the alerted one, newest first. */
  history: CaseInput["txn"][];
};

/** What the model sees: amounts, cities, times, categories and pseudonyms — no identifiers. */
export type CaseContext = {
  alert: { risk_score: number; severity: string; reason_codes: string[]; evidence: { code: string; weight: number; text: string }[] };
  transaction: {
    amount_inr: number;
    direction: string;
    channel: string;
    city: string;
    time_ist: string;
    counterparty: string;
    counterparty_type: "merchant" | "person";
    merchant_category: string | null;
    device: string;
  };
  customer_baseline: {
    segment: string;
    kyc_tier: number;
    home_city: string;
    prior_transactions: number | null;
    median_debit_inr: number | null;
    device_seen_before: boolean | null;
    device_age_minutes: number | null;
  };
  recent_activity: {
    minutes_before: number;
    amount_inr: number;
    direction: string;
    channel: string;
    city: string;
    counterparty: string;
    device: string;
  }[];
};

const HANDLE_RE = /[a-z0-9._-]+@[a-z0-9.-]+/gi;
const LONG_NUMBER_RE = /\b\d{6,}\b/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ISO_TS_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z\b/g;

const istTime = (ms: number) =>
  new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(ms);

/** Stable per-case pseudonyms: the same person/device always gets the same label in one context. */
export class Pseudonymizer {
  private people = new Map<string, string>();
  private devices = new Map<string, string>();

  counterparty(raw: string, merchantCategory: string | null): string {
    if (merchantCategory !== null) {
      // Merchants are businesses, not personal data — keep the brand, drop any prefix.
      return raw.replace(/^[a-z]+:/i, "").replace(HANDLE_RE, "[merchant]");
    }
    let label = this.people.get(raw);
    if (!label) {
      label = `person#${this.people.size + 1}`;
      this.people.set(raw, label);
    }
    return label;
  }

  device(raw: string): string {
    let label = this.devices.get(raw);
    if (!label) {
      label = raw.startsWith("pos:") ? `card-terminal#${this.devices.size + 1}` : `device#${this.devices.size + 1}`;
      this.devices.set(raw, label);
    }
    return label;
  }

  /** label → raw identifier, for the analyst-only legend (never sent to the model). */
  legend(): { label: string; raw: string }[] {
    return [...this.people.entries(), ...this.devices.entries()].map(([raw, label]) => ({ label, raw }));
  }

  /** Replace every known raw identifier in free text, then scrub anything identifier-shaped. */
  scrub(text: string): string {
    let out = text;
    const known = [...this.people.entries(), ...this.devices.entries()].sort((a, b) => b[0].length - a[0].length);
    for (const [raw, label] of known) out = out.split(raw).join(label);
    return out
      .replace(UUID_RE, "[id]")
      .replace(ISO_TS_RE, "[time]")
      .replace(HANDLE_RE, "[handle]")
      .replace(LONG_NUMBER_RE, "[number]")
      .replace(/\bdev-[\w-]+/gi, "[device]");
  }
}

/** PII minimizer + LLM context builder. Pure and deterministic. */
export function buildCaseContext(input: CaseInput, p: Pseudonymizer = new Pseudonymizer()): CaseContext {
  const t = input.txn;
  const transaction: CaseContext["transaction"] = {
    amount_inr: Math.round(t.amount),
    direction: t.direction,
    channel: t.channel,
    city: t.city,
    time_ist: istTime(t.occurredAt),
    counterparty: p.counterparty(t.counterparty, t.merchantCategory),
    counterparty_type: t.merchantCategory === null ? "person" : "merchant",
    merchant_category: t.merchantCategory,
    device: p.device(t.deviceId),
  };
  const recent_activity = input.history.slice(0, 12).map((h) => ({
    minutes_before: Math.round((t.occurredAt - h.occurredAt) / 60_000),
    amount_inr: Math.round(h.amount),
    direction: h.direction,
    channel: h.channel,
    city: h.city,
    counterparty: p.counterparty(h.counterparty, h.merchantCategory),
    device: p.device(h.deviceId),
  }));
  // Evidence may mention handles/devices — scrub after all pseudonyms are registered.
  const evidence = input.alert.evidence.map((e) => ({ code: e.code, weight: e.weight, text: p.scrub(e.text) }));
  const f = input.features;
  return {
    alert: { risk_score: input.alert.riskScore, severity: input.alert.severity, reason_codes: [...input.alert.reasonCodes], evidence },
    transaction,
    customer_baseline: {
      segment: input.customer.segment,
      kyc_tier: input.customer.kycTier,
      home_city: input.customer.homeCity,
      prior_transactions: f?.priorCount ?? null,
      median_debit_inr: f?.priorDebitMedian != null ? Math.round(f.priorDebitMedian) : null,
      device_seen_before: f?.deviceSeenBefore ?? null,
      device_age_minutes: f?.deviceAgeMinutes != null ? Math.round(f.deviceAgeMinutes) : null,
    },
    recent_activity,
  };
}
