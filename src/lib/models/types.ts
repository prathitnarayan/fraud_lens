export const MODEL_VERSION = "models-2026.09.26-v1";
export const MODEL_FLAG_THRESHOLD = 60;

export type ModelName = "behaviour" | "beneficiary" | "network";

/** One explainable contribution. `text` never contains identifiers (safe to send to the LLM). */
export type Factor = { key: string; strength: number; weight: number; text: string };

export type ModelResult = {
  model: ModelName;
  applicable: boolean;
  score: number; // 0–100
  factors: Factor[]; // sorted by weighted strength, only those > 0
};

export type Agreement = "HIGH" | "MIXED" | "LOW";

export type ModelScores = {
  version: string;
  behaviour: ModelResult;
  beneficiary: ModelResult;
  network: ModelResult;
  agreement: Agreement;
  /** Models see risk that the rules engine scored below the alert threshold. */
  modelOnly: boolean;
};

export const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

/**
 * Noisy-OR: each factor independently "explains" risk with probability weight × strength.
 * Bounded 0–1, monotonic, and every point of the score is attributable to a named factor.
 */
export function combine(model: ModelName, factors: Factor[], applicable = true): ModelResult {
  const active = factors.filter((f) => f.strength > 0);
  const p = 1 - active.reduce((acc, f) => acc * (1 - clamp01(f.weight) * clamp01(f.strength)), 1);
  return {
    model,
    applicable,
    score: applicable ? Math.round(p * 100) : 0,
    factors: active.sort((a, b) => b.weight * b.strength - a.weight * a.strength || a.key.localeCompare(b.key)),
  };
}
