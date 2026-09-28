import type { inferRouterOutputs } from '@trpc/server';
import type { RootRouter } from '@/routers/root-router';

export type SessionFailureHistory = inferRouterOutputs<RootRouter>['cloudAgentNextFailures']['getSessionFailureHistory'];

export type SessionFailureSummary = {
  hasFailures: boolean;
  failedRuns: SessionFailureHistory['runs'];
  completedCount: number;
};

export function summarizeSessionFailureHistory(
  history: SessionFailureHistory
): SessionFailureSummary {
  const failedRuns = history.runs.filter(run => run.status === 'failed');
  return {
    hasFailures: history.setupFailure !== null || failedRuns.length > 0,
    failedRuns,
    completedCount: history.runs.filter(run => run.status === 'completed').length,
  };
}
