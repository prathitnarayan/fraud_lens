export function Bar({ w = "100%", h = "0.75rem" }: { w?: string; h?: string }) {
  return <div className="animate-pulse rounded bg-neutral-200" style={{ width: w, height: h }} />;
}

export function HeaderSkeleton() {
  return (
    <div className="flex items-center justify-between border-b border-neutral-200 px-6 py-3">
      <Bar w="8rem" h="1rem" />
      <Bar w="12rem" h="1.75rem" />
    </div>
  );
}
