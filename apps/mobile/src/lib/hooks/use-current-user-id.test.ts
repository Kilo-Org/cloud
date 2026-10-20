import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useCurrentUserId } from './use-current-user-id';

const query = vi.hoisted(() => ({
  data: undefined as { id: string; email: string } | undefined,
  error: null as unknown,
  fetchStatus: 'idle' as 'fetching' | 'paused' | 'idle',
  isLoading: false,
  isError: false,
  isFetched: false,
  refetch: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({ useQuery: () => query }));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({ user: { getMe: { queryOptions: () => ({}) } } }),
}));

describe('useCurrentUserId', () => {
  beforeEach(() => {
    Object.assign(query, {
      data: undefined,
      error: null,
      fetchStatus: 'idle',
      isLoading: false,
      isError: false,
      isFetched: false,
    });
  });

  it('keeps the error state visible while a failed request retries', () => {
    Object.assign(query, { isLoading: true, isFetched: true });

    expect(useCurrentUserId().isError).toBe(true);
  });

  it('does not turn the initial loading state into an error', () => {
    Object.assign(query, { isLoading: true });

    expect(useCurrentUserId().isError).toBe(false);
  });

  it('keeps a settled request error visible', () => {
    Object.assign(query, { isError: true, isFetched: true });

    expect(useCurrentUserId().isError).toBe(true);
  });

  it('clears the error state after a successful retry', () => {
    Object.assign(query, {
      data: { id: 'user-1', email: 'user@example.com' },
      isFetched: true,
    });

    expect(useCurrentUserId().isError).toBe(false);
  });

  it('does not treat a refetch failure as missing identity when the user is cached', () => {
    Object.assign(query, {
      data: { id: 'user-1', email: 'user@example.com' },
      isError: true,
      isFetched: true,
    });

    expect(useCurrentUserId().isError).toBe(false);
    expect(useCurrentUserId().userId).toBe('user-1');
  });

  it('reports the fetch failure while a cached identity is still present', () => {
    Object.assign(query, {
      data: { id: 'user-1', email: 'user@example.com' },
      isError: true,
      isFetched: true,
    });

    expect(useCurrentUserId().isFetchError).toBe(true);
  });

  it('reports no fetch failure on the initial load or after a success', () => {
    Object.assign(query, { isLoading: true, isFetched: false });
    expect(useCurrentUserId().isFetchError).toBe(false);

    Object.assign(query, {
      data: { id: 'user-1', email: 'user@example.com' },
      isLoading: false,
      isError: false,
      isFetched: true,
    });
    expect(useCurrentUserId().isFetchError).toBe(false);
  });

  describe('isUnreachable', () => {
    it('holds after a failure a retry can fix, and through that retry', () => {
      Object.assign(query, {
        error: new Error('Network request failed'),
        isError: true,
        isFetched: true,
      });
      expect(useCurrentUserId().isUnreachable).toBe(true);

      Object.assign(query, {
        error: null,
        isError: false,
        isLoading: true,
        fetchStatus: 'fetching',
      });
      expect(useCurrentUserId().isUnreachable).toBe(true);
    });

    it('does not hold when the API refuses the credentials', () => {
      Object.assign(query, {
        error: { data: { code: 'UNAUTHORIZED' } },
        isError: true,
        isFetched: true,
      });

      expect(useCurrentUserId().isUnreachable).toBe(false);
    });

    it('does not hold on the first load, or once the account is confirmed', () => {
      Object.assign(query, { isLoading: true, fetchStatus: 'fetching' });
      expect(useCurrentUserId().isUnreachable).toBe(false);

      Object.assign(query, {
        data: { id: 'user-1', email: 'user@example.com' },
        isLoading: false,
        fetchStatus: 'idle',
        isFetched: true,
      });
      expect(useCurrentUserId().isUnreachable).toBe(false);
    });
  });
});
