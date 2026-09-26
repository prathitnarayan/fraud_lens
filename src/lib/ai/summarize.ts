import { chatJson, LlmError, type LlmConfig } from "@/lib/llm/client";
import { fallbackSummary } from "./fallback";
import type { CaseContext } from "./minimize";
import { buildMessages } from "./prompt";
import { CaseSummarySchema, PROMPT_VERSION, type AiSummaryRecord, type CaseSummary, type FallbackReason } from "./schema";

type ChatFn = typeof chatJson;

/** Rejects outputs that cite reason codes the rules engine did not produce (hallucination guard). */
export function isGrounded(summary: CaseSummary, ctx: CaseContext): boolean {
  const allowed = new Set(ctx.alert.reason_codes);
  return summary.cited_reason_codes.every((c) => allowed.has(c));
}

/**
 * context → AI Pipe → zod → grounding check → record; any failure → deterministic fallback.
 * Never throws for LLM problems: the analyst always gets a summary.
 */
export async function summarizeCase(
  ctx: CaseContext,
  cfg: LlmConfig | null,
  deps: { chat?: ChatFn; now?: () => number } = {},
): Promise<AiSummaryRecord> {
  const now = deps.now ?? Date.now;
  const started = now();
  const fallback = (reason: FallbackReason): AiSummaryRecord => ({
    version: PROMPT_VERSION,
    source: "fallback",
    model: null,
    fallbackReason: reason,
    latencyMs: now() - started,
    generatedAt: new Date(now()).toISOString(),
    summary: fallbackSummary(ctx),
  });

  if (!cfg) return fallback("llm_disabled");
  try {
    const res = await (deps.chat ?? chatJson)(cfg, buildMessages(ctx), CaseSummarySchema, { maxTokens: 900 });
    if (!isGrounded(res.data, ctx)) return fallback("ungrounded");
    return {
      version: PROMPT_VERSION,
      source: "llm",
      model: res.model,
      fallbackReason: null,
      latencyMs: now() - started,
      generatedAt: new Date(now()).toISOString(),
      summary: res.data,
    };
  } catch (e) {
    if (e instanceof LlmError) {
      const map: Record<LlmError["kind"], FallbackReason> = {
        timeout: "timeout",
        rate_limited: "rate_limited",
        http: "http",
        network: "network",
        bad_output: "bad_output",
      };
      return fallback(map[e.kind]);
    }
    return fallback("network");
  }
}

/**
 * The ONLY columns the AI layer may write. Scoring fields (risk_score, severity, reason_codes,
 * evidence, ruleset_version) and the analyst decision (status, resolution_note) are excluded by construction.
 */
export const AI_WRITABLE_COLUMNS = ["ai_summary", "ai_model", "ai_generated_at"] as const;

export function buildAiUpdate(record: AiSummaryRecord): Record<(typeof AI_WRITABLE_COLUMNS)[number], unknown> {
  return {
    ai_summary: record,
    ai_model: record.source === "llm" ? record.model : `fallback:${record.fallbackReason}`,
    ai_generated_at: record.generatedAt,
  };
}
