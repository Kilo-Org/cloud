/** Format session spend like mobile `formatCost`: always `$X.XXXX`. */
export const formatSessionCost = (cost: number): string => {
  if (!Number.isFinite(cost) || cost <= 0) {
    return '$0.0000';
  }

  return `$${cost.toFixed(4)}`;
};

/**
 * Add a completion's USD cost to a running session total.
 * Missing, non-finite, or negative values leave the previous total unchanged.
 */
export const addSessionCost = (previous: number, costUsd: number | undefined): number => {
  if (costUsd === undefined || !Number.isFinite(costUsd) || costUsd < 0) {
    return previous;
  }

  return previous + costUsd;
};
