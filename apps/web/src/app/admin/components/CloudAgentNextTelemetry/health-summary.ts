type ObservedHealthSummary = {
  completedRuns: number;
  failedRuns: number;
  setupFailures: number;
  interruptedRuns: number;
};

export function getOperationalFailureStats(summary: ObservedHealthSummary) {
  const failureEvents = summary.failedRuns + summary.setupFailures;
  const assessedOutcomes = summary.completedRuns + failureEvents;
  return {
    failureEvents,
    assessedOutcomes,
    failureRatePercent: assessedOutcomes === 0 ? null : (failureEvents / assessedOutcomes) * 100,
  };
}
