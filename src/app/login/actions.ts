"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createRateLimiter } from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";

const credentials = z.object({
  email: z.email().max(254),
  password: z.string().min(8).max(128),
});

// 5 attempts / 5 min per IP+email (Supabase Auth also rate-limits server-side).
const limiter = createRateLimiter({ limit: 5, windowMs: 5 * 60_000 });

export type LoginState = { error: string | null };

export async function login(_prev: LoginState, form: FormData): Promise<LoginState> {
  const parsed = credentials.safeParse({ email: form.get("email"), password: form.get("password") });
  if (!parsed.success) return { error: "Enter a valid email and password (min 8 chars)." };

  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  if (!limiter(`${ip}:${parsed.data.email.toLowerCase()}`).ok) {
    return { error: "Too many attempts. Try again in a few minutes." };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) return { error: "Invalid email or password." };
  redirect("/");
}

export async function logout() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
