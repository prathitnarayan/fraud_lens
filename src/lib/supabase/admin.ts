import "server-only";
import { createClient } from "@supabase/supabase-js";
import { getPublicEnv } from "@/lib/env";
import { getServerEnv } from "@/lib/env.server";

/**
 * Service-role client — BYPASSES RLS. Only for trusted server paths
 * (risk engine writes, AI summary writes, seeding). Never import in client code.
 */
export function createAdminClient() {
  const { supabaseUrl } = getPublicEnv();
  return createClient(supabaseUrl, getServerEnv().serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
