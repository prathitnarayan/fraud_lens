import Link from "next/link";
import { AppHeader } from "@/components/app-header";
import { RunDetectionButton } from "@/components/run-detection-button";
import { isSupervisor, requireStaff } from "@/lib/auth";
import { loadCounts, loadEvaluation, loadQueue, parseTab, QUEUE_TABS, type QueueRow, type QueueTab } from "@/lib/queue";
import { createClient } from "@/lib/supabase/server";

const TAB_LABELS: Record<QueueTab, string> = {
  open: "Open",
  in_review: "In review",
  escalated: "Escalated",
  closed: "Closed",
  all: "All",
};

const SEVERITY_STYLE: Record<QueueRow["severity"], string> = {
  critical: "bg-neutral-900 text-white",
  high: "bg-neutral-700 text-white",
  medium: "bg-neutral-300 text-neutral-900",
  low: "bg-neutral-100 text-neutral-700",
};

const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const when = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

export default async function QueuePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await requireStaff();
  const tab = parseTab((await searchParams).tab);
  const db = await createClient();
  const supervisor = isSupervisor(viewer.role);

  const [rows, counts, evaluation] = await Promise.all([
    loadQueue(db, tab),
    loadCounts(db),
    supervisor ? loadEvaluation(db) : Promise.resolve(null),
  ]);

  return (
    <div className="min-h-screen">
      <AppHeader viewer={viewer} />
      <main className="mx-auto max-w-7xl space-y-6 p-6">
        {supervisor && (
          <section className="flex flex-wrap items-start justify-between gap-4 rounded border border-neutral-200 p-4">
            <div className="space-y-1">
              <h2 className="text-sm font-semibold">Detection</h2>
              <p className="text-xs text-neutral-500">Deterministic ruleset · re-running is safe (existing alerts are untouched)</p>
              <RunDetectionButton />
            </div>
            {evaluation && (
              <dl className="grid grid-cols-3 gap-x-6 gap-y-1 text-xs sm:grid-cols-6" aria-label="Detection quality">
                {[
                  ["Precision", `${(evaluation.precision * 100).toFixed(1)}%`],
                  ["Recall", `${(evaluation.recall * 100).toFixed(1)}%`],
                  ["Alerts", evaluation.alerts],
                  ["True +", evaluation.tp],
                  ["False +", evaluation.fp],
                  ["Missed", evaluation.fn],
                ].map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-neutral-500">{k}</dt>
                    <dd className="text-base font-semibold tabular-nums">{v}</dd>
                  </div>
                ))}
              </dl>
            )}
          </section>
        )}

        <nav className="flex gap-1 border-b border-neutral-200 text-sm" aria-label="Alert status">
          {(Object.keys(QUEUE_TABS) as QueueTab[]).map((t) => (
            <Link
              key={t}
              href={t === "open" ? "/" : `/?tab=${t}`}
              aria-current={t === tab ? "page" : undefined}
              className={`-mb-px border-b-2 px-3 py-2 ${t === tab ? "border-neutral-900 font-medium" : "border-transparent text-neutral-500 hover:text-neutral-900"}`}
            >
              {TAB_LABELS[t]} <span className="tabular-nums text-neutral-400">{counts[t]}</span>
            </Link>
          ))}
        </nav>

        {rows.length === 0 ? (
          <p className="py-12 text-center text-sm text-neutral-500">
            No alerts here.{supervisor && counts.all === 0 ? " Run detection to score transactions." : ""}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-neutral-200 text-xs uppercase text-neutral-500">
                <tr>
                  <th className="py-2 pr-3">Score</th>
                  <th className="py-2 pr-3">Customer</th>
                  <th className="py-2 pr-3 text-right">Amount</th>
                  <th className="py-2 pr-3">Channel · City</th>
                  <th className="py-2 pr-3">When (IST)</th>
                  <th className="py-2 pr-3">Why flagged</th>
                  <th className="py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-neutral-100 align-top">
                    <td className="py-2 pr-3">
                      <span className={`inline-block min-w-12 rounded px-2 py-0.5 text-center text-xs font-semibold tabular-nums ${SEVERITY_STYLE[r.severity]}`}>
                        {r.risk_score}
                      </span>
                      <div className="mt-1 text-[11px] uppercase text-neutral-500">{r.severity}</div>
                    </td>
                    <td className="py-2 pr-3">
                      <div className="font-medium">{r.customers?.full_name ?? "—"}</div>
                      <div className="text-xs text-neutral-500">
                        {r.customers?.external_ref} · {r.customers?.account_masked}
                      </div>
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {r.transactions ? inr.format(r.transactions.amount) : "—"}
                      <div className="text-xs text-neutral-500">{r.transactions?.direction}</div>
                    </td>
                    <td className="py-2 pr-3">
                      {r.transactions?.channel} · {r.transactions?.city}
                      <div className="max-w-48 truncate text-xs text-neutral-500" title={r.transactions?.counterparty}>
                        → {r.transactions?.counterparty}
                      </div>
                    </td>
                    <td className="whitespace-nowrap py-2 pr-3 text-xs">
                      {r.transactions ? when.format(new Date(r.transactions.occurred_at)) : "—"}
                    </td>
                    <td className="py-2 pr-3">
                      <details>
                        <summary className="cursor-pointer list-none">
                          <span className="flex flex-wrap gap-1">
                            {r.reason_codes.map((c) => (
                              <span key={c} className="rounded border border-neutral-300 px-1.5 py-0.5 font-mono text-[11px]">
                                {c}
                              </span>
                            ))}
                          </span>
                        </summary>
                        <ul className="mt-2 space-y-1 text-xs text-neutral-600">
                          {r.evidence.map((e) => (
                            <li key={e.code}>
                              <span className="font-mono">+{e.weight}</span> {e.text}
                            </li>
                          ))}
                        </ul>
                      </details>
                    </td>
                    <td className="py-2 text-xs">{r.status.replace("_", " ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 200 && <p className="mt-2 text-xs text-neutral-500">Showing top 200 by score.</p>}
          </div>
        )}
      </main>
    </div>
  );
}
