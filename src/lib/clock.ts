import "server-only";

/** Request time for per-request Server Components (rendered once per request, never on the client). */
export function requestTime(): number {
  return Date.now();
}
