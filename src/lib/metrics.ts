export type AlertOutcomeRow = { reason_codes: string[]; status: string; created_at: string; resolved_at: string | null };

export type RulePerformance = {
  code: string;
  triggered: number;
  confirmed: number;
  falsePositive: number;
  pending: number;
  /** Confirmed ÷ decided; null until something is decided. */
  precision: number | null;
};

export type OpsSummary = {
  total: number;
  pending: number;
  confirmed: number;
  falsePositive: number;
  medianMinutesToClose: number | null;
  rules: RulePerformance[];
};

/** Learning-loop input: how each reason code performs against analyst dispositions. */
export function computeOps(rows: AlertOutcomeRow[]): OpsSummary {
  const perCode = new Map<string, RulePerformance>();
  const closeTimes: number[] = [];
  let confirmed = 0;
  let falsePositive = 0;
  for (const r of rows) {
    const isConfirmed = r.status === "confirmed_fraud";
    const isFp = r.status === "false_positive";
    if (isConfirmed) confirmed++;
    if (isFp) falsePositive++;
    if ((isConfirmed || isFp) && r.resolved_at) {
      closeTimes.push((Date.parse(r.resolved_at) - Date.parse(r.created_at)) / 60_000);
    }
    for (const code of new Set(r.reason_codes)) {
      const p = perCode.get(code) ?? { code, triggered: 0, confirmed: 0, falsePositive: 0, pending: 0, precision: null };
      p.triggered++;
      if (isConfirmed) p.confirmed++;
      else if (isFp) p.falsePositive++;
      else p.pending++;
      perCode.set(code, p);
    }
  }
  for (const p of perCode.values()) {
    const decided = p.confirmed + p.falsePositive;
    p.precision = decided ? p.confirmed / decided : null;
  }
  closeTimes.sort((a, b) => a - b);
  const mid = closeTimes.length >> 1;
  const median = closeTimes.length === 0 ? null : closeTimes.length % 2 ? closeTimes[mid] : (closeTimes[mid - 1] + closeTimes[mid]) / 2;
  return {
    total: rows.length,
    pending: rows.length - confirmed - falsePositive,
    confirmed,
    falsePositive,
    medianMinutesToClose: median === null ? null : Math.round(median),
    rules: [...perCode.values()].sort((a, b) => b.triggered - a.triggered || a.code.localeCompare(b.code)),
  };
}
