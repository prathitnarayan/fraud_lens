export type Confusion = {
  evaluated: number;
  planted: number;
  alerts: number;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  precision: number;
  recall: number;
  byPattern: Record<string, { planted: number; caught: number }>;
};

/** Transaction-level evaluation of alerts against ground-truth labels. */
export function evaluate(
  allTransactionIds: Iterable<string>,
  alertedIds: Iterable<string>,
  labels: Iterable<{ transactionId: string; pattern: string }>,
): Confusion {
  const all = new Set(allTransactionIds);
  return evaluateFromCount(
    all.size,
    [...alertedIds].filter((id) => all.has(id)),
    [...labels].filter((l) => all.has(l.transactionId)),
  );
}

/** Same metrics when only the population size is known (alerts/labels must be within it). */
export function evaluateFromCount(
  total: number,
  alertedIds: Iterable<string>,
  labels: Iterable<{ transactionId: string; pattern: string }>,
): Confusion {
  const alerted = new Set(alertedIds);
  const labelList = [...labels];
  const truth = new Set(labelList.map((l) => l.transactionId));

  let tp = 0;
  for (const id of alerted) if (truth.has(id)) tp++;
  const fp = alerted.size - tp;
  const fn = truth.size - tp;
  const tn = Math.max(0, total - tp - fp - fn);

  const byPattern: Confusion["byPattern"] = {};
  for (const l of labelList) {
    const b = (byPattern[l.pattern] ??= { planted: 0, caught: 0 });
    b.planted++;
    if (alerted.has(l.transactionId)) b.caught++;
  }
  return {
    evaluated: total,
    planted: truth.size,
    alerts: alerted.size,
    tp, fp, tn, fn,
    precision: alerted.size ? tp / alerted.size : 0,
    recall: truth.size ? tp / truth.size : 0,
    byPattern,
  };
}

export function formatReport(c: Confusion, rulesetVersion: string): string {
  const n = (v: number) => v.toLocaleString("en-IN").padStart(8);
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`.padStart(8);
  const lines = [
    `Risk Engine Evaluation  (ruleset ${rulesetVersion})`,
    "────────────────────────────────────────",
    `Transactions evaluated: ${n(c.evaluated)}`,
    `Planted fraud:          ${n(c.planted)}`,
    "",
    `True positives:         ${n(c.tp)}`,
    `False positives:        ${n(c.fp)}`,
    `True negatives:         ${n(c.tn)}`,
    `False negatives:        ${n(c.fn)}`,
    "",
    `Precision:              ${pct(c.precision)}`,
    `Recall:                 ${pct(c.recall)}`,
    "",
    `Alerts generated:       ${n(c.alerts)}`,
    "",
    "Recall by pattern:",
    ...Object.entries(c.byPattern)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([p, v]) => `  ${p.padEnd(22)} ${String(v.caught).padStart(3)}/${String(v.planted).padEnd(3)}`),
  ];
  return lines.join("\n");
}
