import { describe, expect, it } from "vitest";
import { parseServerEnv } from "@/lib/env";
import { resolveLlmConfig } from "@/lib/llm/client";

const base = { SUPABASE_SERVICE_ROLE_KEY: "x".repeat(40) };

describe("parseServerEnv", () => {
  it("defaults to aipipe and requires a key", () => {
    expect(() => parseServerEnv(base)).toThrow(/LLM_API_KEY/);
    const env = parseServerEnv({ ...base, LLM_API_KEY: "tok" });
    expect(env.llmProvider).toBe("aipipe");
    expect(env.llmTimeoutMs).toBe(12_000);
  });

  it("allows running without an LLM", () => {
    expect(resolveLlmConfig(parseServerEnv({ ...base, LLM_PROVIDER: "none" }))).toBeNull();
  });

  it("treats blank strings as unset", () => {
    expect(() => parseServerEnv({ ...base, LLM_API_KEY: "  " })).toThrow(/LLM_API_KEY/);
  });

  it("accepts the new SUPABASE_SECRET_KEY name", () => {
    const env = parseServerEnv({ SUPABASE_SECRET_KEY: "s".repeat(40), LLM_PROVIDER: "none" });
    expect(env.serviceRoleKey).toHaveLength(40);
  });

  it("rejects missing service key and unknown provider", () => {
    expect(() => parseServerEnv({ LLM_PROVIDER: "none" })).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(() => parseServerEnv({ ...base, LLM_PROVIDER: "gemini", LLM_API_KEY: "k" })).toThrow();
  });

  it("custom provider needs a base URL", () => {
    expect(() => parseServerEnv({ ...base, LLM_PROVIDER: "custom", LLM_API_KEY: "k" })).toThrow(/LLM_BASE_URL/);
  });
});

describe("resolveLlmConfig", () => {
  it("maps aipipe to the OpenRouter proxy", () => {
    const cfg = resolveLlmConfig(parseServerEnv({ ...base, LLM_API_KEY: "tok" }))!;
    expect(cfg.baseUrl).toBe("https://aipipe.org/openrouter/v1");
    expect(cfg.model).toBe("openai/gpt-4.1-nano");
  });

  it("honours overrides and trims trailing slashes", () => {
    const cfg = resolveLlmConfig(
      parseServerEnv({
        ...base,
        LLM_PROVIDER: "openai",
        LLM_API_KEY: "k",
        LLM_MODEL: "gpt-4.1-mini",
        LLM_BASE_URL: "https://proxy.example.com/v1//",
      }),
    )!;
    expect(cfg.baseUrl).toBe("https://proxy.example.com/v1");
    expect(cfg.model).toBe("gpt-4.1-mini");
  });
});
