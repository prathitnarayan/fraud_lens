import { STRUCTURING_THRESHOLD } from "@/lib/fraud-patterns";
import { CITY_NAMES, type CityName } from "@/lib/geo";
import { DAY, GenContext, HISTORY_DAYS, RECENT_DAYS, round2 } from "./context";
import type { Rng } from "./rng";
import { createRng, hashSeed, seededUuid } from "./rng";
import type { Channel, GenCustomer, GenTxn } from "./types";

const FIRST = ["Aarav", "Vivaan", "Aditya", "Ishaan", "Rohan", "Kabir", "Arjun", "Karan", "Rahul", "Siddharth",
  "Ananya", "Diya", "Priya", "Isha", "Meera", "Kavya", "Neha", "Pooja", "Riya", "Sneha", "Farhan", "Imran",
  "Zoya", "Sana", "Harpreet", "Gurpreet", "Lakshmi", "Venkat", "Suresh", "Divya"] as const;
const LAST = ["Sharma", "Verma", "Iyer", "Nair", "Reddy", "Rao", "Patel", "Shah", "Gupta", "Singh", "Khan",
  "Das", "Mukherjee", "Banerjee", "Menon", "Pillai", "Joshi", "Kulkarni", "Desai", "Chauhan"] as const;
const MSME_SUFFIX = ["Traders", "Enterprises", "Stores", "Textiles", "Foods", "Agencies", "Electricals"] as const;

export const MERCHANTS = [
  ["merchant:swiggy", "food"], ["merchant:zomato", "food"], ["merchant:bigbasket", "grocery"],
  ["merchant:dmart", "grocery"], ["merchant:amazon", "ecommerce"], ["merchant:flipkart", "ecommerce"],
  ["merchant:irctc", "travel"], ["merchant:bescom", "utilities"], ["merchant:jio", "telecom"],
  ["merchant:uber", "transport"], ["merchant:apollo-pharmacy", "health"], ["merchant:hp-petrol", "fuel"],
  ["merchant:bookmyshow", "entertainment"], ["merchant:lic", "insurance"],
] as const;

const HOME_CITY_WEIGHTS: (readonly [CityName, number])[] = CITY_NAMES.map((c, i) => [c, i < 8 ? 10 : 3] as const);
const HANDLES = ["okhdfcbank", "okicici", "oksbi", "ybl", "paytm", "axl"] as const;

export const BASELINE_BAND = { low: 44_000, high: STRUCTURING_THRESHOLD } as const;

export function generateCustomers(seed: number, count: number): GenCustomer[] {
  const rng = createRng(hashSeed(seed, "customers"));
  const msmeCount = Math.round(count * 0.125);
  return Array.from({ length: count }, (_, i) => {
    const segment = i < count - msmeCount ? "retail" : "msme";
    const first = rng.pick(FIRST);
    const last = rng.pick(LAST);
    const n = String(i + 1).padStart(5, "0");
    const deviceCount = rng.chance(0.3) ? 2 : 1;
    return {
      id: seededUuid(seed, `customer:${i}`),
      externalRef: `SEED-${n}`,
      fullName: segment === "retail" ? `${first} ${last}` : `${last} ${rng.pick(MSME_SUFFIX)}`,
      accountMasked: `XXXXXXXX${String(rng.int(0, 9999)).padStart(4, "0")}`,
      homeCity: rng.weighted(HOME_CITY_WEIGHTS),
      segment,
      kycTier: rng.weighted([[1, 1], [2, 5], [3, 4]] as const),
      devices: Array.from({ length: deviceCount }, (_, d) => `dev-${n}-${d}`),
      medianAmount: segment === "retail" ? round2(rng.float(350, 2500)) : round2(rng.float(6000, 22000)),
      txnsPerDay: segment === "retail" ? rng.float(0.4, 1.6) : rng.float(1.5, 4),
      contacts: Array.from(
        { length: rng.int(3, 8) },
        (_, k) => `${rng.pick(FIRST).toLowerCase()}.${n}${k}@${rng.pick(HANDLES)}`,
      ),
    } satisfies GenCustomer;
  });
}

/** Draws one ordinary transaction for a customer at time t (home city, known device). */
export function normalTxn(rng: Rng, c: GenCustomer, t: number): Omit<GenTxn, "id"> {
  const channel: Channel =
    c.segment === "retail"
      ? rng.weighted([["UPI", 62], ["CARD", 20], ["NETBANKING", 6], ["IMPS", 6], ["ATM", 6]] as const)
      : rng.weighted([["UPI", 40], ["CARD", 10], ["NETBANKING", 25], ["IMPS", 22], ["ATM", 3]] as const);
  const deviceId = c.devices.length > 1 && rng.chance(0.25) ? c.devices[1] : c.devices[0];
  const base = { customerId: c.id, city: c.homeCity, deviceId, occurredAt: t };

  let amount = c.medianAmount * Math.exp(0.7 * rng.normal());
  // Keep the ordinary population out of the structuring band so planted STRUCTURING stays the only source.
  if (amount >= BASELINE_BAND.low && amount < BASELINE_BAND.high) amount *= 1.2;
  amount = Math.max(10, amount);

  if (channel === "ATM") {
    return { ...base, channel, direction: "debit", counterparty: `atm:${c.homeCity.toLowerCase()}`,
      merchantCategory: "cash", amount: Math.max(500, Math.round(amount / 100) * 100) };
  }
  if (rng.chance(c.segment === "msme" ? 0.3 : 0.12)) {
    // Inbound credit from a known contact (P2P).
    return { ...base, channel: channel === "CARD" ? "UPI" : channel, direction: "credit",
      counterparty: rng.pick(c.contacts), merchantCategory: null, amount };
  }
  if (channel === "CARD" || (channel === "UPI" && rng.chance(0.55))) {
    const [counterparty, merchantCategory] = rng.pick(MERCHANTS);
    return { ...base, channel, direction: "debit", counterparty, merchantCategory,
      amount: channel === "UPI" && rng.chance(0.6) ? Math.round(amount) : amount };
  }
  return { ...base, channel, direction: "debit", counterparty: rng.pick(c.contacts), merchantCategory: null, amount };
}

/**
 * Fills the remaining transaction budget with ordinary activity spread over the last 30 days.
 * Customers reserved by scenarios only get history *before* the recent window, so their
 * recent activity is fully controlled by their scenario.
 */
export function generateBaseline(ctx: GenContext, budget: number): void {
  if (budget <= 0) throw new Error(`baseline budget must be positive (got ${budget})`);
  const rng = ctx.rng("baseline");
  const totalWeight = ctx.customers.reduce((s, c) => s + c.txnsPerDay, 0);
  const counts = ctx.customers.map((c) => Math.max(1, Math.floor((budget * c.txnsPerDay) / totalWeight)));
  let diff = budget - counts.reduce((s, n) => s + n, 0);
  const order = ctx.customers.map((c, i) => [i, c.txnsPerDay] as const).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  for (let k = 0; diff !== 0; k = (k + 1) % order.length) {
    const i = order[k][0];
    if (diff > 0) { counts[i]++; diff--; } else if (counts[i] > 1) { counts[i]--; diff++; }
  }

  ctx.customers.forEach((c, i) => {
    const minDay = ctx.reserved.has(c.id) ? RECENT_DAYS : 0;
    for (let k = 0; k < counts[i]; k++) {
      const t = ctx.dayTime(rng, rng.int(minDay, HISTORY_DAYS - 1), 7, 23);
      ctx.addTxn("baseline", normalTxn(rng, c, t));
    }
  });
}

export { DAY };
