import { describe, expect, it } from "vitest";
import { createRateLimiter } from "@/lib/rate-limit";
import { isPublicPath } from "@/lib/supabase/proxy";

describe("createRateLimiter", () => {
  it("blocks after the limit and resets after the window", () => {
    let t = 0;
    const check = createRateLimiter({ limit: 2, windowMs: 1000, now: () => t });
    expect(check("a").ok).toBe(true);
    expect(check("a").ok).toBe(true);
    const blocked = check("a");
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterMs).toBe(1000);
    expect(check("b").ok).toBe(true);
    t = 1000;
    expect(check("a").ok).toBe(true);
  });

  it("caps memory at maxKeys", () => {
    const check = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 3 });
    for (let i = 0; i < 10; i++) expect(check(`k${i}`).ok).toBe(true);
  });
});

describe("isPublicPath", () => {
  it("only allows login/auth prefixes", () => {
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/auth/callback")).toBe(true);
    expect(isPublicPath("/loginx")).toBe(false);
    expect(isPublicPath("/")).toBe(false);
    expect(isPublicPath("/api/alerts")).toBe(false);
  });
});
