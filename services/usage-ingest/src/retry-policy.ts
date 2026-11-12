/** Native delivery attempts share one budget across all failure classes. */
export function usageRetryDelaySeconds(
  attempts: unknown,
  admissionRejected: boolean,
  random: () => number = Math.random
): number {
  const attempt =
    typeof attempts === 'number' && Number.isSafeInteger(attempts) && attempts > 0
      ? Math.min(attempts, 21)
      : 1;
  let base = Math.min(300, 2 ** Math.min(attempt - 1, 9));
  if (!admissionRejected) base = Math.max(60, base);
  return base + Math.floor(random() * (base + 1));
}
