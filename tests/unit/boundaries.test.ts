import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
}
const files = walk(SRC).map((p) => ({ path: relative(process.cwd(), p), text: readFileSync(p, "utf8") }));
const isClient = (t: string) => /^\s*["']use client["']/.test(t);
const isServerAction = (t: string) => /^\s*["']use server["']/.test(t);
const SECRET_MODULES = ["@/lib/supabase/admin", "@/lib/env.server", "@/lib/llm/index.server", "@/lib/supabase/server", "@/lib/ai/case-data", "@/lib/investigation", "@/lib/queue\""];

describe("secret boundaries (static)", () => {
  it("client components never import server-only / secret modules", () => {
    for (const f of files.filter((x) => isClient(x.text))) {
      for (const m of SECRET_MODULES) expect(f.text.includes(`from "${m.replace(/"$/, "")}"`), `${f.path} imports ${m}`).toBe(false);
    }
  });

  it("modules that create privileged clients are marked server-only", () => {
    for (const p of ["src/lib/supabase/admin.ts", "src/lib/supabase/server.ts", "src/lib/env.server.ts", "src/lib/llm/index.server.ts", "src/lib/ai/case-data.ts", "src/lib/investigation.ts", "src/lib/queue.ts", "src/lib/auth.ts"]) {
      const f = files.find((x) => x.path === p)!;
      expect(f, p).toBeDefined();
      expect(f.text, p).toMatch(/^import "server-only";/m);
    }
  });

  it("the service-role client is only used from server actions or server-only modules", () => {
    for (const f of files.filter((x) => x.text.includes("@/lib/supabase/admin"))) {
      const isRouteHandler = /^src\/app\/api\/.+\/route\.ts$/.test(f.path);
      expect(isServerAction(f.text) || isRouteHandler || /^import "server-only";/m.test(f.text), f.path).toBe(true);
    }
  });

  it("every server action authenticates the caller first", () => {
    const actions = files.filter((x) => isServerAction(x.text));
    expect(actions.length).toBeGreaterThanOrEqual(4);
    for (const f of actions) {
      for (const m of f.text.matchAll(/export async function (\w+)\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g)) {
        const [, name, body] = m;
        if (name === "login" || name === "logout") continue;
        expect(/getViewer\(\)|requireStaff\(\)/.test(body), `${f.path}:${name} lacks an auth check`).toBe(true);
      }
    }
  });

  it("every API route authenticates before doing work", () => {
    const routes = files.filter((x) => /^src\/app\/api\/.+\/route\.ts$/.test(x.path));
    expect(routes.length).toBeGreaterThanOrEqual(1);
    for (const r of routes) {
      const body = r.text.slice(r.text.indexOf("export async function"));
      const authAt = Math.min(...["apiKeyMatches(", "getViewer("].map((k) => body.indexOf(k)).filter((i) => i >= 0));
      const workAt = Math.min(...["createAdminClient(", "createClient(", "req.json("].map((k) => body.indexOf(k)).filter((i) => i >= 0));
      expect(Number.isFinite(authAt) && authAt < workAt, `${r.path} must authenticate first`).toBe(true);
      expect(r.text, r.path).toMatch(/status: 401/);
    }
  });

  it("no secret is exposed through a NEXT_PUBLIC_ variable", () => {
    const publicVars = new Set([...files.map((f) => f.text).join("\n").matchAll(/NEXT_PUBLIC_[A-Z_]+/g)].map((m) => m[0]));
    expect([...publicVars].sort()).toEqual(["NEXT_PUBLIC_SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "NEXT_PUBLIC_SUPABASE_URL"]);
  });

  it("no hard-coded credentials in source", () => {
    for (const f of files) {
      expect(f.text, f.path).not.toMatch(/eyJhbGciOi[A-Za-z0-9_-]{20,}/); // JWTs
      expect(f.text, f.path).not.toMatch(/sb_secret_[A-Za-z0-9]{10,}/);
      expect(f.text, f.path).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
    }
  });
});
