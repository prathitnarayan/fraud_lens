import Link from "next/link";
import { logout } from "@/app/login/actions";
import type { Viewer } from "@/lib/auth";

export function AppHeader({ viewer }: { viewer: Viewer }) {
  return (
    <header className="flex items-center justify-between border-b border-neutral-200 px-6 py-3">
      <Link href="/" className="font-semibold">
        FraudLens
      </Link>
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
