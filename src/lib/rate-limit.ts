/**
 * Fixed-window in-memory limiter. Per-instance only: fine for a single Node server /
 * demo; swap for Redis/Upstash when running multiple instances.
 */
export type RateLimitResult = { ok: boolean; remaining: number; retryAfterMs: number };

export function createRateLimiter(opts: { limit: number; windowMs: number; now?: () => number; maxKeys?: number }) {
  const now = opts.now ?? Date.now;
  const maxKeys = opts.maxKeys ?? 10_000;
  const hits = new Map<string, { count: number; resetAt: number }>();

  return function check(key: string): RateLimitResult {
    const t = now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= t) {
      if (hits.size >= maxKeys) {
        for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
        if (hits.size >= maxKeys) hits.delete(hits.keys().next().value as string);
      }
      entry = { count: 0, resetAt: t + opts.windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    const ok = entry.count <= opts.limit;
    return { ok, remaining: Math.max(0, opts.limit - entry.count), retryAfterMs: ok ? 0 : entry.resetAt - t };
  };
}
