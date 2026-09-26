import { expect, test, type Page } from "@playwright/test";

const analyst = { email: process.env.E2E_ANALYST_EMAIL, password: process.env.E2E_ANALYST_PASSWORD };
const supervisor = { email: process.env.E2E_SUPERVISOR_EMAIL, password: process.env.E2E_SUPERVISOR_PASSWORD };
const configured = Boolean(analyst.email && analyst.password && supervisor.email && supervisor.password);

async function login(page: Page, who: { email?: string; password?: string }) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(who.email!);
  await page.getByLabel("Password").fill(who.password!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Alert queue" })).toBeVisible();
}

test("signed-out users are redirected to login, with security headers", async ({ page }) => {
  const res = await page.goto("/");
  expect(page.url()).toContain("/login");
  const headers = res!.headers();
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["x-powered-by"]).toBeUndefined();
});

test("wrong password shows a generic error", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("nobody@bank.test");
  await page.getByLabel("Password").fill("wrong-password-123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText(/Invalid email or password|Too many attempts/);
});

test.describe("triage flow", () => {
  test.skip(!configured, "set E2E_ANALYST_* and E2E_SUPERVISOR_* in .env.local");

  test("analyst investigates, gets an AI brief, and closes an alert; supervisor sees it in rule performance", async ({ browser }) => {
    const aPage = await (await browser.newContext()).newPage();
    await login(aPage, analyst);
    await expect(aPage.getByText(/^(Live|Connecting…|\d+ updates?…)$/)).toBeVisible();

    // Open the highest-risk open alert.
    const first = aPage.locator("tbody tr").first().getByRole("link");
    await expect(first, "no open alerts — run detection first").toBeVisible();
    await first.click();
    await expect(aPage.getByRole("heading", { name: "Why it was flagged" })).toBeVisible();

    // Decision replay reproduces the score from evidence.
    await expect(aPage.getByRole("heading", { name: "How the score was computed" })).toBeVisible();
    await expect(aPage.getByText("does not reproduce the stored score")).toHaveCount(0);

    // AI brief (LLM or deterministic fallback — both are valid outcomes).
    await aPage.getByRole("button", { name: /Generate summary|Regenerate/ }).click();
    await expect(aPage.getByText(/AI · |Rules-based fallback · /)).toBeVisible({ timeout: 30_000 });
    await expect(aPage.getByText("Suggested next step")).toBeVisible();

    // Claim, then try to close without a proper note, then close properly.
    await aPage.getByRole("button", { name: "Claim for review" }).click();
    await expect(aPage.getByRole("status").filter({ hasText: "in review" })).toBeVisible();
    await aPage.getByLabel(/Note/).fill("too short");
    await aPage.getByRole("button", { name: "Confirm fraud" }).click();
    await expect(aPage.getByText("Add a note of at least 10 characters.")).toBeVisible();
    await aPage.getByLabel(/Note/).fill("E2E: customer denied the transaction on a verified call");
    await aPage.getByRole("button", { name: "Confirm fraud" }).click();
    await expect(aPage.getByRole("status").filter({ hasText: "confirmed fraud" })).toBeVisible();
    await aPage.reload();
    await expect(aPage.getByText(/You\s*confirmed as fraud/)).toBeVisible();

    // Analysts can't open supervisor metrics.
    await aPage.goto("/metrics");
    await expect(aPage).toHaveURL(/\/$|\/\?/);

    // Supervisor sees at least one confirmed outcome.
    const sPage = await (await browser.newContext()).newPage();
    await login(sPage, supervisor);
    await sPage.getByRole("link", { name: "Rule performance" }).click();
    await expect(sPage.getByRole("heading", { name: "Rule performance" })).toBeVisible();
    const confirmed = sPage.locator("dt", { hasText: "Confirmed fraud" }).locator("xpath=following-sibling::dd");
    await expect(confirmed).not.toHaveText("0");
  });
});
