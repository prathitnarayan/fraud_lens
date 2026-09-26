import "server-only";
import { getServerEnv } from "@/lib/env.server";
import { resolveLlmConfig, type LlmConfig } from "@/lib/llm/client";

export function getLlmConfig(): LlmConfig | null {
  return resolveLlmConfig(getServerEnv());
}
