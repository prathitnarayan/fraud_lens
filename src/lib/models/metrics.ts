import { ALERT_THRESHOLD } from "@/lib/risk/rules";
import { MODEL_FLAG_THRESHOLD } from "./types";

export type ScoreRow = {
  transaction_id: string;
  score: number;
  behaviour_score: number | null;
  beneficiary_score: number | null;
  network_score: number | null;
};

export type DetectorStat = { detector: string; flagged: number; plantedCaught: number; precision: number | null };

/** Per-detector flag counts and precision vs planted ground truth (supervisor view). */
export function detectorStats(rows: ScoreRow[], truth: ReadonlySet<string>): DetectorStat[] {
  const defs: [string, (r: ScoreRow) => boolean][] = [
    ["Rules engine", (r) => r.score >= ALERT_THRESHOLD],
    ["Behaviour model", (r) => (r.behaviour_score ?? 0) >= MODEL_FLAG_THRESHOLD],
    ["Beneficiary model", (r) => (r.beneficiary_score ?? 0) >= MODEL_FLAG_THRESHOLD],
    ["Network model", (r) => (r.network_score ?? 0) >= MODEL_FLAG_THRESHOLD],
  ];
  return defs.map(([detector, flag]) => {
    const flagged = rows.filter(flag);
    const plantedCaught = flagged.filter((r) => truth.has(r.transaction_id)).length;
    return { detector, flagged: flagged.length, plantedCaught, precision: flagged.length ? plantedCaught / flagged.length : null };
  });
}
