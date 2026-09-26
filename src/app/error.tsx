"use client";

import Link from "next/link";

/** App-wide error boundary. Never shows raw error text (Next redacts server errors in prod; we show only the digest). */
export default function AppError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <main className="mx-auto mt-24 max-w-md px-4 text-sm">
      <h1 className="mb-2 text-lg font-semibold">Something went wrong</h1>
      <p className="text-neutral-600">The page couldn&apos;t load. Your work is saved — decisions are only recorded once confirmed.</p>
      {error.digest && <p className="mt-2 font-mono text-xs text-neutral-400">Reference: {error.digest}</p>}
      <div className="mt-6 flex gap-2">
        <button onClick={() => retry()} className="btn-primary">Try again</button>
        <Link href="/" className="btn">Back to queue</Link>
      </div>
    </main>
  );
}
