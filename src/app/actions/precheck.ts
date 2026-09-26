"use server";

import { getViewer } from "@/lib/auth";
import { ProposedPayment, type PrecheckResult } from "@/lib/precheck";
import { runPrecheck } from "@/lib/precheck-service";
import { createRateLimiter } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";

export type PrecheckState = { ok: boolean; message: string; result: PrecheckResult | null };

const limiter = createRateLimiter({ limit: 30, windowMs: 60_000 });

/** Staff simulator for the pre-transaction check (same service as the API). */
export async function precheckAction(_prev: PrecheckState, form: FormData): Promise<PrecheckState> {
  const viewer = await getViewer();
  if (!viewer?.role) return { ok: false, message: "Not authorised.", result: null };
  if (!limiter(viewer.id).ok) return { ok: false, message: "Too many checks — wait a moment.", result: null };

  const merchant = String(form.get("merchantCategory") ?? "").trim();
  const parsed = ProposedPayment.safeParse({
    customerRef: form.get("customerRef"),
    amount: Number(form.get("amount")),
    channel: form.get("channel"),
    counterparty: form.get("counterparty"),
    merchantCategory: merchant === "" ? null : merchant,
    city: form.get("city"),
    deviceId: form.get("deviceId"),
  });
  if (!parsed.success) return { ok: false, message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), result: null };

  const out = await runPrecheck(createAdminClient(), parsed.data, viewer.id);
  if (!out.ok) return { ok: false, message: out.error, result: null };
  return { ok: true, message: "", result: out.result };
}
