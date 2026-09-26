import type { CaseModels } from "@/lib/ai/minimize";
import { MODEL_FLAG_THRESHOLD } from "@/lib/models/types";
import { ALERT_THRESHOLD } from "@/lib/risk/rules";

const ROWS = [
  { key: "behaviour", label: "Behaviour model", hint: "unusual for this customer" },
  { key: "beneficiary", label: "Beneficiary model", hint: "where the money is going" },
  { key: "network", label: "Network model", hint: "account money flows" },
] as const;

function Bar({ value, flagged }: { value: number; flagged: boolean }) {
  return (
    <div className="h-2 w-full rounded bg-neutral-100" aria-hidden>
      <div className={`h-2 rounded ${flagged ? "bg-neutral-900" : "bg-neutral-400"}`} style={{ width: `${value}%` }} />
    </div>
  );
}

export function DetectorsCard({ ruleScore, models }: { ruleScore: number; models: CaseModels | null | undefined }) {
  if (!models) {
    return (
      <section className="rounded border border-neutral-200 p-4 text-sm">
        <h2 className="font-semibold">Detectors</h2>
        <p className="text-xs text-neutral-500">Models not scored yet — a supervisor can re-run detection.</p>
      </section>
    );
  }
  const modelFlags = ROWS.filter((r) => (models.scores[r.key] ?? 0) >= MODEL_FLAG_THRESHOLD).length;
  const note =
    models.agreement === "HIGH"
      ? `Rules and ${modelFlags} model${modelFlags === 1 ? "" : "s"} independently flag this.`
      : ruleScore >= ALERT_THRESHOLD
        ? "Only the rules flag this — the models see behaviour close to normal. Worth checking for a false positive."
        : "No detector flags this strongly.";

  return (
    <section className="rounded border border-neutral-200 p-4">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Detectors</h2>
          <p className="text-xs text-neutral-500">Models are advisory — they add context but never change the score</p>
        </div>
        <span className={`rounded px-2 py-0.5 text-xs font-semibold ${models.agreement === "HIGH" ? "bg-neutral-900 text-white" : "border border-neutral-400"}`}>
          Agreement: {models.agreement}
        </span>
      </div>
      <ul className="space-y-3 text-sm">
        <li>
          <div className="flex items-center justify-between"><span>Rules engine <span className="text-xs text-neutral-400">known fraud patterns</span></span><b className="tabular-nums">{ruleScore}</b></div>
          <Bar value={ruleScore} flagged={ruleScore >= ALERT_THRESHOLD} />
        </li>
        {ROWS.map((r) => {
          const score = models.scores[r.key];
          const applicable = models.factors[r.key]?.applicable !== false && score !== null;
          return (
            <li key={r.key}>
              <div className="flex items-center justify-between">
                <span>{r.label} <span className="text-xs text-neutral-400">{r.hint}</span></span>
                <b className="tabular-nums">{applicable ? score : "n/a"}</b>
              </div>
              {applicable && <Bar value={score ?? 0} flagged={(score ?? 0) >= MODEL_FLAG_THRESHOLD} />}
              {applicable && (models.factors[r.key]?.factors.length ?? 0) > 0 && (
                <ul className="mt-1 space-y-0.5 text-xs text-neutral-600">
                  {models.factors[r.key].factors.slice(0, 3).map((f) => <li key={f.key}>· {f.text}</li>)}
                </ul>
              )}
              {!applicable && <p className="text-xs text-neutral-400">Only applies to payments to a person.</p>}
            </li>
          );
        })}
      </ul>
      <p className="mt-3 border-t border-neutral-100 pt-2 text-xs text-neutral-700">{note}</p>
    </section>
  );
}
