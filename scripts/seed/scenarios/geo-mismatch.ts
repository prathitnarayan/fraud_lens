import { IMPOSSIBLE_SPEED_KMH } from "@/lib/fraud-patterns";
import { CITY_NAMES, distanceKm, type CityName } from "@/lib/geo";
import { HOUR, MINUTE, type GenContext } from "../context";
import type { Rng } from "../rng";
import type { GenTxn } from "../types";

const farCities = (home: CityName, minKm: number) => CITY_NAMES.filter((c) => distanceKm(home, c) >= minKm);

/**
 * GEO_MISMATCH — cloned card: a normal txn at home, then card-present spend in a city
 * ≥ 800 km away minutes later (implied speed ≫ 900 km/h). Only the remote txns are labelled.
 * Look-alikes: real travellers whose next txn is consistent with a flight.
 */
export function plantGeoMismatch(ctx: GenContext): void {
  const rng = ctx.rng("GEO_MISMATCH");
  ctx.reserve(6).forEach((c, v) => {
    const ref = `GEO_MISMATCH-${v + 1}`;
    const far = rng.pick(farCities(c.homeCity, 800));
    const t0 = ctx.dayTime(rng, rng.int(0, 2), 9, 19, 45 * MINUTE);
    const home = ctx.addTxn("geo", { customerId: c.id, amount: c.medianAmount * rng.float(0.5, 1.2), channel: "UPI",
      direction: "debit", counterparty: "merchant:swiggy", merchantCategory: "food", city: c.homeCity,
      deviceId: c.devices[0], occurredAt: t0 });
    const t1 = t0 + rng.int(4, 25) * MINUTE;
    const remote: GenTxn[] = [
      ctx.addTxn("geo", { customerId: c.id, amount: rng.float(8_000, 42_000), channel: "CARD", direction: "debit",
        counterparty: "merchant:croma", merchantCategory: "electronics", city: far, deviceId: `pos:${far.toLowerCase()}`, occurredAt: t1 }),
    ];
    if (rng.chance(0.5)) {
      remote.push(ctx.addTxn("geo", { customerId: c.id, amount: rng.pick([10_000, 20_000]), channel: "ATM", direction: "debit",
        counterparty: `atm:${far.toLowerCase()}`, merchantCategory: "cash", city: far, deviceId: `pos:${far.toLowerCase()}`,
        occurredAt: t1 + rng.int(3, 12) * MINUTE }));
    }
    const km = Math.round(distanceKm(c.homeCity, far));
    ctx.addScenario({ ref, kind: "fraud", pattern: "GEO_MISMATCH", description: `${c.homeCity} → ${far} (${km} km) in ${(t1 - t0) / MINUTE} min`,
      customerIds: [c.id], transactions: [home, ...remote], labelled: remote,
      params: { from: c.homeCity, to: far, km, minutes: (t1 - t0) / MINUTE, thresholdKmh: IMPOSSIBLE_SPEED_KMH } });
  });

  for (let v = 0; v < 3; v++) plantTraveller(ctx, rng, v);
}

function plantTraveller(ctx: GenContext, rng: Rng, v: number) {
  const [c] = ctx.reserve(1);
  const dest = rng.pick(farCities(c.homeCity, 600));
  const km = distanceKm(c.homeCity, dest);
  const t0 = ctx.dayTime(rng, rng.int(1, 2), 6, 9, 13 * HOUR);
  // Airport buffer + flight at 350–550 km/h ⇒ well under the impossible threshold.
  const t1 = t0 + Math.round((km / rng.float(350, 550)) * HOUR + 1.5 * HOUR);
  const txns = [
    ctx.addTxn("geo-la", { customerId: c.id, amount: rng.float(300, 900), channel: "UPI", direction: "debit",
      counterparty: "merchant:uber", merchantCategory: "transport", city: c.homeCity, deviceId: c.devices[0], occurredAt: t0 }),
    ctx.addTxn("geo-la", { customerId: c.id, amount: rng.float(400, 1500), channel: "CARD", direction: "debit",
      counterparty: "merchant:zomato", merchantCategory: "food", city: dest, deviceId: c.devices[0], occurredAt: t1 }),
    ctx.addTxn("geo-la", { customerId: c.id, amount: rng.float(3000, 9000), channel: "CARD", direction: "debit",
      counterparty: "merchant:irctc", merchantCategory: "travel", city: dest, deviceId: c.devices[0], occurredAt: t1 + 3 * HOUR }),
  ];
  ctx.addScenario({ ref: `LA-TRAVELLER-${v + 1}`, kind: "lookalike", pattern: "GEO_MISMATCH",
    description: `flew ${c.homeCity} → ${dest}`, customerIds: [c.id], transactions: txns, params: { km: Math.round(km) } });
}
