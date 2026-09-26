import type { Metadata } from "next";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in · FraudLens" };

export default function LoginPage() {
  return (
    <main className="mx-auto mt-24 w-full max-w-sm px-4">
      <h1 className="text-xl font-semibold">FraudLens</h1>
      <p className="mb-6 text-sm text-neutral-500">Fraud alert triage · staff sign-in</p>
      <LoginForm />
    </main>
  );
}
