import { FRAUD_PATTERNS, type FraudPattern } from "@/lib/fraud-patterns";
import type { Dataset } from "./types";

export type Manifest = {
  seed: number;
  anchor: string;
  customers: number;
  transactions: number;
  labelledTransactions: number;
  fraudRatePct: number;
  patterns: Record<FraudPattern, { scenarios: number; labelled: number; lookalikes: number }>;
  scenarios: { ref: string; kind: string; pattern: FraudPattern; description: string; txns: number }[];
};

export function buildManifest(d: Dataset): Manifest {
  const patterns = Object.fromEntries(
    FRAUD_PATTERNS.map((p) => [p, { scenarios: 0, labelled: 0, lookalikes: 0 }]),
  ) as Manifest["patterns"];
  for (const s of d.scenarios) {
    if (s.kind === "fraud") patterns[s.pattern].scenarios++;
    else patterns[s.pattern].lookalikes++;
  }
  for (const l of d.labels) patterns[l.pattern].labelled++;
  return {
    seed: d.seed,
    anchor: new Date(d.anchor).toISOString(),
    customers: d.customers.length,
    transactions: d.transactions.length,
    labelledTransactions: d.labels.length,
    fraudRatePct: Math.round((d.labels.length / d.transactions.length) * 10000) / 100,
    patterns,
    scenarios: d.scenarios.map((s) => ({ ref: s.ref, kind: s.kind, pattern: s.pattern, description: s.description, txns: s.transactionIds.length })),
  };
}

export function formatManifest(m: Manifest): string {
  const rows = Object.entries(m.patterns).map(
    ([p, v]) => `  ${p.padEnd(22)} scenarios=${String(v.scenarios).padStart(2)}  labelled=${String(v.labelled).padStart(3)}  look-alikes=${v.lookalikes}`,
  );
  return [
    `seed=${m.seed} anchor=${m.anchor}`,
    `customers=${m.customers} transactions=${m.transactions} labelled=${m.labelledTransactions} (${m.fraudRatePct}%)`,
    ...rows,
  ].join("\n");
}
