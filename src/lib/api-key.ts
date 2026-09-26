import { timingSafeEqual } from "node:crypto";

/** Constant-time API-key check for bank systems calling the precheck API. */
export function apiKeyMatches(header: string | null, expected: string | undefined): boolean {
  if (!header || !expected || expected.length < 24) return false;
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
