import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useCurrentUserId } from './use-current-user-id';

const query = vi.hoisted(() => ({
  data: undefined as { id: string; email: string } | undefined,
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
});
