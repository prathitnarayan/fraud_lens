import Link from "next/link";
import { notFound } from "next/navigation";
import { AiSummaryPanel } from "@/components/ai-summary-panel";
import { AppHeader } from "@/components/app-header";
import { DecisionPanel } from "@/components/decision-panel";
import { DecisionReplay } from "@/components/decision-replay";
import { NetworkGraph } from "@/components/network-graph";
import { ACTION_LABELS } from "@/lib/ai/schema";
import { availableDecisions } from "@/lib/decisions";
import { loadInvestigation } from "@/lib/investigation";
import { loadCase } from "@/lib/ai/case-data";
import { buildCaseContext, Pseudonymizer } from "@/lib/ai/minimize";
import { isSupervisor, requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const when = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="rounded border border-neutral-200 p-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      {subtitle && <p className="mb-3 text-xs text-neutral-500">{subtitle}</p>}
      <div className={subtitle ? "" : "mt-3"}>{children}</div>
    </section>
  );
}

function Facts({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-neutral-500">{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export default async function AlertPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireStaff();
  const { id } = await params;
  const db = await createClient();
  const view = await loadCase(db, id);
  if (!view) notFound();
  const investigation = await loadInvestigation(db, view, viewer.id);
  const availability = availableDecisions(view.status, {
    isSupervisor: isSupervisor(viewer.role),
    assignedTo: view.assignedTo,
    viewerId: viewer.id,
  });
  const aiAction = view.aiRecord ? ACTION_LABELS[view.aiRecord.summary.suggested_action] : null;

  const { input } = view;
  const t = input.txn;
  const f = input.features;
  const pseudo = new Pseudonymizer();
  buildCaseContext(input, pseudo);
  const legend = pseudo.legend();

  return (
    <div className="min-h-screen">
      <AppHeader viewer={viewer} />
      <main className="mx-auto max-w-6xl space-y-4 p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <Link href="/" className="text-xs text-neutral-500 hover:underline">← Queue</Link>
            <h1 className="text-lg font-semibold">{input.customer.fullName}</h1>
            <p className="text-xs text-neutral-500">
              {input.customer.externalRef} · {input.customer.accountMasked} · status <b>{view.status.replace("_", " ")}</b>
            </p>
          </div>
          <div className="text-right">
            <div className="text-3xl font-semibold tabular-nums">{input.alert.riskScore}</div>
            <div className="text-xs uppercase text-neutral-500">{input.alert.severity} risk</div>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-4">
            <Card title="Why it was flagged" subtitle={`Rules engine · deterministic · ruleset ${view.rulesetVersion ?? "—"}`}>
              <ul className="space-y-2 text-sm">
                {input.alert.evidence.map((e) => (
                  <li key={e.code} className="flex gap-2">
                    <span className="w-10 shrink-0 text-right font-mono text-xs text-neutral-500">+{e.weight}</span>
                    <span>
                      <span className="mr-1 rounded border border-neutral-300 px-1 font-mono text-[11px]">{e.code}</span>
                      {e.text}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>

            <Card title="Transaction">
              <Facts
                rows={[
                  ["Amount", `${inr.format(t.amount)} ${t.direction}`],
                  ["Channel", t.channel],
                  ["When (IST)", when.format(t.occurredAt)],
                  ["City", t.city],
                  ["Counterparty", <span key="cp" className="break-all">{t.counterparty}</span>],
                  ["Device", t.deviceId],
                ]}
              />
            </Card>

            <Card title="Customer baseline">
              <Facts
                rows={[
                  ["Segment · KYC tier", `${input.customer.segment} · ${input.customer.kycTier}`],
                  ["Home city", input.customer.homeCity],
                  ["Prior transactions", f?.priorCount ?? "—"],
                  ["Usual debit", f?.priorDebitMedian != null ? inr.format(f.priorDebitMedian) : "—"],
                  ["Device", f?.deviceSeenBefore ? `known (${Math.round((f.deviceAgeMinutes ?? 0) / 1440)} days)` : "new"],
                ]}
              />
            </Card>
          </div>

          <div className="space-y-4">
            <DecisionPanel
              alertId={input.alert.id}
              status={view.status}
              availability={availability}
              resolutionNote={view.resolutionNote}
              aiSuggestion={aiAction}
            />
            <AiSummaryPanel alertId={input.alert.id} initial={view.aiRecord} />
            {legend.length > 0 && (
              <details className="rounded border border-neutral-200 p-3 text-xs">
                <summary className="cursor-pointer text-neutral-600">Pseudonym legend (not shared with the AI)</summary>
                <ul className="mt-2 space-y-0.5 font-mono">
                  {legend.map((l) => <li key={l.label}>{l.label} = {l.raw}</li>)}
                </ul>
              </details>
            )}
          </div>
        </div>

        {investigation.network && (
          <Card title="Money network" subtitle="Who else is connected to this money movement (±24h, person-to-person only)">
            <NetworkGraph net={investigation.network} />
          </Card>
        )}

        <DecisionReplay
          timeline={investigation.timeline}
          evidence={input.alert.evidence}
          score={input.alert.riskScore}
          severity={input.alert.severity}
          rulesetVersion={view.rulesetVersion}
          createdAt={view.createdAt}
          trail={investigation.trail}
        />
      </main>
    </div>
  );
}
