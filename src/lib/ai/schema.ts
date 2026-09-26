import { z } from "zod";

export const PROMPT_VERSION = "case-summary-v1";

/** Workflow suggestions only — the analyst makes the decision. */
export const SUGGESTED_ACTIONS = [
  "CALL_CUSTOMER_VERIFY",
  "TEMP_BLOCK_AND_ESCALATE",
  "REQUEST_KYC_DOCUMENTS",
  "MONITOR_ACCOUNT",
  "REVIEW_FOR_FALSE_POSITIVE",
] as const;
export type SuggestedAction = (typeof SUGGESTED_ACTIONS)[number];

export const ACTION_LABELS: Record<SuggestedAction, string> = {
  CALL_CUSTOMER_VERIFY: "Call customer to verify",
  TEMP_BLOCK_AND_ESCALATE: "Temporarily block & escalate",
  REQUEST_KYC_DOCUMENTS: "Request KYC / source-of-funds documents",
  MONITOR_ACCOUNT: "Monitor account",
  REVIEW_FOR_FALSE_POSITIVE: "Review as possible false positive",
};

const line = (max: number) => z.string().trim().min(1).max(max);

/**
 * The only shape accepted from the model. Unknown keys (e.g. a model trying to return
 * "risk_score") are stripped by zod and never reach storage or UI.
 */
export const CaseSummarySchema = z.object({
  headline: line(160),
  narrative: line(1200),
  key_facts: z.array(line(200)).min(1).max(6),
  customer_context: line(500),
  benign_explanations: z.array(line(240)).max(4),
  suggested_action: z.enum(SUGGESTED_ACTIONS),
  action_rationale: line(400),
  questions_for_customer: z.array(line(200)).max(4),
  cited_reason_codes: z.array(z.string().min(1).max(40)).min(1).max(13),
});
export type CaseSummary = z.infer<typeof CaseSummarySchema>;

export type FallbackReason =
  | "llm_disabled"
  | "timeout"
  | "rate_limited"
  | "http"
  | "network"
  | "bad_output"
  | "ungrounded";

/** What is persisted in alerts.ai_summary. */
export type AiSummaryRecord = {
  version: string;
  source: "llm" | "fallback";
  model: string | null;
  fallbackReason: FallbackReason | null;
  latencyMs: number;
  generatedAt: string;
  summary: CaseSummary;
};

export const AiSummaryRecordSchema = z.object({
  version: z.string(),
  source: z.enum(["llm", "fallback"]),
  model: z.string().nullable(),
  fallbackReason: z.string().nullable(),
  latencyMs: z.number(),
  generatedAt: z.string(),
  summary: CaseSummarySchema,
});
