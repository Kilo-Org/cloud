import { describe, expect, it } from 'vitest';

import { classifyListBody } from '@/lib/query/list-body-state';

const base = {
  rowCount: 0,
  hasDeliveredData: false,
  isError: false,
  isFetching: false,
  fetchStatus: 'idle' as const,
  connectivityKnown: true,
};

describe('classifyListBody', () => {
  it('renders rows from delivered data', () => {
    expect(classifyListBody({ ...base, rowCount: 2, hasDeliveredData: true })).toEqual({
      status: 'rows',
    });
  });

  it('keeps rows while a background refetch runs', () => {
    expect(
      classifyListBody({
        ...base,
        rowCount: 2,
        hasDeliveredData: true,
        isFetching: true,
        fetchStatus: 'fetching',
      })
    ).toEqual({ status: 'rows' });
  });

  it('keeps rows when a later page failed, so its inline Retry stays reachable', () => {
    expect(classifyListBody({ ...base, hasInlineError: true, isError: true })).toEqual({
      status: 'rows',
    });
  });

  it('reports a failed read with no rows as a failure', () => {
    expect(classifyListBody({ ...base, isError: true, isFetching: true })).toEqual({
      status: 'error',
      cause: 'failed',
      isRetrying: true,
    });
  });

  it('claims empty only for a delivered empty result', () => {
    expect(classifyListBody({ ...base, hasDeliveredData: true })).toEqual({ status: 'empty' });
  });

  it('names the connection when the read is paused and connectivity is known', () => {
    expect(
      classifyListBody({
        ...base,
        hasDeliveredData: false,
        fetchStatus: 'paused',
        isFetching: false,
      })
    ).toEqual({ status: 'error', cause: 'offline', isRetrying: false });
  });

  it('keeps loading while the paused read cannot be attributed yet', () => {
    expect(classifyListBody({ ...base, fetchStatus: 'paused', connectivityKnown: false })).toEqual({
      status: 'loading',
    });
  });

  it('never treats a reset cache as an empty result', () => {
    // A query whose pages were cleared holds no rows and is neither loading
    // nor errored; only `hasDeliveredData` decides, so it stays loading.
    expect(classifyListBody({ ...base, rowCount: 0, hasDeliveredData: false })).toEqual({
      status: 'loading',
    });
  });

  it('prefers a failure over an undelivered empty cache', () => {
    expect(classifyListBody({ ...base, isError: true })).toEqual({
      status: 'error',
      cause: 'failed',
      isRetrying: false,
    });
  });
});
