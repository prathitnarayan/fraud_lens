import { redirect } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { isSupervisor, requireStaff } from "@/lib/auth";
import { computeOps, type AlertOutcomeRow } from "@/lib/metrics";
import { loadEvaluation } from "@/lib/queue";
import { selectAll } from "@/lib/risk/runner";
import { RULESET_VERSION } from "@/lib/risk/rules";
import { createClient } from "@/lib/supabase/server";

const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(0)}%`);

export default async function MetricsPage() {
  const viewer = await requireStaff();
  if (!isSupervisor(viewer.role)) redirect("/");
  const db = await createClient();
  const [rows, evaluation] = await Promise.all([
    selectAll<AlertOutcomeRow>(db, "alerts", "reason_codes, status, created_at, resolved_at", "created_at"),
    loadEvaluation(db),
  ]);
  const ops = computeOps(rows);

  return (
    <div className="min-h-screen">
      <AppHeader viewer={viewer} />
      <main className="mx-auto max-w-5xl space-y-6 p-6">
        <div>
          <h1 className="text-lg font-semibold">Rule performance</h1>
          <p className="text-xs text-neutral-500">Ruleset {RULESET_VERSION} · outcomes come from analyst decisions — the input for tuning thresholds</p>
        </div>

        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          {[
            ["Alerts", ops.total],
            ["Awaiting decision", ops.pending],
            ["Confirmed fraud", ops.confirmed],
            ["False positives", ops.falsePositive],
            ["Median time to close", ops.medianMinutesToClose === null ? "—" : `${ops.medianMinutesToClose} min`],
          ].map(([k, v]) => (
            <div key={k} className="rounded border border-neutral-200 p-3">
              <dt className="text-xs text-neutral-500">{k}</dt>
              <dd className="text-xl font-semibold tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>

        <table className="w-full text-left text-sm">
          <thead className="border-b border-neutral-200 text-xs uppercase text-neutral-500">
            <tr><th className="py-2">Reason code</th><th className="text-right">Triggered</th><th className="text-right">Confirmed</th><th className="text-right">False +</th><th className="text-right">Pending</th><th className="text-right">Precision (decided)</th></tr>
          </thead>
          <tbody>
            {ops.rules.map((r) => (
              <tr key={r.code} className="border-b border-neutral-100">
                <td className="py-2 font-mono text-xs">{r.code}</td>
                <td className="text-right tabular-nums">{r.triggered}</td>
                <td className="text-right tabular-nums">{r.confirmed}</td>
                <td className="text-right tabular-nums">{r.falsePositive}</td>
                <td className="text-right tabular-nums text-neutral-500">{r.pending}</td>
                <td className="text-right tabular-nums font-semibold">{pct(r.precision)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {evaluation && (
          <section className="rounded border border-neutral-200 p-4 text-sm">
            <h2 className="mb-1 font-semibold">Against planted ground truth (demo data)</h2>
            <p className="text-neutral-600">
              {evaluation.tp} of {evaluation.planted} planted fraud transactions alerted · {evaluation.fp} false positives ·
              precision {pct(evaluation.precision)} · recall {pct(evaluation.recall)}
            </p>
            <ul className="mt-2 grid grid-cols-2 gap-x-6 text-xs text-neutral-600 sm:grid-cols-3">
              {Object.entries(evaluation.byPattern).sort().map(([p, v]) => <li key={p}><span className="font-mono">{p}</span> {v.caught}/{v.planted}</li>)}
            </ul>
          </section>
        )}
        <p className="text-xs text-neutral-500">Roadmap: threshold backtesting, shadow-mode rules and ML signals feed from this table.</p>
      </main>
    </div>
  );
}
