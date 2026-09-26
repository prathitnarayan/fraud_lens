/**
 * Offline evaluation — no database needed.
 *   npm run eval                 # default seed
 *   npm run eval -- --seed 11    # any seed
 */
import { parseArgs } from "node:util";
import { assessTransactions } from "@/lib/risk/engine";
import { evaluate, formatReport } from "@/lib/risk/evaluate";
import { RULESET_VERSION } from "@/lib/risk/rules";
import { DEFAULT_SEED, generateDataset } from "../seed/generator";

const { values } = parseArgs({ options: { seed: { type: "string" } } });
const seed = values.seed ? Number.parseInt(values.seed, 10) : DEFAULT_SEED;
const d = generateDataset({ seed });
const started = performance.now();
const assessments = assessTransactions(d.transactions);
const ms = performance.now() - started;
const c = evaluate(
  d.transactions.map((t) => t.id),
  assessments.filter((a) => a.alert).map((a) => a.transactionId),
  d.labels,
);
console.log(`seed=${seed}`);
console.log(formatReport(c, RULESET_VERSION));
console.log(`\nEngine time: ${ms.toFixed(0)} ms for ${d.transactions.length} transactions`);
