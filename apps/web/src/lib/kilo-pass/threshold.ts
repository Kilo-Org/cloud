/**
 * Kilo Pass bonus credits are treated as "earned" slightly early: once usage crosses
 * (kilo_pass_threshold - $1).
 */
export function getEffectiveKiloPassThreshold(
  kiloPassThresholdMicrodollars: number | null
): number | null {
  if (kiloPassThresholdMicrodollars === null) return null;
  return Math.max(0, kiloPassThresholdMicrodollars - 1_000_000);
}
