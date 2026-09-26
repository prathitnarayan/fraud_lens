import { redirect } from "next/navigation";
import { getViewer } from "@/lib/auth";
import { logout } from "../login/actions";

export default async function PendingPage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  if (viewer.role) redirect("/");
  return (
    <main className="mx-auto mt-24 max-w-md px-4 text-sm">
      <h1 className="mb-2 text-lg font-semibold">Access pending</h1>
      <p className="text-neutral-600">
        Your account ({viewer.email}) has no role yet. An administrator must approve it before you can view alerts.
      </p>
      <form action={logout} className="mt-6">
        <button className="btn">Sign out</button>
      </form>
    </main>
  );
}
