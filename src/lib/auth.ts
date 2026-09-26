import "server-only";
import { redirect } from "next/navigation";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";

export type AppRole = "analyst" | "supervisor" | "admin";
export type Viewer = { id: string; email: string; fullName: string; role: AppRole | null };

/** Resolves the signed-in user + role once per request. */
export const getViewer = cache(async (): Promise<Viewer | null> => {
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  const claims = claimsData?.claims;
  if (!claims?.sub) return null;
  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, role")
    .eq("id", claims.sub)
    .maybeSingle();
  return {
    id: claims.sub,
    email: typeof claims.email === "string" ? claims.email : "",
    fullName: profile?.full_name ?? "",
    role: (profile?.role as AppRole | null) ?? null,
  };
});

/** For pages: redirects if signed out or not yet approved. */
export async function requireStaff(): Promise<Viewer & { role: AppRole }> {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  if (!viewer.role) redirect("/pending");
  return viewer as Viewer & { role: AppRole };
}

export function isSupervisor(role: AppRole | null): boolean {
  return role === "supervisor" || role === "admin";
}
