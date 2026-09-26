"use client";

import { useActionState } from "react";
import { login, type LoginState } from "./actions";

export function LoginForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(login, { error: null });
  return (
    <form action={action} className="space-y-4" noValidate>
      <label className="block text-sm">
        <span className="mb-1 block text-neutral-600">Email</span>
        <input name="email" type="email" autoComplete="username" required className="input" />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-neutral-600">Password</span>
        <input name="password" type="password" autoComplete="current-password" required minLength={8} className="input" />
      </label>
      {state.error && (
        <p role="alert" className="text-sm text-red-700">
          {state.error}
        </p>
      )}
      <button type="submit" disabled={pending} className="btn-primary w-full">
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
