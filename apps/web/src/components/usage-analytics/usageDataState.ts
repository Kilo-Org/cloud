import {
  isUsageSourceNotConfigured,
  USAGE_SOURCE_NOT_CONFIGURED_MESSAGE,
} from '@kilocode/app-shared/usage-source';

export type UsageQueryOutcome = 'loading' | 'error' | 'success';

export function usageQueryOutcome(query: {
  isLoading: boolean;
  isError: boolean;
  hasData: boolean;
}): UsageQueryOutcome {
  // A background refetch can fail while previous data is still on screen.
  // Only treat that as a dashboard error when there is nothing to keep showing.
  if (query.isError && !query.hasData) return 'error';
  if (query.isLoading) return 'loading';
  return 'success';
}

export type UsageDashboardState = 'error' | 'unavailable' | 'pending' | 'ready';

/**
 * The error the summary or table query saw, when it failed with nothing to
 * keep showing. The dashboard maps the unconfigured-usage-source message to
 * its terminal state; every other failure stays retryable.
 */
export function resolveUsageDashboardState(args: {
  period: string;
  hasActiveFilters: boolean;
  summary: { requestCount: number } | undefined;
  tableRowCount: number | undefined;
  queries: readonly UsageQueryOutcome[];
  summaryError?: unknown;
  tableError?: unknown;
}): UsageDashboardState {
  if (args.queries.includes('error')) {
    const failed = [args.summaryError, args.tableError].find(
      error => error !== undefined && isUsageSourceNotConfigured(readTrpcErrorMessage(error))
    );
    if (failed !== undefined) return 'unavailable';
    return 'error';
  }

  const usageDataPending =
    args.period === 'today' &&
    args.summary !== undefined &&
    args.tableRowCount !== undefined &&
    args.summary.requestCount === 0 &&
    args.tableRowCount === 0 &&
    !args.hasActiveFilters;

  return usageDataPending ? 'pending' : 'ready';
}

/**
 * The tRPC error's own message, when the failure carries one. Matches
 * {@link USAGE_SOURCE_NOT_CONFIGURED_MESSAGE} by identity, the one signal the
 * wire gives a client for the condition.
 */
function readTrpcErrorMessage(error: unknown): string | undefined {
  if (error && typeof error === 'object') {
    const shaped = error as { data?: { message?: unknown } };
    const message = shaped.data?.message;
    if (typeof message === 'string') return message;
  }
  return undefined;
}
