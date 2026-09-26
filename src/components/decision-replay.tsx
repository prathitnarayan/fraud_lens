import { explainScore, type TimelineEntry, type TrailStep } from "@/lib/replay";
import type { EvidenceItem } from "@/lib/queue-types";
import { SIGNAL_CAP } from "@/lib/risk/rules";

const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const time = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Asia/Kolkata" });

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="relative border-l border-neutral-300 pb-5 pl-6 last:pb-0">
      <span className="absolute -left-3 top-0 flex h-6 w-6 items-center justify-center rounded-full bg-neutral-900 text-xs text-white">{n}</span>
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      {children}
    </li>
  );
}

export function DecisionReplay({
  timeline, evidence, score, severity, rulesetVersion, createdAt, trail,
}: {
  timeline: TimelineEntry[]; evidence: EvidenceItem[]; score: number; severity: string;
  rulesetVersion: string | null; createdAt: string; trail: TrailStep[];
}) {
  const x = explainScore(evidence, score);
  const hasCluster = timeline.some((t) => t.clusters.length > 0);
  return (
    <section className="rounded border border-neutral-200 p-4">
      <h2 className="text-sm font-semibold">Decision replay</h2>
      <p className="mb-4 text-xs text-neutral-500">How this alert came to exist — every step is reproducible from stored evidence.</p>
      <ol>
        <Step n={1} title="What happened">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-neutral-500">
                <tr><th className="py-1 pr-2">Time (IST)</th><th className="pr-2">Who</th><th className="pr-2 text-right">Amount</th><th className="pr-2">Channel · City</th><th className="pr-2">Counterparty</th><th>Flags</th></tr>
              </thead>
              <tbody>
                {timeline.map((t) => (
                  <tr key={t.id} className={`border-t border-neutral-100 ${t.isAlert ? "bg-neutral-100 font-semibold" : ""} ${!t.isAlert && t.clusters.length === 0 ? "text-neutral-400" : ""}`}>
                    <td className="whitespace-nowrap py-1 pr-2 tabular-nums">{time.format(t.occurredAt)}</td>
                    <td className="pr-2">{t.isOtherCustomer ? t.customerRef : "this customer"}</td>
                    <td className="pr-2 text-right tabular-nums">{inr.format(t.amount)} <span className="text-neutral-400">{t.direction === "credit" ? "in" : "out"}</span></td>
                    <td className="pr-2">{t.channel} · {t.city}{t.newCity && <b className="ml-1">NEW CITY</b>}</td>
                    <td className="max-w-40 truncate pr-2" title={t.counterparty}>{t.counterparty}</td>
                    <td className="space-x-1">
                      {t.isAlert && <span className="rounded bg-neutral-900 px-1 text-white">ALERT</span>}
                      {t.newDevice && <span className="rounded border border-neutral-900 px-1">NEW DEVICE</span>}
                      {t.completes.map((c) => <span key={c} className="rounded border border-neutral-900 px-1 font-mono">completes {c}</span>)}
                      {t.clusters.filter((c) => !t.completes.includes(c)).map((c) => <span key={c} className="rounded border border-neutral-300 px-1 font-mono">{c}</span>)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!hasCluster && <p className="mt-1 text-xs text-neutral-500">Faded rows are the customer&apos;s recent normal activity, shown for contrast.</p>}
        </Step>

        <Step n={2} title="Which rules fired">
          <ul className="space-y-1 text-sm">
            {evidence.map((e) => (
              <li key={e.code} className="flex gap-2">
                <span className="w-9 shrink-0 text-right font-mono text-xs">+{e.weight}</span>
                <span><span className="mr-1 font-mono text-[11px]">{e.code}</span><span className="text-neutral-400">{e.pattern ? "pattern" : "signal"}</span> — {e.text}</span>
              </li>
            ))}
          </ul>
        </Step>

        <Step n={3} title="How the score was computed">
          <p className="font-mono text-sm">
            patterns {x.patterns.map((p) => p.weight).join(" + ") || "0"}
            {" + "}signals min({SIGNAL_CAP}, {x.signalSum})
            {" = "}{x.patternSum} + {x.signalCounted}
            {x.cappedAt100 ? ` → capped at 100` : ""}
            {" = "}<b>{x.total}</b>
          </p>
          <p className="mt-1 text-xs text-neutral-500">
            Severity <b>{severity}</b> · ruleset {rulesetVersion ?? "—"} · alerts need ≥ 50 and at least one pattern rule
            {x.signalCapped ? " · supporting signals were capped" : ""}
          </p>
          {!x.consistent && <p role="alert" className="mt-1 text-xs text-red-700">Stored evidence does not reproduce the stored score ({score}). Re-run detection.</p>}
        </Step>

        <Step n={4} title="What people did">
          <ul className="space-y-1 text-sm">
            {trail.length === 0 && <li className="text-neutral-500">Alert created {time.format(Date.parse(createdAt))}. No actions yet.</li>}
            {trail.map((s, i) => (
              <li key={i}>
                <span className="tabular-nums text-xs text-neutral-500">{time.format(Date.parse(s.at))}</span> · <b>{s.actor}</b> {s.label}
                {s.note && <div className="ml-4 border-l border-neutral-300 pl-2 text-xs text-neutral-600">{s.note}</div>}
              </li>
            ))}
          </ul>
        </Step>
      </ol>
    </section>
  );
}
