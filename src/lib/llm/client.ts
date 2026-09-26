import type { z } from "zod";
import type { LlmProvider, ServerEnv } from "@/lib/env";

/** OpenAI-compatible chat endpoint config. AI Pipe proxies OpenRouter with a bearer token. */
export const PROVIDER_DEFAULTS: Record<Exclude<LlmProvider, "none" | "custom">, { baseUrl: string; model: string }> = {
  aipipe: { baseUrl: "https://aipipe.org/openrouter/v1", model: "openai/gpt-4.1-nano" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4.1-nano" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-nano" },
};

export type LlmConfig = {
  provider: Exclude<LlmProvider, "none">;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
};

export function resolveLlmConfig(env: ServerEnv): LlmConfig | null {
  if (env.llmProvider === "none" || !env.llmApiKey) return null;
  const defaults =
    env.llmProvider === "custom"
      ? { baseUrl: env.llmBaseUrl!, model: "gpt-4.1-nano" }
      : PROVIDER_DEFAULTS[env.llmProvider];
  return {
    provider: env.llmProvider,
    baseUrl: (env.llmBaseUrl ?? defaults.baseUrl).replace(/\/+$/, ""),
    apiKey: env.llmApiKey,
    model: env.llmModel ?? defaults.model,
    timeoutMs: env.llmTimeoutMs,
  };
}

export type LlmErrorKind = "timeout" | "http" | "rate_limited" | "bad_output" | "network";

export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const body = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(body);
  } catch {
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(body.slice(start, end + 1));
    throw new Error("no JSON object in model output");
  }
}

export type ChatJsonResult<T> = { data: T; model: string; attempts: number; latencyMs: number };

/**
 * Calls the model in JSON mode and validates against `schema`.
 * Retries once on malformed/invalid output, 429 or 5xx. Never retries on 4xx auth errors.
 */
export async function chatJson<T>(
  cfg: LlmConfig,
  messages: ChatMessage[],
  schema: z.ZodType<T>,
  opts: { fetchImpl?: FetchLike; maxTokens?: number; retries?: number } = {},
): Promise<ChatJsonResult<T>> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxAttempts = 1 + (opts.retries ?? 1);
  const started = Date.now();
  let lastError: LlmError = new LlmError("network", "not attempted");

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: cfg.model,
          messages,
          temperature: 0.2,
          max_tokens: opts.maxTokens ?? 700,
          response_format: { type: "json_object" },
        }),
        signal: AbortSignal.timeout(cfg.timeoutMs),
        cache: "no-store",
      });
    } catch (e) {
      const isTimeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      // A timeout already consumed the latency budget — don't retry, fall back.
      throw new LlmError(isTimeout ? "timeout" : "network", isTimeout ? "LLM request timed out" : "LLM network error");
    }

    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      lastError = new LlmError(res.status === 429 ? "rate_limited" : "http", `LLM HTTP ${res.status}`, res.status);
      if (retryable && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 400 * attempt));
        continue;
      }
      throw lastError;
    }

    try {
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[]; model?: string };
      const content = body.choices?.[0]?.message?.content;
      if (!content) throw new Error("empty completion");
      const parsed = schema.safeParse(extractJson(content));
      if (!parsed.success) throw new Error(`schema: ${parsed.error.issues[0]?.message ?? "invalid"}`);
      return { data: parsed.data, model: body.model ?? cfg.model, attempts: attempt, latencyMs: Date.now() - started };
    } catch (e) {
      lastError = new LlmError("bad_output", e instanceof Error ? e.message : "bad output");
      if (attempt < maxAttempts) {
        messages = [
          ...messages,
          { role: "user", content: "Your previous reply was not valid JSON for the required schema. Reply with ONLY the JSON object." },
        ];
      }
    }
  }
  throw lastError;
}
