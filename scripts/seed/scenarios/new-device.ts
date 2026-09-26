import { MINUTE, type GenContext } from "../context";
import type { GenTxn } from "../types";

/**
 * NEW_DEVICE_HIGH_VALUE — SIM-swap / account takeover: first-ever device + a transfer far above
 * the customer's normal spend to a never-seen beneficiary.
 * Look-alikes: new phone with normal spend; big payment from a known device to a known contact.
 */
export function plantNewDevice(ctx: GenContext): void {
  const rng = ctx.rng("NEW_DEVICE_HIGH_VALUE");
  ctx.reserve(6).forEach((c, v) => {
    const ref = `NEW_DEVICE_HIGH_VALUE-${v + 1}`;
    const device = `dev-new-${ref.toLowerCase()}`;
    const payee = `acct.${ref.slice(-1)}${rng.int(1000, 9999)}@ibl`;
    let t = ctx.dayTime(rng, rng.int(0, 2), 10, 20, 25 * MINUTE);
    const amount = Math.min(500_000, Math.max(60_000, c.medianAmount * rng.float(15, 40)));
    const txns: GenTxn[] = [
      ctx.addTxn("new-device", { customerId: c.id, amount, channel: rng.pick(["IMPS", "NETBANKING"] as const),
        direction: "debit", counterparty: payee, merchantCategory: null, city: c.homeCity, deviceId: device, occurredAt: t }),
    ];
    if (rng.chance(0.5)) {
      t += rng.int(5, 20) * MINUTE;
      txns.push(ctx.addTxn("new-device", { customerId: c.id, amount: Math.max(55_000, amount * rng.float(0.3, 0.6)),
        channel: "IMPS", direction: "debit", counterparty: payee, merchantCategory: null, city: c.homeCity,
        deviceId: device, occurredAt: t }));
    }
    ctx.addScenario({ ref, kind: "fraud", pattern: "NEW_DEVICE_HIGH_VALUE", description: `new device, ₹${Math.round(amount)}`,
      customerIds: [c.id], transactions: txns, params: { amount: Math.round(amount), device } });
  });

  // Look-alike 1: customer switches phone, keeps normal habits.
  ctx.reserve(3).forEach((c, v) => {
    const device = `dev-newphone-${v + 1}-${c.externalRef.toLowerCase()}`;
    const txns: GenTxn[] = [];
    let t = ctx.dayTime(rng, rng.int(0, 2), 9, 12, 10 * 60 * MINUTE);
    for (let i = 0; i < 3; i++) {
      t += rng.int(30, 180) * MINUTE;
      txns.push(ctx.addTxn("new-device-la", { customerId: c.id, amount: c.medianAmount * rng.float(0.5, 1.5), channel: "UPI",
        direction: "debit", counterparty: rng.pick(c.contacts), merchantCategory: null, city: c.homeCity, deviceId: device, occurredAt: t }));
    }
    ctx.addScenario({ ref: `LA-NEWPHONE-${v + 1}`, kind: "lookalike", pattern: "NEW_DEVICE_HIGH_VALUE",
      description: "new phone, normal amounts", customerIds: [c.id], transactions: txns, params: { device } });
  });

  // Look-alike 2: large but legit payment (rent deposit / fees) from known device to known contact.
  ctx.reserve(2).forEach((c, v) => {
    const t = ctx.dayTime(rng, rng.int(0, 2), 10, 18);
    const txn = ctx.addTxn("new-device-la", { customerId: c.id, amount: rng.float(60_000, 120_000), channel: "NETBANKING",
      direction: "debit", counterparty: c.contacts[0], merchantCategory: null, city: c.homeCity, deviceId: c.devices[0], occurredAt: t });
    ctx.addScenario({ ref: `LA-BIGPAY-${v + 1}`, kind: "lookalike", pattern: "NEW_DEVICE_HIGH_VALUE",
      description: "large payment, known device + payee", customerIds: [c.id], transactions: [txn], params: {} });
  });
}
