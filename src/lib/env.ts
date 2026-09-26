import { z } from "zod";

/**
 * Public env — safe in the browser. Next inlines NEXT_PUBLIC_* only when referenced
 * literally, so each key is read by name.
 */
const publicSchema = z.object({
  supabaseUrl: z.url({ error: "NEXT_PUBLIC_SUPABASE_URL missing or invalid" }),
  supabaseKey: z
    .string({ error: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY missing" })
    .min(20, "Supabase publishable key looks invalid"),
});

export function getPublicEnv() {
  return publicSchema.parse({
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    supabaseKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });
}

export const LLM_PROVIDERS = ["aipipe", "openai", "openrouter", "custom", "none"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

const serverSchema = z
  .object({
    serviceRoleKey: z
      .string({ error: "SUPABASE_SERVICE_ROLE_KEY missing" })
      .min(20, "SUPABASE_SERVICE_ROLE_KEY looks invalid"),
    llmProvider: z.enum(LLM_PROVIDERS).default("aipipe"),
    llmApiKey: z.string().optional(),
    llmModel: z.string().min(1).optional(),
    llmBaseUrl: z.url().optional(),
    llmTimeoutMs: z.coerce.number().int().min(1000).max(60_000).default(12_000),
  })
  .superRefine((v, ctx) => {
    if (v.llmProvider !== "none" && !v.llmApiKey) {
      ctx.addIssue({ code: "custom", path: ["llmApiKey"], message: "LLM_API_KEY required unless LLM_PROVIDER=none" });
    }
    if (v.llmProvider === "custom" && !v.llmBaseUrl) {
      ctx.addIssue({ code: "custom", path: ["llmBaseUrl"], message: "LLM_BASE_URL required for LLM_PROVIDER=custom" });
    }
  });

export type ServerEnv = z.infer<typeof serverSchema>;

export function parseServerEnv(env: Record<string, string | undefined>): ServerEnv {
  const blank = (v: string | undefined) => (v && v.trim() !== "" ? v.trim() : undefined);
  return serverSchema.parse({
    serviceRoleKey: blank(env.SUPABASE_SERVICE_ROLE_KEY) ?? blank(env.SUPABASE_SECRET_KEY),
    llmProvider: blank(env.LLM_PROVIDER),
    llmApiKey: blank(env.LLM_API_KEY),
    llmModel: blank(env.LLM_MODEL),
    llmBaseUrl: blank(env.LLM_BASE_URL),
    llmTimeoutMs: blank(env.LLM_TIMEOUT_MS),
  });
}
