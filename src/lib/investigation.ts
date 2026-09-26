import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CaseView } from "@/lib/ai/case-data";
import { buildNetwork, type Network, type NetTxn } from "@/lib/network";
import { buildTimeline, buildTrail, type AuditRow, type TimelineEntry, type TimelineTxn, type TrailStep } from "@/lib/replay";

type Row = {
  id: string; customer_id: string; amount: number | string; direction: string; channel: string; city: string;
  counterparty: string; merchant_category: string | null; device_id: string; occurred_at: string;
  customers: { external_ref: string } | null;
};
const COLS = "id, customer_id, amount, direction, channel, city, counterparty, merchant_category, device_id, occurred_at, customers(external_ref)";

const toTimeline = (r: Row): TimelineTxn & { merchantCategory: string | null } => ({
  id: r.id,
  customerId: r.customer_id,
  customerRef: r.customers?.external_ref ?? "—",
  amount: Number(r.amount),
  direction: r.direction,
  channel: r.channel,
  city: r.city,
  counterparty: r.counterparty,
  deviceId: r.device_id,
  occurredAt: Date.parse(r.occurred_at),
  merchantCategory: r.merchant_category,
});

export type Investigation = { timeline: TimelineEntry[]; network: Network | null; trail: TrailStep[] };

/** Everything the replay/network/trail needs, read as the signed-in user (RLS applies). */
export async function loadInvestigation(db: SupabaseClient, view: CaseView, viewerId: string): Promise<Investigation> {
  const { input } = view;
  const t = input.txn;
  const alertTxn = {
    id: t.id, customerId: "", customerRef: input.customer.externalRef, amount: t.amount, direction: t.direction,
    channel: t.channel, city: t.city, counterparty: t.counterparty, deviceId: t.deviceId, occurredAt: t.occurredAt,
    merchantCategory: t.merchantCategory,
  };
  const memberIds = [...new Set(input.alert.evidence.flatMap((e) => [...(e.members ?? []), ...(e.via ? [e.via] : [])]))].filter((id) => id !== t.id);
  const windowFrom = new Date(t.occurredAt - 24 * 3600_000).toISOString();
  const windowTo = new Date(t.occurredAt + 24 * 3600_000).toISOString();
  const codes = new Set(input.alert.reasonCodes);
  const isP2PDebit = t.direction === "debit" && t.merchantCategory === null;

  const customerId = input.customer.id;
  alertTxn.customerId = customerId;
  const empty = Promise.resolve({ data: [] as unknown[], error: null });

  const [members, fanIn, passThrough, audit] = await Promise.all([
    memberIds.length ? db.from("transactions").select(COLS).in("id", memberIds.slice(0, 50)) : empty,
    isP2PDebit
      ? db.from("transactions").select(COLS).eq("counterparty", t.counterparty).gte("occurred_at", windowFrom).lte("occurred_at", windowTo).limit(200)
      : empty,
    codes.has("MULE_PASS_THROUGH")
      ? db.from("transactions").select(COLS).eq("customer_id", customerId).is("merchant_category", null)
          .gte("occurred_at", windowFrom).lte("occurred_at", windowTo).limit(200)
      : empty,
    db.from("audit_log").select("id, actor_id, action, details, created_at").eq("entity_type", "alert").eq("entity_id", input.alert.id).order("id").limit(100),
  ]);
  for (const r of [members, fanIn, passThrough, audit]) if (r.error) throw new Error(`investigation: ${r.error.message}`);
  const passRows = passThrough.data as unknown as Row[];

  const own = input.history.map((h) => ({ ...h, customerId, customerRef: input.customer.externalRef }));
  const related = [...(members.data as unknown as Row[]).map(toTimeline), ...own.slice(0, 8)];
  const timeline = buildTimeline(alertTxn, input.alert.evidence, related);

  let network: Network | null = null;
  if (codes.has("MULE_PASS_THROUGH")) network = buildNetwork("pass_through", alertTxn as NetTxn, passRows.map(toTimeline) as NetTxn[]);
  if (!network && isP2PDebit) network = buildNetwork("fan_in", alertTxn as NetTxn, (fanIn.data as unknown as Row[]).map(toTimeline) as NetTxn[]);

  const auditRows = (audit.data ?? []) as AuditRow[];
  const actorIds = [...new Set(auditRows.map((r) => r.actor_id).filter((x): x is string => Boolean(x)))];
  const names = new Map<string, string>();
  if (actorIds.length) {
    const { data } = await db.from("profiles").select("id, full_name, role").in("id", actorIds);
    for (const p of (data ?? []) as { id: string; full_name: string; role: string | null }[]) {
      names.set(p.id, `${p.full_name || "Staff"}${p.role ? ` (${p.role})` : ""}`);
    }
  }
  return { timeline, network, trail: buildTrail(auditRows, names, viewerId) };
}
