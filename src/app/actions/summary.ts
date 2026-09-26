"use server";

import { revalidatePath } from "next/cache";
import { loadCase } from "@/lib/ai/case-data";
import { buildCaseContext } from "@/lib/ai/minimize";
import { PROMPT_VERSION, type AiSummaryRecord } from "@/lib/ai/schema";
import { buildAiUpdate, summarizeCase } from "@/lib/ai/summarize";
import { getViewer } from "@/lib/auth";
import { getLlmConfig } from "@/lib/llm/index.server";
import type { LlmConfig } from "@/lib/llm/client";
import { createRateLimiter } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type SummaryState = { ok: boolean; message: string; record: AiSummaryRecord | null };

const limiter = createRateLimiter({ limit: 6, windowMs: 60_000 });

function safeLlmConfig(): LlmConfig | null {
  try {
    return getLlmConfig();
  } catch (e) {
    console.error("LLM config invalid — using deterministic fallback", e);
    return null;
  }
}

/**
 * Generates (or returns the cached) advisory case summary.
 * Access is proven by reading the alert through RLS as the signed-in user; the service-role
 * client is used only to write the ai_* columns and the audit row.
 */
export async function generateSummaryAction(
  alertId: string,
  force: boolean,
  _prev: SummaryState,
): Promise<SummaryState> {
  const viewer = await getViewer();
  if (!viewer?.role) return { ok: false, message: "Not authorised.", record: null };

  const view = await loadCase(await createClient(), alertId);
  if (!view) return { ok: false, message: "Alert not found.", record: null };

  if (!force && view.aiRecord && view.aiRecord.version === PROMPT_VERSION && view.aiRecord.source === "llm") {
    return { ok: true, message: "Cached summary.", record: view.aiRecord };
  }
  if (!limiter(viewer.id).ok) return { ok: false, message: "Too many requests — wait a minute.", record: view.aiRecord };

  const record = await summarizeCase(buildCaseContext(view.input), safeLlmConfig());

  const admin = createAdminClient();
  const { error } = await admin.from("alerts").update(buildAiUpdate(record)).eq("id", alertId);
  if (error) {
    console.error("persist ai summary failed", error);
    return { ok: true, message: "Summary generated but could not be saved.", record };
  }
  await admin.from("audit_log").insert({
    actor_id: viewer.id,
    action: "ai.summary_generated",
    entity_type: "alert",
    entity_id: alertId,
    details: { source: record.source, model: record.model, fallback_reason: record.fallbackReason, latency_ms: record.latencyMs, version: record.version },
  });
  revalidatePath(`/alerts/${alertId}`);
  return {
    ok: true,
    message: record.source === "llm" ? `Generated in ${(record.latencyMs / 1000).toFixed(1)}s` : `AI unavailable (${record.fallbackReason}) — showing rules-based summary`,
    record,
  };
}
