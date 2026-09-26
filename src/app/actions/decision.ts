"use server";

import { revalidatePath } from "next/cache";
import { getViewer } from "@/lib/auth";
import { DECISION_TO_STATUS, DecisionInput, describeDbError } from "@/lib/decisions";
import { createRateLimiter } from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";

export type DecisionState = { ok: boolean; message: string };

const limiter = createRateLimiter({ limit: 20, windowMs: 60_000 });

/**
 * Applies an analyst decision as the signed-in user (RLS + DB state machine enforce the rules;
 * the status change is audited by trigger). No service-role client here by design.
 */
export async function decideAction(alertId: string, _prev: DecisionState, form: FormData): Promise<DecisionState> {
  const viewer = await getViewer();
  if (!viewer?.role) return { ok: false, message: "Not authorised." };
  if (!limiter(viewer.id).ok) return { ok: false, message: "Too many actions — slow down." };

  const parsed = DecisionInput.safeParse({
    alertId,
    decision: form.get("decision"),
    note: (form.get("note") as string | null) || undefined,
  });
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Invalid input." };
  const { decision, note } = parsed.data;

  const patch: Record<string, unknown> = { status: DECISION_TO_STATUS[decision] };
  if (decision === "claim") patch.assigned_to = viewer.id;
  if (note) patch.resolution_note = note;

  const db = await createClient();
  const { data, error } = await db.from("alerts").update(patch).eq("id", alertId).select("status").maybeSingle();
  if (error) return { ok: false, message: describeDbError(error.message) };
  if (!data) return { ok: false, message: "Alert not found." };

  revalidatePath(`/alerts/${alertId}`);
  revalidatePath("/");
  return { ok: true, message: `Saved — status is now ${String(data.status).replace("_", " ")}.` };
}
