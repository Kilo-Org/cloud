export function getScheduledSeatDecrease(input: {
  currentSeatCount: number;
  providerSeatCount: number | null;
  currentPeriodEnd: number | null;
}) {
  if (input.providerSeatCount === null || input.providerSeatCount >= input.currentSeatCount) {
    return { nextSeatCount: null, nextSeatCountEffectiveAt: null };
  }
  return {
    nextSeatCount: input.providerSeatCount,
    nextSeatCountEffectiveAt: input.currentPeriodEnd
      ? new Date(input.currentPeriodEnd * 1000).toISOString()
      : null,
  };
}
