export type NetTxn = { id: string; customerId: string; customerRef: string; amount: number; direction: string; counterparty: string; merchantCategory: string | null; occurredAt: number };

export type NetNode = { id: string; label: string; kind: "customer" | "external" | "center"; highlight: boolean };
export type NetEdge = { from: string; to: string; amount: number; count: number; highlight: boolean };
export type Network = { mode: "fan_in" | "pass_through"; title: string; left: NetNode[]; center: NetNode; right: NetNode[]; edges: NetEdge[] };

const WINDOW = 24 * 3600_000;

/**
 * Two views:
 *  - fan_in: many customers → one external P2P counterparty (mule collection account)
 *  - pass_through: external senders → this customer → external recipients (money mule)
 * Returns null when there's no meaningful network (fewer than 2 parties on the busy side).
 */
export function buildNetwork(
  mode: "fan_in" | "pass_through",
  alertTxn: NetTxn,
  txns: NetTxn[],
): Network | null {
  const inWindow = txns.filter((t) => Math.abs(t.occurredAt - alertTxn.occurredAt) <= WINDOW && t.merchantCategory === null);

  if (mode === "fan_in") {
    const payments = inWindow.filter((t) => t.direction === "debit" && t.counterparty === alertTxn.counterparty);
    const byCustomer = new Map<string, { ref: string; amount: number; count: number; hasAlert: boolean }>();
    for (const t of payments) {
      const e = byCustomer.get(t.customerId) ?? { ref: t.customerRef, amount: 0, count: 0, hasAlert: false };
      e.amount += t.amount;
      e.count++;
      e.hasAlert ||= t.id === alertTxn.id;
      byCustomer.set(t.customerId, e);
    }
    if (byCustomer.size < 2) return null;
    const center: NetNode = { id: "center", label: alertTxn.counterparty, kind: "center", highlight: true };
    const left = [...byCustomer.entries()]
      .sort((a, b) => a[1].ref.localeCompare(b[1].ref))
      .map(([id, e]) => ({ id, label: e.ref, kind: "customer" as const, highlight: e.hasAlert }));
    return {
      mode,
      title: `${byCustomer.size} customers paid ${alertTxn.counterparty} within 24h`,
      left,
      center,
      right: [],
      edges: left.map((n) => {
        const e = byCustomer.get(n.id)!;
        return { from: n.id, to: "center", amount: Math.round(e.amount), count: e.count, highlight: e.hasAlert };
      }),
    };
  }

  const own = inWindow.filter((t) => t.customerId === alertTxn.customerId);
  const agg = (dir: "credit" | "debit") => {
    const m = new Map<string, { amount: number; count: number; hasAlert: boolean }>();
    for (const t of own.filter((x) => x.direction === dir)) {
      const e = m.get(t.counterparty) ?? { amount: 0, count: 0, hasAlert: false };
      e.amount += t.amount;
      e.count++;
      e.hasAlert ||= t.id === alertTxn.id;
      m.set(t.counterparty, e);
    }
    return m;
  };
  const senders = agg("credit");
  const recipients = agg("debit");
  if (senders.size < 2 && recipients.size < 2) return null;
  const center: NetNode = { id: "center", label: alertTxn.customerRef, kind: "center", highlight: true };
  const node = (cp: string, hl: boolean): NetNode => ({ id: `cp:${cp}`, label: cp, kind: "external", highlight: hl });
  const left = [...senders.entries()].sort().map(([cp, e]) => node(cp, e.hasAlert));
  const right = [...recipients.entries()].sort().map(([cp, e]) => node(cp, e.hasAlert));
  const inTotal = [...senders.values()].reduce((s, e) => s + e.amount, 0);
  const outTotal = [...recipients.values()].reduce((s, e) => s + e.amount, 0);
  return {
    mode,
    title: `₹${Math.round(inTotal).toLocaleString("en-IN")} in from ${senders.size} senders → ₹${Math.round(outTotal).toLocaleString("en-IN")} out to ${recipients.size} accounts (24h)`,
    left,
    center,
    right,
    edges: [
      ...left.map((n) => {
        const e = senders.get(n.label)!;
        return { from: n.id, to: "center", amount: Math.round(e.amount), count: e.count, highlight: e.hasAlert };
      }),
      ...right.map((n) => {
        const e = recipients.get(n.label)!;
        return { from: "center", to: n.id, amount: Math.round(e.amount), count: e.count, highlight: e.hasAlert };
      }),
    ],
  };
}
