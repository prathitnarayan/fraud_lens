import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto mt-24 max-w-md px-4 text-sm">
      <h1 className="mb-2 text-lg font-semibold">Not found</h1>
      <p className="text-neutral-600">This alert doesn&apos;t exist or you don&apos;t have access to it.</p>
      <Link href="/" className="btn mt-6">Back to queue</Link>
    </main>
  );
}
