import type { Dataset } from "./types";

const q = (v: string | null) => (v === null ? "null" : `'${v.replace(/'/g, "''")}'`);
const ts = (ms: number) => q(new Date(ms).toISOString());

function chunked<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/**
 * Idempotent seed SQL (no BEGIN/COMMIT — the caller owns the transaction).
 * Only touches the SEED- namespace: deleting seed transactions cascades their alerts and labels.
 * audit_log rows are append-only by design and are intentionally left intact.
 */
export function datasetToSql(d: Dataset): string {
  const parts: string[] = [
    "-- FraudLens demo seed (generated). Safe to re-run: resets only SEED-* rows.",
    "delete from public.transactions where customer_id in (select id from public.customers where external_ref like 'SEED-%');",
    "delete from public.customers where external_ref like 'SEED-%';",
  ];
  for (const rows of chunked(d.customers, 500)) {
    parts.push(
      "insert into public.customers (id, external_ref, full_name, account_masked, home_city, segment, kyc_tier) values\n" +
        rows.map((c) => `(${q(c.id)}, ${q(c.externalRef)}, ${q(c.fullName)}, ${q(c.accountMasked)}, ${q(c.homeCity)}, ${q(c.segment)}, ${c.kycTier})`).join(",\n") +
        ";",
    );
  }
  for (const rows of chunked(d.transactions, 500)) {
    parts.push(
      "insert into public.transactions (id, customer_id, amount, channel, direction, counterparty, merchant_category, city, device_id, occurred_at) values\n" +
        rows.map((t) => `(${q(t.id)}, ${q(t.customerId)}, ${t.amount.toFixed(2)}, ${q(t.channel)}, ${q(t.direction)}, ${q(t.counterparty)}, ${q(t.merchantCategory)}, ${q(t.city)}, ${q(t.deviceId)}, ${ts(t.occurredAt)})`).join(",\n") +
        ";",
    );
  }
  for (const rows of chunked(d.labels, 500)) {
    parts.push(
      "insert into public.fraud_labels (transaction_id, pattern, scenario_ref) values\n" +
        rows.map((l) => `(${q(l.transactionId)}, ${q(l.pattern)}, ${q(l.scenarioRef)})`).join(",\n") +
        ";",
    );
  }
  return parts.join("\n\n") + "\n";
}
