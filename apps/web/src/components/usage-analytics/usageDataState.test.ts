import {
  isUsageSourceNotConfigured,
  USAGE_SOURCE_NOT_CONFIGURED_MESSAGE,
} from '@kilocode/app-shared/usage-source';
import { resolveUsageDashboardState, usageQueryOutcome } from './usageDataState';

/** The tRPC-shaped failure the dashboard's queries put on `error`. */
function trpcFailure(message: string): unknown {
  return { data: { code: 'INTERNAL_SERVER_ERROR', message } };
}

describe('usageQueryOutcome', () => {
  it('treats a failed initial load as an error, not as empty', () => {
    expect(usageQueryOutcome({ isLoading: true, isError: true, hasData: false })).toBe('error');
    expect(usageQueryOutcome({ isLoading: true, isError: false, hasData: false })).toBe('loading');
    expect(usageQueryOutcome({ isLoading: false, isError: false, hasData: true })).toBe('success');
  });

  it('keeps cached data after a failed background refetch', () => {
    expect(usageQueryOutcome({ isLoading: false, isError: true, hasData: true })).toBe('success');
  });
});

describe('resolveUsageDashboardState', () => {
  const emptyToday = {
    period: 'today',
    hasActiveFilters: false,
    summary: { requestCount: 0 },
    tableRowCount: 0,
  };

  it('treats a failed query as an error, not as no data', () => {
    expect(
      resolveUsageDashboardState({
        ...emptyToday,
        summary: undefined,
        tableRowCount: undefined,
        queries: ['error', 'success'],
      })
    ).toBe('error');
  });

  it('maps the unconfigured usage-source message on the summary error to the terminal state', () => {
    expect(
      resolveUsageDashboardState({
        ...emptyToday,
        summary: undefined,
        tableRowCount: undefined,
        queries: ['error', 'success'],
        summaryError: trpcFailure(USAGE_SOURCE_NOT_CONFIGURED_MESSAGE),
      })
    ).toBe('unavailable');
  });

  it('maps the unconfigured usage-source message on the table error to the terminal state', () => {
    expect(
      resolveUsageDashboardState({
        ...emptyToday,
        summary: undefined,
        tableRowCount: undefined,
        queries: ['success', 'error'],
        tableError: trpcFailure(USAGE_SOURCE_NOT_CONFIGURED_MESSAGE),
      })
    ).toBe('unavailable');
  });

  it('keeps a warehouse failure retryable even when the summary also failed', () => {
    expect(
      resolveUsageDashboardState({
        ...emptyToday,
        summary: undefined,
        tableRowCount: undefined,
        queries: ['error', 'error'],
        summaryError: trpcFailure('Usage data temporarily unavailable'),
        tableError: trpcFailure(USAGE_SOURCE_NOT_CONFIGURED_MESSAGE),
      })
    ).toBe('unavailable');
    expect(
      resolveUsageDashboardState({
        ...emptyToday,
        summary: undefined,
        tableRowCount: undefined,
        queries: ['error', 'success'],
        summaryError: trpcFailure('Usage data temporarily unavailable'),
      })
    ).toBe('error');
  });

  it('matches the condition through the shared matcher', () => {
    expect(isUsageSourceNotConfigured(USAGE_SOURCE_NOT_CONFIGURED_MESSAGE)).toBe(true);
    expect(isUsageSourceNotConfigured('Usage data temporarily unavailable')).toBe(false);
  });

  it('shows the catching-up state only after successful empty today queries', () => {
    expect(
      resolveUsageDashboardState({
        ...emptyToday,
        queries: ['success', 'success'],
      })
    ).toBe('pending');
  });

  it('does not treat an in-flight empty day as pending or as an error', () => {
    expect(
      resolveUsageDashboardState({
        ...emptyToday,
        summary: undefined,
        tableRowCount: undefined,
        queries: ['loading', 'loading'],
      })
    ).toBe('ready');
  });

  it('keeps a successful non-empty report in the ready state', () => {
    expect(
      resolveUsageDashboardState({
        period: 'today',
        hasActiveFilters: false,
        summary: { requestCount: 4 },
        tableRowCount: 4,
        queries: ['success', 'success'],
      })
    ).toBe('ready');
  });
});
