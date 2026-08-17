import { resolveUsageDashboardState, usageQueryOutcome } from './usageDataState';

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
