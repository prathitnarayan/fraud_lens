import { DAY, HOUR, MINUTE, type GenContext } from "../context";
import type { GenTxn } from "../types";

/**
 * MULE_FAN_IN  — many of our customers (scam victims) pay the SAME external P2P account within hours;
 *                also a mule customer receiving many credits from distinct senders.
 * MULE_FAN_OUT — that mule customer rapidly disperses the money to many new accounts.
 * Look-alikes: payroll credits from one employer to many customers; an MSME collecting sales
 *              and paying suppliers the next day (no rapid pass-through).
 */
export function plantMule(ctx: GenContext): void {
  const rng = ctx.rng("MULE");

  // Fan-in rings: N victims → one external mule handle within 6h.
  for (let r = 1; r <= 2; r++) {
    const muleHandle = `refund.helpdesk${r}${rng.int(100, 999)}@ybl`;
    const victims = ctx.reserve(rng.int(6, 8), (c) => c.segment === "retail");
    const t0 = ctx.dayTime(rng, rng.int(0, 2), 10, 14, 6 * HOUR);
    const txns = victims.map((c) =>
      ctx.addTxn("mule-in", { customerId: c.id, amount: rng.pick([4999, 9999, 14999, 19999, 24999]) + rng.int(0, 1) * 0.5,
        channel: "UPI", direction: "debit", counterparty: muleHandle, merchantCategory: null, city: c.homeCity,
        deviceId: c.devices[0], occurredAt: t0 + rng.int(0, 350) * MINUTE }),
    );
    ctx.addScenario({ ref: `MULE_FAN_IN-RING-${r}`, kind: "fraud", pattern: "MULE_FAN_IN",
      description: `${victims.length} customers → ${muleHandle}`, customerIds: victims.map((c) => c.id),
      transactions: txns, params: { counterparty: muleHandle, victims: victims.length, windowHours: 6 } });
  }

  // Mule customers: fan-in credits, then fan-out debits within ~1.5h of the last credit.
  ctx.reserve(2, (c) => c.segment === "retail" && c.kycTier <= 2).forEach((c, m) => {
    const inbound: GenTxn[] = [];
    let t = ctx.dayTime(rng, rng.int(1, 2), 9, 11, 20 * HOUR);
    const nIn = rng.int(5, 7);
    for (let i = 0; i < nIn; i++) {
      t += rng.int(25, 140) * MINUTE;
      inbound.push(ctx.addTxn("mule-acct", { customerId: c.id, amount: rng.float(15_000, 40_000), channel: "UPI",
        direction: "credit", counterparty: `victim${m}${i}.${rng.int(100, 999)}@okicici`, merchantCategory: null,
        city: c.homeCity, deviceId: c.devices[0], occurredAt: t }));
    }
    const outbound: GenTxn[] = [];
    const nOut = rng.int(4, 6);
    t += rng.int(20, 45) * MINUTE;
    for (let i = 0; i < nOut; i++) {
      t += rng.int(3, 12) * MINUTE;
      outbound.push(ctx.addTxn("mule-acct", { customerId: c.id, amount: rng.float(15_000, 38_000), channel: rng.pick(["IMPS", "UPI"] as const),
        direction: "debit", counterparty: `cashout${m}${i}.${rng.int(100, 999)}@paytm`, merchantCategory: null,
        city: c.homeCity, deviceId: c.devices[0], occurredAt: t }));
    }
    ctx.addScenario({ ref: `MULE_FAN_IN-ACCT-${m + 1}`, kind: "fraud", pattern: "MULE_FAN_IN",
      description: `${nIn} credits from distinct senders`, customerIds: [c.id], transactions: inbound, params: { senders: nIn } });
    ctx.addScenario({ ref: `MULE_FAN_OUT-${m + 1}`, kind: "fraud", pattern: "MULE_FAN_OUT",
      description: `${nOut} rapid transfers to new accounts`, customerIds: [c.id], transactions: outbound,
      params: { receivers: nOut, minutesAfterLastCredit: Math.round((outbound[0].occurredAt - inbound[nIn - 1].occurredAt) / MINUTE) } });
  });

  // Look-alike 1: payroll — one employer credits many (non-reserved) customers on the 1st.
  // Most recent 1st-of-month 10:00 IST inside the history window (fallback: 20 days back).
  const payrollDay = new Date(ctx.anchor);
  payrollDay.setUTCDate(1);
  payrollDay.setUTCHours(4, 30, 0, 0);
  if (payrollDay.getTime() > ctx.anchor - 2 * HOUR || ctx.anchor - payrollDay.getTime() > 28 * DAY) {
    payrollDay.setTime(ctx.dayTime(rng, 20, 10, 11));
  }
  const salaried = ctx.customers.filter((c) => c.segment === "retail" && !ctx.reserved.has(c.id)).slice(0, 20);
  const payroll = salaried.map((c, i) =>
    ctx.addTxn("payroll", { customerId: c.id, amount: rng.float(35_000, 140_000), channel: "NETBANKING", direction: "credit",
      counterparty: "payroll:techcorp-india", merchantCategory: "salary", city: c.homeCity, deviceId: c.devices[0],
      occurredAt: payrollDay.getTime() + i * 1000 }),
  );
  ctx.addScenario({ ref: "LA-PAYROLL", kind: "lookalike", pattern: "MULE_FAN_OUT", description: "employer → 20 salary credits",
    customerIds: salaried.map((c) => c.id), transactions: payroll, params: {} });

  // Look-alike 2: MSME collects sales all day, pays suppliers the next day.
  ctx.reserve(1, (c) => c.segment === "msme").forEach((c) => {
    const txns: GenTxn[] = [];
    let t = ctx.dayTime(rng, 2, 9, 10, 34 * HOUR);
    for (let i = 0; i < 8; i++) {
      t += rng.int(40, 70) * MINUTE;
      txns.push(ctx.addTxn("mule-la", { customerId: c.id, amount: rng.float(800, 6000), channel: "UPI", direction: "credit",
        counterparty: `buyer${i}.${c.externalRef.toLowerCase()}@ybl`, merchantCategory: null, city: c.homeCity,
        deviceId: c.devices[0], occurredAt: t }));
    }
    t += 16 * HOUR;
    for (let i = 0; i < 3; i++) {
      t += rng.int(90, 150) * MINUTE;
      txns.push(ctx.addTxn("mule-la", { customerId: c.id, amount: rng.float(8000, 20000), channel: "NETBANKING", direction: "debit",
        counterparty: c.contacts[i % c.contacts.length], merchantCategory: null, city: c.homeCity, deviceId: c.devices[0], occurredAt: t }));
    }
    ctx.addScenario({ ref: "LA-MSME-COLLECTIONS", kind: "lookalike", pattern: "MULE_FAN_IN",
      description: "8 sales credits, supplier payments next day", customerIds: [c.id], transactions: txns, params: {} });
  });
}
