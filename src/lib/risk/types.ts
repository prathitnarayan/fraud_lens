import type { FraudPattern } from "@/lib/fraud-patterns";

/** Engine input — a transaction as stored. The engine knows nothing about how data was produced. */
export type TxnInput = {
  id: string;
  customerId: string;
  amount: number;
  channel: string;
  direction: "debit" | "credit";
  counterparty: string;
  merchantCategory: string | null; // null ⇒ person-to-person
  city: string;
  deviceId: string;
  occurredAt: number; // epoch ms
};

/** Point-in-time features: computed only from data at or before the transaction. */
export type Features = {
  priorCount: number;
  priorDebitMedian: number | null;
  amountRatio: number | null;
  hourIst: number;
  isP2P: boolean;
  // velocity
  debitsLast5m: number;
  velocityWindowSec: number;
  // device
  deviceSeenBefore: boolean;
  deviceAgeMinutes: number | null;
  // geo
  homeCity: string | null;
  kmFromHome: number | null;
  maxSpeedKmh6h: number | null;
  speedWitness: { city: string; minutesAgo: number; km: number } | null;
  // counterparty
  isNewPayee: boolean;
  ringCustomers6h: number;
  creditSenders24h: number;
  minutesSinceLastCredit: number | null;
  distinctP2PPayees2h: number;
  // structuring
  nearThresholdDebits24h: number;
  nearThresholdSum24h: number;
};

export type RuleHit = {
  code: ReasonCode;
  pattern: FraudPattern | null; // null ⇒ supporting signal
  weight: number;
  evidence: string;
  /** For windowed patterns: other transactions that belong to the detected cluster. */
  members?: string[];
  /** Set when this hit was propagated from another transaction's cluster. */
  via?: string;
};

export type Severity = "low" | "medium" | "high" | "critical";

export type Assessment = {
  transactionId: string;
  customerId: string;
  score: number;
  severity: Severity;
  alert: boolean;
  reasonCodes: ReasonCode[];
  hits: RuleHit[];
  features: Features;
  rulesetVersion: string;
};

export const PATTERN_CODES = [
  "VELOCITY_BURST",
  "NEW_DEVICE_HIGH_VALUE",
  "IMPOSSIBLE_TRAVEL",
  "MULE_RING",
  "MULE_PASS_THROUGH",
  "STRUCTURING",
] as const;
export const SIGNAL_CODES = [
  "NEW_DEVICE",
  "NEW_PAYEE",
  "AMOUNT_SPIKE",
  "HIGH_VALUE",
  "ODD_HOUR",
  "FAR_FROM_HOME",
  "NEAR_THRESHOLD",
] as const;
export type ReasonCode = (typeof PATTERN_CODES)[number] | (typeof SIGNAL_CODES)[number];
