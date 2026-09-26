/** Stable fraud pattern codes. Mirrored by the fraud_labels CHECK constraint. */
export const FRAUD_PATTERNS = [
  "VELOCITY_BURST",
  "NEW_DEVICE_HIGH_VALUE",
  "GEO_MISMATCH",
  "MULE_FAN_IN",
  "MULE_FAN_OUT",
  "STRUCTURING",
] as const;

export type FraudPattern = (typeof FRAUD_PATTERNS)[number];

/** Reporting threshold used by the structuring pattern (₹). */
export const STRUCTURING_THRESHOLD = 50_000;
/** Faster than a commercial flight → physically impossible for one person. */
export const IMPOSSIBLE_SPEED_KMH = 900;
