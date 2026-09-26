import { MINUTE, type GenContext } from "../context";
import type { GenTxn } from "../types";

/**
 * VELOCITY_BURST — account takeover / card testing: 6–9 debits inside < 5 minutes,
 * at night, to gift-card style merchants the customer has never used.
 * Look-alikes: legit rapid small top-ups (5 in ~10 min) and a busy MSME day.
 */
export function plantVelocity(ctx: GenContext): void {
  const rng = ctx.rng("VELOCITY_BURST");
  ctx.reserve(5, (c) => c.segment === "retail").forEach((c, v) => {
    const ref = `VELOCITY_BURST-${v + 1}`;
    const start = ctx.dayTime(rng, rng.int(0, 2), 1, 5, 6 * MINUTE);
    const n = rng.int(6, 9);
    const txns: GenTxn[] = [];
    let t = start;
    for (let i = 0; i < n; i++) {
      if (i > 0) t += rng.int(12, 32) * 1000;
      txns.push(
        ctx.addTxn("velocity", {
          customerId: c.id, amount: rng.float(1500, 9000), channel: rng.pick(["UPI", "CARD"] as const),
          direction: "debit", counterparty: rng.pick(["merchant:quickgift", "merchant:giftzone", "merchant:voucherhub"]),
          merchantCategory: "gift_cards", city: c.homeCity, deviceId: c.devices[0], occurredAt: t,
        }),
      );
    }
    ctx.addScenario({ ref, kind: "fraud", pattern: "VELOCITY_BURST", description: `${n} debits in ${(t - start) / 1000}s`,
      customerIds: [c.id], transactions: txns, params: { count: n, windowSec: (t - start) / 1000 } });
  });

  // Look-alike 1: legit rapid top-ups (small, known merchant, just under the burst shape).
  ctx.reserve(2, (c) => c.segment === "retail").forEach((c, v) => {
    let t = ctx.dayTime(rng, rng.int(0, 2), 8, 10, 15 * MINUTE);
    const txns: GenTxn[] = [];
    for (let i = 0; i < 5; i++) {
      if (i > 0) t += rng.int(90, 150) * 1000;
      txns.push(ctx.addTxn("velocity-la", { customerId: c.id, amount: rng.pick([50, 100, 200]), channel: "UPI",
        direction: "debit", counterparty: "merchant:uber", merchantCategory: "transport", city: c.homeCity,
        deviceId: c.devices[0], occurredAt: t }));
    }
    ctx.addScenario({ ref: `LA-VELOCITY-${v + 1}`, kind: "lookalike", pattern: "VELOCITY_BURST",
      description: "5 small top-ups over ~8 min", customerIds: [c.id], transactions: txns, params: { count: 5 } });
  });

  // Look-alike 2: busy MSME — many payments in one day, spread out.
  ctx.reserve(1, (c) => c.segment === "msme").forEach((c) => {
    const txns: GenTxn[] = [];
    let t = ctx.dayTime(rng, 1, 9, 10, 11 * 60 * MINUTE);
    for (let i = 0; i < 14; i++) {
      t += rng.int(20, 45) * MINUTE;
      txns.push(ctx.addTxn("velocity-la", { customerId: c.id, amount: rng.float(2000, 15000), channel: "UPI",
        direction: "debit", counterparty: rng.pick(c.contacts), merchantCategory: null, city: c.homeCity,
        deviceId: c.devices[0], occurredAt: t }));
    }
    ctx.addScenario({ ref: "LA-VELOCITY-MSME", kind: "lookalike", pattern: "VELOCITY_BURST",
      description: "14 supplier payments across a working day", customerIds: [c.id], transactions: txns, params: { count: 14 } });
  });
}
