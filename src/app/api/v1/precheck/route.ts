import { NextResponse, type NextRequest } from "next/server";
import { getViewer } from "@/lib/auth";
import { ProposedPayment } from "@/lib/precheck";
import { apiKeyMatches } from "@/lib/api-key";
import { runPrecheck } from "@/lib/precheck-service";
import { createRateLimiter } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";

const limiter = createRateLimiter({ limit: 600, windowMs: 60_000 });

/**
 * Pre-transaction risk check. Called by the payment switch BEFORE funds move.
 * Auth: `Authorization: Bearer $PRECHECK_API_KEY` (bank systems) or a staff session.
 * Stateless: returns a decision; the transaction itself is not stored.
 */
export async function POST(req: NextRequest) {
  const viaKey = apiKeyMatches(req.headers.get("authorization"), process.env.PRECHECK_API_KEY);
  const viewer = viaKey ? null : await getViewer();
  if (!viaKey && !viewer?.role) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const key = viaKey ? "system" : viewer!.id;
  if (!limiter(key).ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = ProposedPayment.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  }

  const out = await runPrecheck(createAdminClient(), parsed.data, viewer?.id ?? null);
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });
  return NextResponse.json({ customerRef: out.customerRef, ...out.result }, { headers: { "Cache-Control": "no-store" } });
}
