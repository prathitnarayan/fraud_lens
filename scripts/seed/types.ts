import type { FraudPattern } from "@/lib/fraud-patterns";
import type { CityName } from "@/lib/geo";

export type Channel = "UPI" | "CARD" | "NETBANKING" | "IMPS" | "ATM";
export type Direction = "debit" | "credit";

export type GenCustomer = {
  id: string;
  externalRef: string; // always "SEED-…" → seed namespace for safe reset
  fullName: string;
  accountMasked: string;
  homeCity: CityName;
  segment: "retail" | "msme";
  kycTier: 1 | 2 | 3;
  /** Generator-only profile (not persisted). */
  devices: string[];
  medianAmount: number;
  txnsPerDay: number;
  contacts: string[];
};

export type GenTxn = {
  id: string;
  customerId: string;
  amount: number;
  channel: Channel;
  direction: Direction;
  counterparty: string;
  merchantCategory: string | null; // null ⇒ person-to-person
  city: CityName;
  deviceId: string;
  occurredAt: number; // epoch ms
};

export type GenLabel = { transactionId: string; pattern: FraudPattern; scenarioRef: string };

/** Manifest entry — generator-side truth for debugging and tests. Not persisted (except scenarioRef). */
export type ScenarioRecord = {
  ref: string;
  kind: "fraud" | "lookalike";
  pattern: FraudPattern;
  description: string;
  customerIds: string[];
  transactionIds: string[];
  params: Record<string, number | string>;
};

export type Dataset = {
  seed: number;
  anchor: number;
  customers: GenCustomer[];
  transactions: GenTxn[];
  labels: GenLabel[];
  scenarios: ScenarioRecord[];
};
