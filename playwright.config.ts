import { defineConfig, devices } from "@playwright/test";

/**
 * E2E against a real Supabase project (reads .env.local via `node --env-file`).
 * Requires two approved staff users: E2E_ANALYST_EMAIL/PASSWORD and E2E_SUPERVISOR_EMAIL/PASSWORD.
 * Each run consumes one open alert (claims and closes it).
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : { command: "npm run dev", url: "http://localhost:3000/login", reuseExistingServer: true, timeout: 120_000 },
});
