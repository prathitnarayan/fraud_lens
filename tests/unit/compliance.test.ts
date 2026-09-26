import { describe, expect, it } from "vitest";
import { compensationEstimate, muleHoldPlan, REGULATIONS } from "@/lib/compliance";

const DAY = 86_400_000;
const T = Date.UTC(2026, 8, 26);

describe("draft money-mule SOP clock", () => {
  it("does not apply without a mule pattern or below ₹1,000", () => {
    expect(muleHoldPlan({ reasonCodes: ["VELOCITY_BURST"], amount: 50_000, holdStart: null, now: T }).applies).toBe(false);
    expect(muleHoldPlan({ reasonCodes: ["MULE_PASS_THROUGH"], amount: 999, holdStart: null, now: T }).applies).toBe(false);
    expect(muleHoldPlan({ reasonCodes: ["MULE_PASS_THROUGH"], amount: 1_000, holdStart: null, now: T }).applies).toBe(true);
  });

  it("ring alerts target the external beneficiary, not our customer", () => {
    expect(muleHoldPlan({ reasonCodes: ["MULE_RING"], amount: 9_999, holdStart: null, now: T }).target).toBe("beneficiary");
  });

  it("no reply: explanation due +20d, decision +30d after that, capped at 60d", () => {
    const p = muleHoldPlan({ reasonCodes: ["MULE_PASS_THROUGH"], amount: 30_000, holdStart: T, now: T + 5 * DAY });
    expect(p.explanationDue).toBe(T + 20 * DAY);
    expect(p.decisionDue).toBe(T + 50 * DAY);
    expect(p.maxHoldUntil).toBe(T + 60 * DAY);
    expect(p.daysRemaining).toBe(55);
  });

  it("reply received: decision due 10 days after the reply; never beyond 60 days", () => {
    expect(muleHoldPlan({ reasonCodes: ["MULE_PASS_THROUGH"], amount: 30_000, holdStart: T, explanationAt: T + 3 * DAY, now: T }).decisionDue).toBe(T + 13 * DAY);
    expect(muleHoldPlan({ reasonCodes: ["MULE_PASS_THROUGH"], amount: 30_000, holdStart: T, explanationAt: T + 55 * DAY, now: T }).decisionDue).toBe(T + 60 * DAY);
    expect(muleHoldPlan({ reasonCodes: ["MULE_PASS_THROUGH"], amount: 30_000, holdStart: T, now: T + 90 * DAY }).daysRemaining).toBe(0);
  });
});

describe("draft compensation estimate", () => {
  const base = { reasonCodes: ["NEW_DEVICE_HIGH_VALUE"], direction: "debit", occurredAt: T, now: T + DAY };
  it("85% capped at ₹25,000 for losses up to ₹50,000", () => {
    expect(compensationEstimate({ ...base, amount: 10_000 }).estimatedInr).toBe(8_500);
    expect(compensationEstimate({ ...base, amount: 40_000 }).estimatedInr).toBe(25_000);
    expect(compensationEstimate({ ...base, amount: 50_000 }).applies).toBe(true);
    expect(compensationEstimate({ ...base, amount: 50_001 }).applies).toBe(false);
  });
  it("tracks the 5-day reporting window", () => {
    expect(compensationEstimate({ ...base, amount: 10_000, now: T + 5 * DAY }).withinWindow).toBe(true);
    expect(compensationEstimate({ ...base, amount: 10_000, now: T + 5 * DAY + 1 }).withinWindow).toBe(false);
  });
  it("does not apply to non-victim patterns or credits", () => {
    expect(compensationEstimate({ ...base, amount: 10_000, reasonCodes: ["STRUCTURING"] }).applies).toBe(false);
    expect(compensationEstimate({ ...base, amount: 10_000, direction: "credit" }).applies).toBe(false);
  });
  it("draft rules are labelled as drafts", () => {
    expect(REGULATIONS.muleSop.status).toBe("draft");
    expect(REGULATIONS.compensation.status).toBe("draft");
    expect(REGULATIONS.auth2fa.status).toBe("in_force");
  });
});
