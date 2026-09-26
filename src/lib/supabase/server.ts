import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getPublicEnv } from "@/lib/env";

/** Per-request client acting as the signed-in user. RLS applies. */
export async function createClient() {
  // cookies() first: marks the route dynamic so it is never prerendered at build time
  // (env is only required at request time, not during `next build`).
  const cookieStore = await cookies();
  const { supabaseUrl, supabaseKey } = getPublicEnv();
  return createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet) => {
        try {
          toSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Called from a Server Component: cookies are read-only there; proxy refreshes the session.
        }
      },
    },
  });
}
