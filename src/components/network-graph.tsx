import type { Network, NetNode } from "@/lib/network";

const ROW = 34;
const NODE_W = 210;
const NODE_H = 24;
const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;
const trunc = (s: string, n = 28) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Static layered graph (server-rendered SVG, no client JS): left → center → right. */
export function NetworkGraph({ net }: { net: Network }) {
  const rows = Math.max(net.left.length, net.right.length, 1);
  const height = rows * ROW + 20;
  const hasRight = net.right.length > 0;
  const width = hasRight ? 900 : 620;
  const xLeft = 10;
  const xCenter = hasRight ? 345 : 400;
  const xRight = 680;
  const yFor = (i: number, n: number) => 10 + (height - 20 - n * ROW) / 2 + i * ROW;
  const cy = height / 2 - NODE_H / 2;
  const pos = new Map<string, { x: number; y: number }>();
  net.left.forEach((n, i) => pos.set(n.id, { x: xLeft, y: yFor(i, net.left.length) }));
  net.right.forEach((n, i) => pos.set(n.id, { x: xRight, y: yFor(i, net.right.length) }));
  pos.set("center", { x: xCenter, y: cy });

  const box = (n: NetNode) => {
    const p = pos.get(n.id)!;
    const dark = n.kind === "center";
    return (
      <g key={n.id}>
        <rect x={p.x} y={p.y} width={NODE_W} height={NODE_H} rx={4}
          className={dark ? "fill-neutral-900" : n.highlight ? "fill-neutral-200 stroke-neutral-900" : "fill-white stroke-neutral-300"} strokeWidth={n.highlight && !dark ? 1.5 : 1} />
        <text x={p.x + 8} y={p.y + 16} className={`font-mono text-[11px] ${dark ? "fill-white" : "fill-neutral-800"}`}>
          <title>{n.label}</title>
          {trunc(n.label)}
        </text>
      </g>
    );
  };

  return (
    <figure>
      <figcaption className="mb-2 text-sm">{net.title}</figcaption>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label={net.title}>
          {net.edges.map((e) => {
            const a = pos.get(e.from)!;
            const b = pos.get(e.to)!;
            const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2;
            return (
              <g key={`${e.from}-${e.to}`}>
                <line x1={x1} y1={y1} x2={x2} y2={y2} className={e.highlight ? "stroke-neutral-900" : "stroke-neutral-400"} strokeWidth={e.highlight ? 2.5 : 1} />
                <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 4} textAnchor="middle" className="fill-neutral-600 text-[10px]">
                  {inr(e.amount)}{e.count > 1 ? ` ×${e.count}` : ""}
                </text>
              </g>
            );
          })}
          {[...net.left, net.center, ...net.right].map(box)}
        </svg>
      </div>
      <p className="mt-1 text-xs text-neutral-500">Bold line = the alerted transaction. {net.mode === "fan_in" ? "Left: our customers · Right: shared beneficiary" : "Left: senders · Centre: this customer · Right: recipients"}</p>
    </figure>
  );
}
