import { generateBaseline, generateCustomers } from "./baseline";
import { GenContext } from "./context";
import { plantGeoMismatch } from "./scenarios/geo-mismatch";
import { plantMule } from "./scenarios/mule";
import { plantNewDevice } from "./scenarios/new-device";
import { plantStructuring } from "./scenarios/structuring";
import { plantVelocity } from "./scenarios/velocity";
import type { Dataset } from "./types";

export const DEFAULT_SEED = 20260926;
/** Noon IST, 26 Sep 2026 — fixed so the same seed always gives identical timestamps. */
export const DEFAULT_ANCHOR = Date.UTC(2026, 8, 26, 6, 30, 0);

export type GenerateOptions = { seed?: number; anchor?: number; customers?: number; transactions?: number };

/** Pipeline: customers → planted scenarios (+ look-alikes) → baseline fills the remaining budget. */
export function generateDataset(opts: GenerateOptions = {}): Dataset {
  const seed = opts.seed ?? DEFAULT_SEED;
  const anchor = Math.floor((opts.anchor ?? DEFAULT_ANCHOR) / 1000) * 1000;
  const total = opts.transactions ?? 5000;
  const customers = generateCustomers(seed, opts.customers ?? 200);
  const ctx = new GenContext(seed, anchor, customers);

  plantVelocity(ctx);
  plantNewDevice(ctx);
  plantGeoMismatch(ctx);
  plantMule(ctx);
  plantStructuring(ctx);

  generateBaseline(ctx, total - ctx.transactions.length);

  const transactions = [...ctx.transactions].sort((a, b) => a.occurredAt - b.occurredAt || a.id.localeCompare(b.id));
  return { seed, anchor, customers, transactions, labels: ctx.labels, scenarios: ctx.scenarios };
}
