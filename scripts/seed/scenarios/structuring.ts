import { STRUCTURING_THRESHOLD } from "@/lib/fraud-patterns";
import { DAY, HOUR, MINUTE, type GenContext } from "../context";
import type { GenTxn } from "../types";

/**
 * STRUCTURING — 4–6 debits each just under ₹50,000 inside 24h (collectively far above it),
 * non-round amounts so it isn't trivially "same amount repeated".
 * Look-alikes: a single legit payment just under the threshold; two near-threshold payments days apart.
 */
export function plantStructuring(ctx: GenContext): void {
  const rng = ctx.rng("STRUCTURING");
  ctx.reserve(5).forEach((c, v) => {
    const ref = `STRUCTURING-${v + 1}`;
    const n = rng.int(4, 6);
    const payees = Array.from({ length: rng.int(1, 3) }, (_, k) => `acct.s${v}${k}${rng.int(100, 999)}@axl`);
    let t = ctx.dayTime(rng, rng.int(1, 2), 9, 11, 19 * HOUR);
    const txns: GenTxn[] = [];
    for (let i = 0; i < n; i++) {
      if (i > 0) t += rng.int(30, 220) * MINUTE; // total span ≤ 5×220 min < 24h
      txns.push(ctx.addTxn("structuring", { customerId: c.id, amount: rng.float(45_500, 49_900),
        channel: rng.pick(["IMPS", "NETBANKING"] as const), direction: "debit", counterparty: rng.pick(payees),
        merchantCategory: null, city: c.homeCity, deviceId: c.devices[0], occurredAt: t }));
    }
    const total = txns.reduce((s, x) => s + x.amount, 0);
    ctx.addScenario({ ref, kind: "fraud", pattern: "STRUCTURING", description: `${n} × just-under-₹50k = ₹${Math.round(total)}`,
      customerIds: [c.id], transactions: txns,
      params: { threshold: STRUCTURING_THRESHOLD, windowHours: 24, count: n, total: Math.round(total) } });
  });

  ctx.reserve(2).forEach((c, v) => {
    const txn = ctx.addTxn("structuring-la", { customerId: c.id, amount: rng.float(47_000, 49_900), channel: "NETBANKING",
      direction: "debit", counterparty: c.contacts[0], merchantCategory: null, city: c.homeCity, deviceId: c.devices[0],
      occurredAt: ctx.dayTime(rng, rng.int(0, 2), 10, 18) });
    ctx.addScenario({ ref: `LA-NEAR-THRESHOLD-${v + 1}`, kind: "lookalike", pattern: "STRUCTURING",
      description: "one rent payment just under ₹50k", customerIds: [c.id], transactions: [txn], params: {} });
  });

  ctx.reserve(1, (c) => c.segment === "msme").forEach((c) => {
    const t0 = ctx.dayTime(rng, 2, 10, 12, DAY + 3 * HOUR);
    const txns = [0, 1].map((i) =>
      ctx.addTxn("structuring-la", { customerId: c.id, amount: rng.float(45_000, 49_000), channel: "NETBANKING", direction: "debit",
        counterparty: c.contacts[i % c.contacts.length], merchantCategory: null, city: c.homeCity, deviceId: c.devices[0],
        occurredAt: t0 + i * (DAY + 2 * HOUR) }),
    );
    ctx.addScenario({ ref: "LA-MSME-INVOICES", kind: "lookalike", pattern: "STRUCTURING",
      description: "two supplier invoices ~26h apart", customerIds: [c.id], transactions: txns, params: {} });
  });
}
