import { Bar, HeaderSkeleton } from "@/components/skeleton";

export default function AlertLoading() {
  return (
    <div className="min-h-screen" aria-busy="true" aria-label="Loading alert">
      <HeaderSkeleton />
      <main className="mx-auto max-w-6xl space-y-4 p-6">
        <Bar w="14rem" h="1.5rem" />
        <div className="grid gap-4 lg:grid-cols-2">
          {[0, 1].map((c) => (
            <div key={c} className="space-y-3 rounded border border-neutral-200 p-4">
              {Array.from({ length: 6 }, (_, i) => <Bar key={i} w={`${60 + ((i * 13) % 40)}%`} />)}
            </div>
          ))}
        </div>
        <div className="space-y-2 rounded border border-neutral-200 p-4">{Array.from({ length: 8 }, (_, i) => <Bar key={i} />)}</div>
      </main>
    </div>
  );
}
