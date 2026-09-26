"use server";

import { revalidatePath } from "next/cache";
import { getViewer, isSupervisor } from "@/lib/auth";
import { createRateLimiter } from "@/lib/rate-limit";
import { runDetection, type RunSummary } from "@/lib/risk/runner";
import { createAdminClient } from "@/lib/supabase/admin";

export type DetectionState = { ok: boolean; message: string; summary?: RunSummary };

const limiter = createRateLimiter({ limit: 1, windowMs: 20_000 });

/** Supervisor-only: runs the deterministic risk engine over all transactions (idempotent). */
export async function runDetectionAction(_prev: DetectionState): Promise<DetectionState> {
  const viewer = await getViewer();
  if (!viewer || !isSupervisor(viewer.role)) return { ok: false, message: "Only supervisors can run detection." };
  if (!limiter(viewer.id).ok) return { ok: false, message: "Detection just ran — wait a few seconds." };

  const admin = createAdminClient();
  try {
    const summary = await runDetection(admin);
    await admin.from("audit_log").insert({
      actor_id: viewer.id,
      action: "risk.run",
      entity_type: "ruleset",
      entity_id: summary.rulesetVersion,
      details: summary,
    });
    revalidatePath("/");
    return {
      ok: true,
      message: `Assessed ${summary.assessed} transactions in ${summary.engineMs} ms · ${summary.alertsCreated} new alerts`,
      summary,
    };
  } catch (e) {
    console.error("runDetection failed", e);
    return { ok: false, message: "Detection failed — check server logs." };
  }
}
