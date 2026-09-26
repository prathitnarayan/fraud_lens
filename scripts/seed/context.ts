import type { FraudPattern } from "@/lib/fraud-patterns";
import { createRng, hashSeed, seededUuid, type Rng } from "./rng";
import type { GenCustomer, GenLabel, GenTxn, ScenarioRecord } from "./types";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
const IST_OFFSET = 5.5 * HOUR;

/** Days [0, RECENT_DAYS) are the "live" window where scenarios & look-alikes are placed. */
export const RECENT_DAYS = 4;
export const HISTORY_DAYS = 30;

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** Shared mutable build state. Each scenario gets its own forked RNG for stability. */
export class GenContext {
  readonly transactions: GenTxn[] = [];
  readonly labels: GenLabel[] = [];
  readonly scenarios: ScenarioRecord[] = [];
  /** Customers claimed by a scenario/look-alike — kept out of the recent baseline window. */
  readonly reserved = new Set<string>();
  private readonly pool: GenCustomer[];
  private idCounters = new Map<string, number>();

  constructor(
    readonly seed: number,
    readonly anchor: number,
    readonly customers: GenCustomer[],
  ) {
    this.pool = createRng(hashSeed(seed, "reserve-pool")).shuffle(customers);
  }

  rng(label: string): Rng {
    return createRng(hashSeed(this.seed, label));
  }

  id(ns: string): string {
    const n = (this.idCounters.get(ns) ?? 0) + 1;
    this.idCounters.set(ns, n);
    return seededUuid(this.seed, `${ns}:${n}`);
  }

  /** Claim n distinct, not-yet-used customers (deterministic order). */
  reserve(n: number, filter: (c: GenCustomer) => boolean = () => true): GenCustomer[] {
    const out: GenCustomer[] = [];
    for (const c of this.pool) {
      if (out.length === n) break;
      if (!this.reserved.has(c.id) && filter(c)) out.push(c);
    }
    if (out.length < n) throw new Error(`not enough customers to reserve ${n}`);
    out.forEach((c) => this.reserved.add(c.id));
    return out;
  }

  /**
   * A start time `daysAgo` days before the anchor, in IST hours [fromHour, toHour), such that
   * start + spanMs (the scenario's full duration) still ends before the anchor.
   */
  dayTime(rng: Rng, daysAgo: number, fromHour = 8, toHour = 22, spanMs = 0): number {
    const anchorDayStartUtc = Math.floor((this.anchor + IST_OFFSET) / DAY) * DAY - IST_OFFSET;
    let t = anchorDayStartUtc - daysAgo * DAY + rng.float(fromHour, toHour) * HOUR;
    while (t + spanMs > this.anchor - 10 * MINUTE) t -= DAY;
    return Math.round(t / 1000) * 1000;
  }

  addTxn(ns: string, t: Omit<GenTxn, "id">): GenTxn {
    if (t.occurredAt > this.anchor) throw new Error("transaction after anchor");
    const txn: GenTxn = { ...t, id: this.id(`txn:${ns}`), amount: round2(t.amount) };
    this.transactions.push(txn);
    return txn;
  }

  addScenario(
    rec: Omit<ScenarioRecord, "transactionIds"> & { transactions: GenTxn[]; labelled?: GenTxn[] },
  ): void {
    const { transactions, labelled, ...rest } = rec;
    this.scenarios.push({ ...rest, transactionIds: transactions.map((t) => t.id) });
    if (rec.kind === "fraud") {
      for (const t of labelled ?? transactions) this.label(t, rec.pattern, rec.ref);
    }
  }

  private label(t: GenTxn, pattern: FraudPattern, scenarioRef: string) {
    this.labels.push({ transactionId: t.id, pattern, scenarioRef });
  }
}
