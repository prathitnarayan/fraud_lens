/**
 * Offline evaluation — no database needed.
 *   npm run eval                 # default seed
 *   npm run eval -- --seed 11    # any seed
 */
import { parseArgs } from "node:util";
import { MODEL_FLAG_THRESHOLD, MODEL_VERSION } from "@/lib/models";
import { assessAll } from "@/lib/risk/runner";
import { evaluate, formatReport } from "@/lib/risk/evaluate";
import { RULESET_VERSION } from "@/lib/risk/rules";
import { DEFAULT_SEED, generateDataset } from "../seed/generator";

const { values } = parseArgs({ options: { seed: { type: "string" } } });
const seed = values.seed ? Number.parseInt(values.seed, 10) : DEFAULT_SEED;
const d = generateDataset({ seed });
const started = performance.now();
const { assessments, models } = assessAll(d.transactions);
const ms = performance.now() - started;
const c = evaluate(
  d.transactions.map((t) => t.id),
  assessments.filter((a) => a.alert).map((a) => a.transactionId),
  d.labels,
);
console.log(`seed=${seed}`);
console.log(formatReport(c, RULESET_VERSION));
console.log(`\nEngine time (rules + 3 models): ${ms.toFixed(0)} ms for ${d.transactions.length} transactions`);

// Advisory detector models — shadow mode (never change alerts).
const truth = new Set(d.labels.map((l) => l.transactionId));
console.log(`\nDetector models (${MODEL_VERSION}, advisory, flag ≥ ${MODEL_FLAG_THRESHOLD})`);
console.log("────────────────────────────────────────");
for (const k of ["behaviour", "beneficiary", "network"] as const) {
  const flagged = [...models].filter(([, m]) => m[k].applicable && m[k].score >= MODEL_FLAG_THRESHOLD).map(([id]) => id);
  const tp = flagged.filter((id) => truth.has(id)).length;
  console.log(`${k.padEnd(12)} flagged ${String(flagged.length).padStart(4)} · of which planted fraud ${String(tp).padStart(3)} · precision ${flagged.length ? ((tp / flagged.length) * 100).toFixed(0) : "—"}%`);
}
const agree = { HIGH: 0, MIXED: 0, LOW: 0 };
for (const m of models.values()) agree[m.agreement]++;
const alerted = assessments.filter((a) => a.alert);
const alertAgree = { HIGH: 0, MIXED: 0, LOW: 0 };
for (const a of alerted) alertAgree[models.get(a.transactionId)!.agreement]++;
console.log(`Agreement on alerts: HIGH ${alertAgree.HIGH} · MIXED ${alertAgree.MIXED} · LOW ${alertAgree.LOW}`);
console.log(`Model-only candidates (rules < alert line, a model ≥ ${MODEL_FLAG_THRESHOLD}): ${[...models.values()].filter((m) => m.modelOnly).length}`);
