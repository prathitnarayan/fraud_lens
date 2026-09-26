import Link from "next/link";
import { logout } from "@/app/login/actions";
import type { Viewer } from "@/lib/auth";

export function AppHeader({ viewer }: { viewer: Viewer }) {
  return (
    <header className="flex items-center justify-between border-b border-neutral-200 px-6 py-3">
      <nav className="flex items-center gap-4 text-sm">
        <Link href="/" className="font-semibold">FraudLens</Link>
        <Link href="/" className="text-neutral-600 hover:text-neutral-900">Queue</Link>
        {(viewer.role === "supervisor" || viewer.role === "admin") && (
          <Link href="/metrics" className="text-neutral-600 hover:text-neutral-900">Rule performance</Link>
        )}
      </nav>
      <div className="flex items-center gap-3 text-sm text-neutral-600">
        <span>
          {viewer.fullName || viewer.email} · <span className="uppercase">{viewer.role}</span>
        </span>
        <form action={logout}>
          <button className="btn">Sign out</button>
        </form>
      </div>
    </header>
  );
}
