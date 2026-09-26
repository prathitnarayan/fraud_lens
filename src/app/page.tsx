import { requireStaff } from "@/lib/auth";
import { logout } from "./login/actions";

export default async function Home() {
  const viewer = await requireStaff();
  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b border-neutral-200 px-6 py-3">
        <span className="font-semibold">FraudLens</span>
        <div className="flex items-center gap-3 text-sm text-neutral-600">
          <span>
            {viewer.fullName || viewer.email} · <span className="uppercase">{viewer.role}</span>
          </span>
          <form action={logout}>
            <button className="btn">Sign out</button>
          </form>
        </div>
      </header>
      <main className="p-6 text-sm text-neutral-500">Alert queue arrives in P2.</main>
    </div>
  );
}
