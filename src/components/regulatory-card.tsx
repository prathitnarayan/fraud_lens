import { compensationEstimate, muleHoldPlan, REGULATIONS } from "@/lib/compliance";

const date = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;

function Tag({ status }: { status: "in_force" | "draft" }) {
  return <span className={`ml-1 rounded px-1 text-[10px] uppercase ${status === "draft" ? "border border-neutral-400 text-neutral-600" : "bg-neutral-900 text-white"}`}>{status === "draft" ? "draft" : "in force"}</span>;
}

export function RegulatoryCard(props: { reasonCodes: string[]; amount: number; direction: string; occurredAt: number; holdStart: number | null; now: number }) {
  const hold = muleHoldPlan({ reasonCodes: props.reasonCodes, amount: props.amount, holdStart: props.holdStart, now: props.now });
  const comp = compensationEstimate(props);
  return (
    <section className="rounded border border-neutral-200 p-4 text-sm">
      <h2 className="font-semibold">Regulatory</h2>
      <p className="mb-3 text-xs text-neutral-500">RBI obligations for this case — deadlines computed from the case timeline</p>
      <ul className="space-y-3">
        <li>
          <div className="text-xs font-semibold">Early Warning Signal <Tag status={REGULATIONS.frm.status} /></div>
          <div className="text-xs text-neutral-600">This alert is an EWS under the Fraud Risk Management Master Directions; confirming fraud red-flags the case for reporting.</div>
        </li>
        {hold.applies && (
          <li>
            <div className="text-xs font-semibold">Money-mule debit hold <Tag status={REGULATIONS.muleSop.status} /> <span className="font-normal text-neutral-500">proposed from {REGULATIONS.muleSop.effective}</span></div>
            <div className="text-xs text-neutral-600">{hold.reason}</div>
            {hold.holdStart !== null && (
              <dl className="mt-1 grid grid-cols-2 gap-x-3 text-xs">
                <dt className="text-neutral-500">Hold started</dt><dd>{date.format(hold.holdStart)}</dd>
                <dt className="text-neutral-500">Customer explanation due</dt><dd>{date.format(hold.explanationDue!)}</dd>
                <dt className="text-neutral-500">Bank decision due</dt><dd>{date.format(hold.decisionDue!)}</dd>
                <dt className="text-neutral-500">Hold must end by</dt><dd><b>{date.format(hold.maxHoldUntil!)}</b> ({hold.daysRemaining} days left)</dd>
              </dl>
            )}
          </li>
        )}
        {comp.reportBy !== null && (
          <li>
            <div className="text-xs font-semibold">Customer compensation <Tag status={REGULATIONS.compensation.status} /> <span className="font-normal text-neutral-500">proposed from {REGULATIONS.compensation.effective}</span></div>
            <div className="text-xs text-neutral-600">
              {comp.applies && comp.estimatedInr !== null ? <>Up to <b>{inr(comp.estimatedInr)}</b> (85%, max ₹25,000). {comp.reason}</> : comp.reason}
            </div>
            <div className="text-xs text-neutral-600">
              Report by {date.format(comp.reportBy)} — {comp.withinWindow ? "window open" : <b>window closed</b>}
            </div>
          </li>
        )}
      </ul>
    </section>
  );
}
