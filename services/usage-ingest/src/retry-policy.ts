/** Native delivery attempts share one budget across all failure classes. */
export function usageRetryDelaySeconds(
  attempts: unknown,
  admissionRejected: boolean,
  random: () => number = Math.random,
  nonLlmClassOnly = false
): number {
  const attempt =
    typeof attempts === 'number' && Number.isSafeInteger(attempts) && attempts > 0
      ? Math.min(attempts, 21)
      : 1;
  if (admissionRejected && nonLlmClassOnly) {
    // A recognized class-only non-LLM quota rejection keeps the admission schedule but never
    // starts below 15 seconds, so early attempts retry less often. From attempt 5 the base is
    // already at least 16 seconds, so the rest is identical to the normal admission schedule.
    const base = Math.max(15, Math.min(300, 2 ** Math.min(attempt - 1, 9)));
    return base + Math.floor(random() * (base + 1));
  }
  if (attempt === 1 && admissionRejected) {
    return 1 + Math.floor(random() * 4);
  }
  let base = Math.min(300, 2 ** Math.min(attempt - 1, 9));
  if (!admissionRejected) base = Math.max(60, base);
  return base + Math.floor(random() * (base + 1));
}
