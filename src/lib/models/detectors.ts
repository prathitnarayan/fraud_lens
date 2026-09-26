import { distanceKm, isKnownCity } from "@/lib/geo";
import { byTime, HOUR, median, MIN } from "@/lib/risk/features";
import type { TxnInput } from "@/lib/risk/types";
import { clamp01, combine, type Factor, type ModelResult } from "./types";

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const IST = 5.5 * HOUR;
const hourIst = (ms: number) => Math.floor(((ms + IST) % (24 * HOUR)) / HOUR);
const isP2P = (t: TxnInput) => t.merchantCategory === null;
const within = (t: TxnInput, p: TxnInput, ms: number) => t.occurredAt - p.occurredAt <= ms;

/**
 * BEHAVIOUR — "how unusual is this for THIS customer?"
 * Statistical v1 (robust z-scores, frequencies). Slot for Isolation Forest / autoencoder later.
 */
export function behaviourModel(t: TxnInput, prior: TxnInput[]): ModelResult {
  const f: Factor[] = [];
  if (prior.length < 5) return combine("behaviour", [], true);

  const debits = prior.filter((p) => p.direction === "debit");
  if (t.direction === "debit" && debits.length >= 5) {
    const logs = debits.map((p) => Math.log(p.amount));
    const med = median(logs)!;
    const mad = median(logs.map((x) => Math.abs(x - med)))! || 0.25;
    const z = (Math.log(t.amount) - med) / (1.4826 * mad);
    const ratio = t.amount / Math.exp(med);
    f.push({ key: "amount", weight: 0.6, strength: clamp01((z - 2) / 4), text: `amount ${ratio.toFixed(1)}× the customer's typical debit (${inr(Math.exp(med))})` });
  }

  const seenDevice = prior.find((p) => p.deviceId === t.deviceId);
  const deviceAge = seenDevice ? t.occurredAt - seenDevice.occurredAt : null;
  f.push({
    key: "device",
    weight: 0.5,
    strength: deviceAge === null ? 1 : deviceAge <= 24 * HOUR ? 0.6 : 0,
    text: deviceAge === null ? "device never used by this customer before" : "device first used less than 24h ago",
  });

  const cities = new Set(prior.map((p) => p.city));
  if (!cities.has(t.city)) {
    const nearest = [...cities].filter(isKnownCity).map((c) => (isKnownCity(t.city) ? distanceKm(c, t.city) : 0));
    const km = nearest.length ? Math.min(...nearest) : 0;
    f.push({ key: "city", weight: 0.4, strength: clamp01(km / 800), text: `first transaction in ${t.city} (${Math.round(km)} km from usual cities)` });
  }

  if (t.direction === "debit" && !debits.some((p) => p.counterparty === t.counterparty)) {
    f.push({ key: "payee", weight: 0.25, strength: isP2P(t) ? 1 : 0.3, text: isP2P(t) ? "first payment to this person" : "first payment to this merchant" });
  }

  const h = hourIst(t.occurredAt);
  const near = prior.filter((p) => Math.abs(hourIst(p.occurredAt) - h) <= 1 || Math.abs(hourIst(p.occurredAt) - h) >= 23).length / prior.length;
  f.push({ key: "hour", weight: 0.3, strength: clamp01((0.08 - near) / 0.08), text: `${String(h).padStart(2, "0")}:00 IST is outside the customer's usual hours` });

  const chShare = prior.filter((p) => p.channel === t.channel).length / prior.length;
  f.push({ key: "channel", weight: 0.15, strength: clamp01((0.1 - chShare) / 0.1), text: `${t.channel} is rarely used by this customer` });

  const lastHour = prior.filter((p) => within(t, p, HOUR)).length + 1;
  f.push({ key: "velocity", weight: 0.5, strength: clamp01((lastHour - 3) / 5), text: `${lastHour} transactions in the last hour` });

  return combine("behaviour", f);
}

/**
 * BENEFICIARY — "how suspicious is where the money is going?"
 * Catches authorised-push scams (customer pays willingly from their own device).
 */
export function beneficiaryModel(t: TxnInput, cpHistory: TxnInput[], prior: TxnInput[]): ModelResult {
  if (t.direction !== "debit" || !isP2P(t)) return combine("beneficiary", [], false);
  const all = [...cpHistory, t];
  const day = all.filter((p) => within(t, p, 24 * HOUR));
  const senders24 = new Set(day.map((p) => p.customerId)).size;
  const sendersAll = new Set(all.map((p) => p.customerId)).size;
  const volume24 = day.reduce((s, p) => s + p.amount, 0);
  const firstSeen = all[0].occurredAt;
  const newForSender = !prior.some((p) => p.direction === "debit" && p.counterparty === t.counterparty);

  return combine("beneficiary", [
    { key: "senders_24h", weight: 0.9, strength: clamp01((senders24 - 1) / 4), text: `${senders24} different customers paid this beneficiary in 24h` },
    { key: "senders_all", weight: 0.5, strength: clamp01((sendersAll - 2) / 8), text: `${sendersAll} customers have ever paid this beneficiary` },
    { key: "volume_24h", weight: 0.3, strength: senders24 > 1 ? clamp01(Math.log10(volume24 / 20_000) / 1.5) : 0, text: `${inr(volume24)} received from our customers in 24h` },
    { key: "new_beneficiary", weight: 0.2, strength: t.occurredAt - firstSeen <= 24 * HOUR ? 1 : 0, text: "beneficiary first seen at this bank within 24h" },
    { key: "new_for_customer", weight: 0.15, strength: newForSender && prior.length >= 5 ? 1 : 0, text: "customer has never paid this beneficiary before" },
  ]);
}

/**
 * NETWORK — "is this account moving money like a mule?" (customer-level flows, trailing 24h)
 * Pass-through, many senders, many recipients, fast onward movement.
 */
export function networkModel(t: TxnInput, prior: TxnInput[]): ModelResult {
  const win = [...prior.filter((p) => within(t, p, 24 * HOUR)), t].filter(isP2P);
  const credits = win.filter((p) => p.direction === "credit");
  const debits = win.filter((p) => p.direction === "debit");
  const inflow = credits.reduce((s, p) => s + p.amount, 0);
  const outflow = debits.reduce((s, p) => s + p.amount, 0);
  const senders = new Set(credits.map((p) => p.counterparty)).size;
  const recipients = new Set(debits.map((p) => p.counterparty)).size;
  const everPaid = new Set(prior.filter((p) => p.direction === "debit" && !within(t, p, 24 * HOUR)).map((p) => p.counterparty));
  const newRecipients = new Set(debits.filter((p) => !everPaid.has(p.counterparty)).map((p) => p.counterparty)).size;
  const lastCredit = [...prior].reverse().find((p) => p.direction === "credit" && isP2P(p));
  const gapMin = t.direction === "debit" && lastCredit ? (t.occurredAt - lastCredit.occurredAt) / MIN : null;
  const passRatio = inflow >= 20_000 ? outflow / inflow : 0;
  // Pass-through only matters when money arrives from several unrelated senders (a business paying
  // suppliers from its own sales is normal); gate the flow factors on sender diversity.
  const senderGate = clamp01((senders - 1) / 3);

  return combine("network", [
    { key: "pass_through", weight: 0.8, strength: clamp01((passRatio - 0.5) / 0.4) * senderGate, text: `${Math.round(passRatio * 100)}% of ${inr(inflow)} received was sent onward within 24h` },
    { key: "many_senders", weight: 0.5, strength: clamp01((senders - 2) / 4), text: `${senders} different people sent money in 24h` },
    { key: "many_new_recipients", weight: 0.7, strength: clamp01((newRecipients - 2) / 6), text: `${newRecipients} new recipients paid in 24h` },
    { key: "fast_outflow", weight: 0.4, strength: gapMin !== null && gapMin <= 180 && inflow >= 20_000 ? (1 - gapMin / 180) * senderGate : 0, text: `money sent out ${Math.round(gapMin ?? 0)} min after it arrived` },
    { key: "recipients", weight: 0.3, strength: clamp01((recipients - 3) / 6), text: `${recipients} different recipients in 24h` },
  ]);
}

export { byTime };
