"use client";

import { useActionState, useState } from "react";
import { precheckAction, type PrecheckState } from "@/app/actions/precheck";
import { CITY_NAMES } from "@/lib/geo";

export type Preset = {
  label: string;
  description: string;
  values: { customerRef: string; amount: number; channel: string; counterparty: string; merchantCategory: string; city: string; deviceId: string };
};

const DECISION_STYLE: Record<string, string> = {
  ALLOW: "border-neutral-300 text-neutral-900",
  WARN: "border-neutral-500 text-neutral-900",
  STEP_UP: "border-neutral-900 text-neutral-900",
  HOLD: "border-neutral-900 bg-neutral-900 text-white",
  DECLINE: "border-red-800 bg-red-800 text-white",
};
const DECISION_TEXT: Record<string, string> = {
  ALLOW: "Allow — payment proceeds",
  WARN: "Warn — show scam warning, customer can continue",
  STEP_UP: "Step-up — risk-based additional authentication (RBI 2FA Directions 2025) or call-back",
  HOLD: "Hold — payment paused for fraud-team review",
  DECLINE: "Decline — exceeds an NPCI / bank payment limit (checked before fraud scoring)",
};

export function PrecheckForm({ presets }: { presets: Preset[] }) {
  const [values, setValues] = useState(presets[0]?.values);
  const [state, action, pending] = useActionState<PrecheckState, FormData>(precheckAction, { ok: true, message: "", result: null });
  const r = state.result;
  if (!values) return <p className="text-sm text-neutral-500">No customers yet — seed demo data first.</p>;
  const set = (k: keyof typeof values) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setValues({ ...values, [k]: k === "amount" ? Number(e.target.value) : e.target.value });

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {presets.map((p) => (
            <button key={p.label} type="button" className="btn" title={p.description} onClick={() => setValues(p.values)}>
              {p.label}
            </button>
          ))}
        </div>
        <form action={action} className="grid grid-cols-2 gap-3 text-sm">
          {([
            ["customerRef", "Customer ref"],
            ["amount", "Amount (₹)"],
            ["counterparty", "Pay to (UPI ID / account / merchant)"],
            ["merchantCategory", "Merchant category (blank = person)"],
            ["deviceId", "Device ID"],
          ] as const).map(([k, label]) => (
            <label key={k} className={k === "counterparty" ? "col-span-2" : ""}>
              <span className="mb-1 block text-neutral-600">{label}</span>
              <input name={k} value={values[k]} onChange={set(k)} type={k === "amount" ? "number" : "text"} min={k === "amount" ? 1 : undefined} className="input" />
            </label>
          ))}
          <label>
            <span className="mb-1 block text-neutral-600">Channel</span>
            <select name="channel" value={values.channel} onChange={set("channel")} className="input">
              {["UPI", "IMPS", "NETBANKING", "CARD", "ATM"].map((c) => <option key={c}>{c}</option>)}
            </select>
          </label>
          <label>
            <span className="mb-1 block text-neutral-600">City</span>
            <select name="city" value={values.city} onChange={set("city")} className="input">
              {CITY_NAMES.map((c) => <option key={c}>{c}</option>)}
            </select>
          </label>
          <div className="col-span-2">
            <button className="btn-primary w-full" disabled={pending}>{pending ? "Checking…" : "Check payment before sending"}</button>
          </div>
        </form>
        {!state.ok && <p role="alert" className="text-sm text-red-700">{state.message}</p>}
      </div>

      <div aria-live="polite">
        {!r ? (
          <p className="rounded border border-dashed border-neutral-300 p-6 text-sm text-neutral-500">Pick a preset or fill in a payment, then run the check.</p>
        ) : (
          <div className="space-y-4">
            <div className={`rounded border-2 p-4 ${DECISION_STYLE[r.decision]}`}>
              <div className="text-2xl font-bold tracking-wide">{r.decision}</div>
              <div className="text-sm">{DECISION_TEXT[r.decision]}</div>
              <div className="mt-1 text-xs opacity-75">decided in {r.latencyMs} ms · {r.policyVersion}</div>
            </div>
            {r.customerMessage && (
              <div className="rounded border border-neutral-300 bg-neutral-50 p-3 text-sm">
                <div className="mb-1 text-xs uppercase text-neutral-500">Customer sees in the app</div>
                {r.customerMessage}
              </div>
            )}
            <div className="text-sm">
              <div className="text-xs uppercase text-neutral-500">Why</div>
              <ul className="list-disc pl-5">{r.policyReasons.map((x) => <li key={x}>{x}</li>)}</ul>
            </div>
            <dl className="grid grid-cols-4 gap-2 text-center text-xs">
              {[["Rules", r.ruleScore], ["Behaviour", r.models.behaviour.score], ["Beneficiary", r.models.beneficiary.applicable ? r.models.beneficiary.score : "n/a"], ["Network", r.models.network.score]].map(([k, v]) => (
                <div key={k} className="rounded border border-neutral-200 p-2"><dt className="text-neutral-500">{k}</dt><dd className="text-lg font-semibold tabular-nums">{v}</dd></div>
              ))}
            </dl>
            {r.ruleEvidence.length > 0 && (
              <ul className="space-y-1 text-xs text-neutral-700">
                {r.ruleEvidence.map((e) => <li key={e.code}><span className="font-mono">+{e.weight} {e.code}</span> — {e.text}</li>)}
              </ul>
            )}
            {(["behaviour", "beneficiary", "network"] as const).map((k) =>
              r.models[k].factors.length ? (
                <div key={k} className="text-xs text-neutral-600">
                  <span className="font-semibold capitalize">{k}:</span> {r.models[k].factors.slice(0, 3).map((f) => f.text).join(" · ")}
                </div>
              ) : null,
            )}
          </div>
        )}
      </div>
    </div>
  );
}
