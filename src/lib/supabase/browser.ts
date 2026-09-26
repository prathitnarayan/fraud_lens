import { createBrowserClient } from "@supabase/ssr";
import { getPublicEnv } from "@/lib/env";

/** Browser client (publishable key only). Used for Realtime subscriptions. */
export function createClient() {
  const { supabaseUrl, supabaseKey } = getPublicEnv();
  return createBrowserClient(supabaseUrl, supabaseKey);
}
