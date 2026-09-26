"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/browser";

/**
 * Subscribes to alert inserts/updates (RLS-filtered by Supabase Realtime) and refreshes the
 * server-rendered queue, debounced so a detection run of 100+ inserts causes one refresh.
 */
export function LiveRefresh() {
  const router = useRouter();
  const [status, setStatus] = useState<"connecting" | "live" | "offline">("connecting");
  const [pending, setPending] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel("alerts-feed")
      .on("postgres_changes", { event: "*", schema: "public", table: "alerts" }, () => {
        setPending((n) => n + 1);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          router.refresh();
          setPending(0);
        }, 800);
      })
      .subscribe((s) => setStatus(s === "SUBSCRIBED" ? "live" : s === "CLOSED" || s === "CHANNEL_ERROR" || s === "TIMED_OUT" ? "offline" : "connecting"));
    return () => {
      if (timer.current) clearTimeout(timer.current);
      void supabase.removeChannel(channel);
    };
  }, [router]);

  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-neutral-500" role="status" aria-live="polite">
      <span className={`h-2 w-2 rounded-full ${status === "live" ? "bg-neutral-900" : "bg-neutral-300"}`} />
      {status === "live" ? (pending > 0 ? `${pending} update${pending > 1 ? "s" : ""}…` : "Live") : status === "offline" ? "Offline — refresh manually" : "Connecting…"}
    </span>
  );
}
