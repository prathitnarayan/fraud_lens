import { Bar, HeaderSkeleton } from "@/components/skeleton";

export default function QueueLoading() {
  return (
    <div className="min-h-screen" aria-busy="true" aria-label="Loading alert queue">
      <HeaderSkeleton />
      <main className="mx-auto max-w-7xl space-y-6 p-6">
        <Bar w="10rem" h="1.25rem" />
        <div className="flex gap-4">{[1, 2, 3, 4, 5].map((i) => <Bar key={i} w="6rem" h="1.5rem" />)}</div>
        <div className="space-y-3">{Array.from({ length: 8 }, (_, i) => <Bar key={i} h="2.25rem" />)}</div>
      </main>
    </div>
  );
}
