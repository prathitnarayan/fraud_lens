"use client";

import { useActionState } from "react";
import { decideAction, type DecisionState } from "@/app/actions/decision";
import type { Availability, Decision } from "@/lib/decisions";

const LABELS: Record<Decision, string> = {
  claim: "Claim for review",
  escalate: "Escalate",
  confirm_fraud: "Confirm fraud",
  false_positive: "Mark false positive",
};

export function DecisionPanel({
  alertId,
  status,
  availability,
  resolutionNote,
  aiSuggestion,
}: {
  alertId: string;
  status: string;
  availability: Availability;
  resolutionNote: string | null;
  aiSuggestion: string | null;
}) {
  const [state, action, pending] = useActionState<DecisionState, FormData>(decideAction.bind(null, alertId), { ok: true, message: "" });
  const closed = status === "confirmed_fraud" || status === "false_positive";

  return (
    <section className="rounded border-2 border-neutral-900 p-4">
      <h2 className="text-sm font-semibold">Your decision</h2>
      <p className="mb-3 text-xs text-neutral-500">
        Status: <b>{status.replace("_", " ")}</b>
        {aiSuggestion && !closed && <> · AI suggested next step: {aiSuggestion} (advisory)</>}
      </p>

      {resolutionNote && (
        <blockquote className="mb-3 border-l-2 border-neutral-300 pl-3 text-sm text-neutral-700">{resolutionNote}</blockquote>
      )}

      {availability.actions.length === 0 ? (
        <p className="text-sm text-neutral-600">{availability.reason}</p>
      ) : (
        <form action={action} className="space-y-3">
          {(availability.noteRequired || availability.actions.includes("escalate")) && (
            <label className="block text-sm">
              <span className="mb-1 block text-neutral-600">
                Note {availability.noteRequired ? "(required, 10+ characters)" : "(required to escalate)"}
              </span>
              <textarea name="note" rows={3} maxLength={2000} className="input" placeholder="What did you verify? What did the customer say?" />
            </label>
          )}
          <div className="flex flex-wrap gap-2">
            {availability.actions.map((d) => (
              <button
                key={d}
                name="decision"
                value={d}
                disabled={pending}
                className={d === "confirm_fraud" || d === "claim" ? "btn-primary" : "btn"}
              >
                {LABELS[d]}
              </button>
            ))}
          </div>
        </form>
      )}
      {state.message && (
        <p role="status" className={`mt-2 text-xs ${state.ok ? "text-neutral-700" : "text-red-700"}`}>
          {state.message}
        </p>
      )}
    </section>
  );
}
