import { AppHeader } from "@/components/app-header";
import { PrecheckForm, type Preset } from "@/components/precheck-form";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

type Row = { customer_id: string; counterparty: string; device_id: string; city: string; occurred_at: string; customers: { external_ref: string; home_city: string } | null };

/** Builds demo presets from live data (read as the signed-in user). */
async function loadPresets(): Promise<Preset[]> {
  const db = await createClient();
  const [{ data: recent }, { data: p2p }] = await Promise.all([
    db.from("transactions").select("customer_id, counterparty, device_id, city, occurred_at, customers(external_ref, home_city)")
      .eq("direction", "debit").not("merchant_category", "is", null).order("occurred_at", { ascending: false }).limit(50),
    db.from("transactions").select("customer_id, counterparty, device_id, city, occurred_at, customers(external_ref, home_city)")
      .eq("direction", "debit").is("merchant_category", null).order("occurred_at", { ascending: false }).limit(1000),
  ]);
  const rows = (recent ?? []) as unknown as Row[];
  const base = rows.find((r) => r.customers && r.city === r.customers.home_city) ?? rows[0];
  if (!base?.customers) return [];

  // Beneficiary most customers paid recently (the mule-collection pattern) — found from data, not hard-coded.
  const payers = new Map<string, Set<string>>();
  for (const r of (p2p ?? []) as unknown as Row[]) {
    if (!payers.has(r.counterparty)) payers.set(r.counterparty, new Set());
    payers.get(r.counterparty)!.add(r.customer_id);
  }
  const hot = [...payers.entries()].sort((a, b) => b[1].size - a[1].size)[0];

  const me = { customerRef: base.customers.external_ref, city: base.customers.home_city, deviceId: base.device_id };
  const presets: Preset[] = [
    { label: "Normal grocery payment", description: "Known device, home city, familiar merchant",
      values: { ...me, amount: 850, channel: "UPI", counterparty: "merchant:bigbasket", merchantCategory: "grocery" } },
    { label: "SIM-swap: ₹2L from new phone", description: "New device + large transfer to a new person",
      values: { ...me, amount: 200_000, channel: "IMPS", counterparty: "new.payee.7731@ibl", merchantCategory: "", deviceId: "dev-unknown-phone" } },
  ];
  presets.push({ label: "UPI ₹1.5L to a person", description: "Above the NPCI ₹1 lakh UPI P2P limit",
    values: { ...me, amount: 150_000, channel: "UPI", counterparty: "friend.9921@okaxis", merchantCategory: "" } });
  if (hot && hot[1].size >= 2) {
    presets.push({ label: `Pay account ${hot[1].size} customers paid`, description: "Digital-arrest / fake-refund style: many victims → one beneficiary",
      values: { ...me, amount: 24_999, channel: "UPI", counterparty: hot[0], merchantCategory: "" } });
  }
  return presets;
}

export default async function PrecheckPage() {
  const viewer = await requireStaff();
  const presets = await loadPresets();
  return (
    <div className="min-h-screen">
      <AppHeader viewer={viewer} />
      <main className="mx-auto max-w-6xl space-y-4 p-6">
        <div>
          <h1 className="text-lg font-semibold">Pre-transaction check</h1>
          <p className="text-xs text-neutral-500">
            Scores a payment <b>before</b> money moves — same rules and models, customer + beneficiary history. Rules can hold; models can only add friction. STEP_UP implements the risk-based checks required by the RBI Authentication Mechanisms Directions 2025 (in force 1 Apr 2026).
            Bank systems call <code className="font-mono">POST /api/v1/precheck</code>.
          </p>
        </div>
        <PrecheckForm presets={presets} />
      </main>
    </div>
  );
}
