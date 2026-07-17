import { describe, expect, it, vi } from 'vitest';

import {
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
        refetch: vi.fn(),
      })
    ).toEqual({ status: 'loading' });
  });

  it('is an error on initial-load failure (no cached data)', () => {
    const refetch = vi.fn();
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

  it('does not error when a refetch fails but stale data is still present', () => {
    expect(
      classifyProviderState({
        isLoading: false,
        isError: true,
        isFetching: false,
        connected: true,
        hasData: true,
        refetch: vi.fn(),
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
        refetch: vi.fn(),
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
        refetch: vi.fn(),
      })
    ).toEqual({ status: 'disconnected' });
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
        refetch: vi.fn(),
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
        refetch: vi.fn(),
      })
    ).toEqual({ status: 'loading' });
  });

  it('is an error when the org list query fails', () => {
    const refetch = vi.fn();
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
          refetch: vi.fn(),
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
        refetch: vi.fn(),
      })
    ).toEqual({ status: 'ready', canEdit: false });

    expect(
      classifyPermission({
        isPersonal: false,
        isLoading: false,
        isError: false,
        isFetching: false,
        role: undefined,
        refetch: vi.fn(),
      })
    ).toEqual({ status: 'ready', canEdit: false });
  });
});
