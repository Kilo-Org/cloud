import { describe, expect, it, vi } from 'vitest';

import {
  classifyConfigBody,
  classifyPermission,
  classifyProviderErrorCode,
  classifyProviderState,
} from './code-reviewer-status';

describe('classifyProviderErrorCode', () => {
  it('treats FORBIDDEN and UNAUTHORIZED as a permanent permission error (no retry)', () => {
    expect(classifyProviderErrorCode('FORBIDDEN')).toEqual({
      permanent: true,
      variant: 'permission',
    });
    expect(classifyProviderErrorCode('UNAUTHORIZED')).toEqual({
      permanent: true,
      variant: 'permission',
    });
  });

  it('treats NOT_FOUND as a permanent not-found error', () => {
    expect(classifyProviderErrorCode('NOT_FOUND')).toEqual({
      permanent: true,
      variant: 'not-found',
    });
  });

  it('treats other/unknown codes as a transient, retriable server error', () => {
    expect(classifyProviderErrorCode('INTERNAL_SERVER_ERROR')).toEqual({
      permanent: false,
      variant: 'server',
    });
    expect(classifyProviderErrorCode(undefined)).toEqual({ permanent: false, variant: 'server' });
  });
});

describe('classifyProviderState', () => {
  it('is loading while the query is loading', () => {
    expect(
      classifyProviderState({
        isLoading: true,
        isError: false,
        isFetching: true,
        connected: undefined,
        hasData: false,
        refetch: vi.fn<() => void>(),
      })
    ).toEqual({ status: 'loading' });
  });

  it('is an error on initial-load failure (no cached data)', () => {
    const refetch = vi.fn<() => void>();
    const result = classifyProviderState({
      isLoading: false,
      isError: true,
      isFetching: false,
      connected: undefined,
      hasData: false,
      refetch,
    });
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      result.refetch();
      expect(refetch).toHaveBeenCalledTimes(1);
    }
  });

  it('regression: a query error never renders Connect (never disconnected)', () => {
    // A failed connect-state query must surface as an error, not fall through
    // to `disconnected`, which is the state that renders the Connect card.
    const result = classifyProviderState({
      isLoading: false,
      isError: true,
      isFetching: false,
      connected: false,
      hasData: false,
      refetch: vi.fn<() => void>(),
    });
    expect(result.status).toBe('error');
    expect(result.status).not.toBe('disconnected');
  });

  it('does not error when a refetch fails but stale data is still present', () => {
    expect(
      classifyProviderState({
        isLoading: false,
        isError: true,
        isFetching: false,
        connected: true,
        hasData: true,
        refetch: vi.fn<() => void>(),
      })
    ).toEqual({ status: 'connected' });
  });

  it('is connected when the query resolves connected: true', () => {
    expect(
      classifyProviderState({
        isLoading: false,
        isError: false,
        isFetching: false,
        connected: true,
        hasData: true,
        refetch: vi.fn<() => void>(),
      })
    ).toEqual({ status: 'connected' });
  });

  it('is disconnected when the query resolves connected: false', () => {
    expect(
      classifyProviderState({
        isLoading: false,
        isError: false,
        isFetching: false,
        connected: false,
        hasData: true,
        refetch: vi.fn<() => void>(),
      })
    ).toEqual({ status: 'disconnected' });
  });

  it('is loading (not disconnected) when the query is paused with no data yet', () => {
    // A paused query (offline/unknown connectivity, empty cache) is pending
    // but not fetching, so isLoading is false while data is still undefined.
    // It must not fall through to disconnected (which renders the Connect
    // card) on a cold launch.
    expect(
      classifyProviderState({
        isLoading: false,
        isError: false,
        isFetching: false,
        connected: undefined,
        hasData: false,
        refetch: vi.fn<() => void>(),
      })
    ).toEqual({ status: 'loading' });
  });
});

describe('classifyConfigBody', () => {
  const base = {
    hasData: false,
    isError: false,
    isFetching: false,
    fetchStatus: 'fetching' as const,
    connectivityKnown: true,
    refetch: vi.fn<() => void>(),
  };

  it('treats a pending, idle read as loading, and marks it idle', () => {
    // A cancelled first fetch reverts to exactly this state: pending, nothing
    // in flight, no data, no error. It matched none of the screen's separate
    // tests and painted a header over an empty body.
    expect(classifyConfigBody({ ...base, fetchStatus: 'idle' })).toEqual({
      status: 'loading',
      idle: true,
    });
  });

  it('treats an in-flight first read as loading, not idle', () => {
    expect(classifyConfigBody({ ...base, fetchStatus: 'fetching', isFetching: true })).toEqual({
      status: 'loading',
      idle: false,
    });
  });

  it('reports a failed first read as a server error with retry', () => {
    const refetch = vi.fn<() => void>();
    const result = classifyConfigBody({ ...base, isError: true, refetch });
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.variant).toBe('server');
      result.refetch();
      expect(refetch).toHaveBeenCalledTimes(1);
    }
  });

  it('reports a paused read as offline once connectivity is known', () => {
    const result = classifyConfigBody({ ...base, fetchStatus: 'paused' });
    expect(result).toEqual({
      status: 'error',
      variant: 'offline',
      isRetrying: false,
      refetch: base.refetch,
    });
  });

  it('keeps an unsettled pause on the loading surface', () => {
    // Connectivity is still `unknown`: the pause may clear by itself, so the
    // screen keeps the skeleton instead of claiming the user is offline.
    expect(
      classifyConfigBody({ ...base, fetchStatus: 'paused', connectivityKnown: false })
    ).toEqual({ status: 'loading', idle: false });
  });

  it('keeps cached config on the rows through a failed background refetch', () => {
    expect(
      classifyConfigBody({ ...base, hasData: true, isError: true, isFetching: false })
    ).toEqual({ status: 'ready' });
  });

  it('is ready for cached config', () => {
    expect(classifyConfigBody({ ...base, hasData: true, fetchStatus: 'idle' })).toEqual({
      status: 'ready',
    });
  });
});

describe('classifyPermission', () => {
  it('is always ready+editable for a personal scope, regardless of query state', () => {
    expect(
      classifyPermission({
        isPersonal: true,
        isLoading: true,
        isError: true,
        isFetching: true,
        role: undefined,
        refetch: vi.fn<() => void>(),
      })
    ).toEqual({ status: 'ready', canEdit: true });
  });

  it('is loading while the org list query is loading', () => {
    expect(
      classifyPermission({
        isPersonal: false,
        isLoading: true,
        isError: false,
        isFetching: true,
        role: undefined,
        refetch: vi.fn<() => void>(),
      })
    ).toEqual({ status: 'loading' });
  });

  it('is an error when the org list query fails', () => {
    const refetch = vi.fn<() => void>();
    const result = classifyPermission({
      isPersonal: false,
      isLoading: false,
      isError: true,
      isFetching: false,
      role: undefined,
      refetch,
    });
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      result.refetch();
      expect(refetch).toHaveBeenCalledTimes(1);
    }
  });

  it('grants edit for owner and billing_manager roles once loaded', () => {
    for (const role of ['owner', 'billing_manager']) {
      expect(
        classifyPermission({
          isPersonal: false,
          isLoading: false,
          isError: false,
          isFetching: false,
          role,
          refetch: vi.fn<() => void>(),
        })
      ).toEqual({ status: 'ready', canEdit: true });
    }
  });

  it('denies edit for member role or an unresolved org', () => {
    expect(
      classifyPermission({
        isPersonal: false,
        isLoading: false,
        isError: false,
        isFetching: false,
        role: 'member',
        refetch: vi.fn<() => void>(),
      })
    ).toEqual({ status: 'ready', canEdit: false });

    expect(
      classifyPermission({
        isPersonal: false,
        isLoading: false,
        isError: false,
        isFetching: false,
        role: undefined,
        refetch: vi.fn<() => void>(),
      })
    ).toEqual({ status: 'ready', canEdit: false });
  });
});
