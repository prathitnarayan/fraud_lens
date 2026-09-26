import { z } from "zod";

export const DECISIONS = ["claim", "escalate", "confirm_fraud", "false_positive"] as const;
export type Decision = (typeof DECISIONS)[number];

export const DECISION_TO_STATUS: Record<Decision, string> = {
  claim: "in_review",
  escalate: "escalated",
  confirm_fraud: "confirmed_fraud",
  false_positive: "false_positive",
};

export const DecisionInput = z
  .object({
    alertId: z.uuid(),
    decision: z.enum(DECISIONS),
    note: z.string().trim().max(2000).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.decision !== "claim" && (!v.note || v.note.length < 10)) {
      ctx.addIssue({ code: "custom", path: ["note"], message: "Add a note of at least 10 characters." });
    }
  });

/** Maps DB state-machine errors (raised by private.guard_alert_update) to analyst-friendly text. */
export function describeDbError(message: string): string {
  if (message.includes("invalid_transition")) return "That action isn't allowed from the alert's current status (it may have changed — refresh).";
  if (message.includes("note_required")) return "Add a note of at least 10 characters.";
  if (message.includes("not_assignee")) return "Another analyst is working on this alert.";
  if (message.includes("alert_closed")) return "This alert is already closed.";
  if (message.includes("assign_forbidden")) return "You can only assign alerts to yourself.";
  return "Could not save the decision. Try again.";
}

export type Availability = { actions: Decision[]; noteRequired: boolean; reason: string | null };

/** Which decisions the UI offers. The DB trigger remains the source of truth. */
export function availableDecisions(
  status: string,
  opts: { isSupervisor: boolean; assignedTo: string | null; viewerId: string },
): Availability {
  const mine = opts.assignedTo === null || opts.assignedTo === opts.viewerId;
  switch (status) {
    case "open":
      return { actions: ["claim", "escalate"], noteRequired: false, reason: null };
    case "in_review":
      if (!mine && !opts.isSupervisor) return { actions: [], noteRequired: false, reason: "Assigned to another analyst." };
      return { actions: ["confirm_fraud", "false_positive", "escalate"], noteRequired: true, reason: null };
    case "escalated":
      if (!opts.isSupervisor) return { actions: [], noteRequired: false, reason: "Waiting for a supervisor decision." };
      return { actions: ["confirm_fraud", "false_positive"], noteRequired: true, reason: null };
    default:
      return { actions: [], noteRequired: false, reason: "Closed." };
  }
}
