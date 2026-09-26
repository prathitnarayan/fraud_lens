"use client";

import { useActionState } from "react";
import { generateSummaryAction, type SummaryState } from "@/app/actions/summary";
import { ACTION_LABELS, type AiSummaryRecord } from "@/lib/ai/schema";

export function AiSummaryPanel({ alertId, initial }: { alertId: string; initial: AiSummaryRecord | null }) {
  const [state, generate, pending] = useActionState<SummaryState>(
    generateSummaryAction.bind(null, alertId, false),
    { ok: true, message: "", record: initial },
  );
  const [regenState, regenerate, regenPending] = useActionState<SummaryState>(
    generateSummaryAction.bind(null, alertId, true),
    { ok: true, message: "", record: null },
  );
  const record = regenState.record ?? state.record;
  const message = regenState.message || state.message;
  const busy = pending || regenPending;
  const s = record?.summary;

  return (
    <section className="rounded border border-neutral-300 p-4" aria-busy={busy}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">AI investigation brief</h2>
          <p className="text-xs text-neutral-500">Advisory only · cannot change score, reasons or your decision</p>
        </div>
        <div className="flex items-center gap-2">
          {!record ? (
            <form action={generate}>
              <button className="btn-primary" disabled={busy}>{busy ? "Summarising…" : "Generate summary"}</button>
            </form>
          ) : (
            <form action={regenerate}>
              <button className="btn" disabled={busy}>{busy ? "Summarising…" : "Regenerate"}</button>
            </form>
          )}
        </div>
      </div>

      {message && <p role="status" className="mb-2 text-xs text-neutral-600">{message}</p>}

      {busy && !s && (
        <div className="space-y-2" aria-hidden>
          {[80, 95, 60].map((w) => <div key={w} className="h-3 animate-pulse rounded bg-neutral-200" style={{ width: `${w}%` }} />)}
        </div>
      )}

      {s && record && (
        <div className={`space-y-3 text-sm ${busy ? "opacity-50" : ""}`}>
          <div className="flex flex-wrap gap-2 text-[11px]">
            <span className="rounded border border-neutral-300 px-1.5 py-0.5">
              {record.source === "llm" ? `AI · ${record.model}` : `Rules-based fallback · ${record.fallbackReason}`}
            </span>
            <span className="rounded border border-neutral-300 px-1.5 py-0.5">{record.version}</span>
            <span className="rounded border border-neutral-300 px-1.5 py-0.5">{(record.latencyMs / 1000).toFixed(1)}s</span>
          </div>
          <p className="font-medium">{s.headline}</p>
          <p className="text-neutral-700">{s.narrative}</p>
          <div>
            <h3 className="text-xs font-semibold uppercase text-neutral-500">Key facts</h3>
            <ul className="list-disc pl-5 text-neutral-700">{s.key_facts.map((f) => <li key={f}>{f}</li>)}</ul>
          </div>
          <p className="text-neutral-700"><span className="text-xs font-semibold uppercase text-neutral-500">Customer context · </span>{s.customer_context}</p>
          <div className="rounded bg-neutral-100 p-3">
            <div className="text-xs uppercase text-neutral-500">Suggested next step</div>
            <div className="font-semibold">{ACTION_LABELS[s.suggested_action]}</div>
            <div className="text-xs text-neutral-600">{s.action_rationale}</div>
          </div>
          {s.benign_explanations.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold uppercase text-neutral-500">Rule out first</h3>
              <ul className="list-disc pl-5 text-neutral-700">{s.benign_explanations.map((b) => <li key={b}>{b}</li>)}</ul>
            </div>
          )}
          {s.questions_for_customer.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold uppercase text-neutral-500">Ask the customer</h3>
              <ul className="list-disc pl-5 text-neutral-700">{s.questions_for_customer.map((q) => <li key={q}>{q}</li>)}</ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
