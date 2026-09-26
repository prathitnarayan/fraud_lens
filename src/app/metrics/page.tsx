import { redirect } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { isSupervisor, requireStaff } from "@/lib/auth";
import { computeOps, type AlertOutcomeRow } from "@/lib/metrics";
import { detectorStats, type ScoreRow } from "@/lib/models/metrics";
import { MODEL_VERSION } from "@/lib/models/types";
import { loadEvaluation } from "@/lib/queue";
import { selectAll } from "@/lib/risk/runner";
import { RULESET_VERSION } from "@/lib/risk/rules";
import { createClient } from "@/lib/supabase/server";

const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(0)}%`);

export default async function MetricsPage() {
  const viewer = await requireStaff();
  if (!isSupervisor(viewer.role)) redirect("/");
  const db = await createClient();
  const [rows, evaluation, scores, labels, candidates] = await Promise.all([
    selectAll<AlertOutcomeRow>(db, "alerts", "reason_codes, status, created_at, resolved_at", "created_at"),
    loadEvaluation(db),
    selectAll<ScoreRow>(db, "risk_assessments", "transaction_id, score, behaviour_score, beneficiary_score, network_score", "transaction_id"),
    selectAll<{ transaction_id: string }>(db, "fraud_labels", "transaction_id", "transaction_id"),
    db
      .from("risk_assessments")
      .select("transaction_id, score, behaviour_score, beneficiary_score, network_score, transactions(amount, channel, city, direction, occurred_at, customers(external_ref))")
      .eq("model_only", true)
      .order("behaviour_score", { ascending: false, nullsFirst: false })
      .limit(25),
  ]);
  if (candidates.error) throw new Error(`candidates: ${candidates.error.message}`);
  const stats = detectorStats(scores, new Set(labels.map((l) => l.transaction_id)));
  type Cand = ScoreRow & { transactions: { amount: number; channel: string; city: string; direction: string; occurred_at: string; customers: { external_ref: string } | null } | null };
  const cands = (candidates.data ?? []) as unknown as Cand[];
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

        <section className="space-y-2">
          <h2 className="font-semibold">Detector comparison</h2>
          <p className="text-xs text-neutral-500">Rules create alerts. Models ({MODEL_VERSION}) run in shadow mode — precision here is against planted demo fraud.</p>
          <table className="w-full text-left text-sm">
            <thead className="border-b border-neutral-200 text-xs uppercase text-neutral-500">
              <tr><th className="py-2">Detector</th><th className="text-right">Flagged</th><th className="text-right">Planted fraud caught</th><th className="text-right">Precision</th></tr>
            </thead>
            <tbody>
              {stats.map((s) => (
                <tr key={s.detector} className="border-b border-neutral-100">
                  <td className="py-2">{s.detector}</td>
                  <td className="text-right tabular-nums">{s.flagged}</td>
                  <td className="text-right tabular-nums">{s.plantedCaught}</td>
                  <td className="text-right font-semibold tabular-nums">{pct(s.precision)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="space-y-2">
          <h2 className="font-semibold">Model-only candidates <span className="text-sm font-normal text-neutral-500">({cands.length}{cands.length === 25 ? "+" : ""})</span></h2>
          <p className="text-xs text-neutral-500">Rules scored these below the alert line, but a model flagged them. This is what promoting a model from shadow to active would add to the queue.</p>
          {cands.length === 0 ? (
            <p className="text-sm text-neutral-500">None.</p>
          ) : (
            <table className="w-full text-left text-xs">
              <thead className="text-neutral-500">
                <tr><th className="py-1">Customer</th><th className="text-right">Amount</th><th>Channel · City</th><th className="text-right">Rules</th><th className="text-right">Behaviour</th><th className="text-right">Beneficiary</th><th className="text-right">Network</th></tr>
              </thead>
              <tbody>
                {cands.map((c) => (
                  <tr key={c.transaction_id} className="border-t border-neutral-100">
                    <td className="py-1">{c.transactions?.customers?.external_ref ?? "—"}</td>
                    <td className="text-right tabular-nums">{c.transactions ? `₹${Math.round(Number(c.transactions.amount)).toLocaleString("en-IN")}` : "—"}</td>
                    <td>{c.transactions?.channel} · {c.transactions?.city}</td>
                    <td className="text-right tabular-nums">{c.score}</td>
                    <td className="text-right tabular-nums">{c.behaviour_score ?? "–"}</td>
                    <td className="text-right tabular-nums">{c.beneficiary_score ?? "–"}</td>
                    <td className="text-right tabular-nums">{c.network_score ?? "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

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
        <p className="text-xs text-neutral-500">Roadmap: analyst decisions → supervised model training (XGBoost/LightGBM) → champion/challenger against these detectors.</p>
      </main>
    </div>
  );
}
