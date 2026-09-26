/**
 * Runs the risk engine against Supabase and prints the evaluation.
 *   npm run risk -- --confirm-demo      (reads .env.local)
 */
import { createClient } from "@supabase/supabase-js";
import { evaluate, formatReport } from "@/lib/risk/evaluate";
import { runDetection, selectAll } from "@/lib/risk/runner";

async function main() {
  if (!process.argv.includes("--confirm-demo")) throw new Error("pass --confirm-demo to write assessments/alerts");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const summary = await runDetection(db);
  console.log(`assessed=${summary.assessed} new_alerts=${summary.alertsCreated} engine=${summary.engineMs}ms ruleset=${summary.rulesetVersion}\n`);

  const [labels, alerts, txns] = await Promise.all([
    selectAll<{ transaction_id: string; pattern: string }>(db, "fraud_labels", "transaction_id, pattern", "transaction_id"),
    selectAll<{ transaction_id: string }>(db, "alerts", "transaction_id", "transaction_id"),
    selectAll<{ id: string }>(db, "transactions", "id", "id"),
  ]);
  const c = evaluate(
    txns.map((t) => t.id),
    alerts.map((a) => a.transaction_id),
    labels.map((l) => ({ transactionId: l.transaction_id, pattern: l.pattern })),
  );
  console.log(formatReport(c, summary.rulesetVersion));
}

main().catch((e: unknown) => {
  console.error(`risk run failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
