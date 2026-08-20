import { QueryObserver } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import { setTrpcUnauthorizedHandler } from '@/lib/auth/trpc-unauthorized';

import { createKiloAppQueryClient } from './query-client';

describe('createKiloAppQueryClient', () => {
  it('runs the registered unauthorized handler for mutation 401 errors', async () => {
    const signOut = vi.fn();
    const clear = setTrpcUnauthorizedHandler(signOut);
    const queryClient = createKiloAppQueryClient();
    const error = Object.assign(new Error('unauthorized'), {
      data: { authRequired: true, httpStatus: 401 },
    });

    const mutation = queryClient.getMutationCache().build(queryClient, {
      mutationFn: async () => {
        await Promise.resolve();
        throw error;
      },
    });

    await expect(mutation.execute(undefined)).rejects.toBe(error);
    expect(signOut).toHaveBeenCalledTimes(1);
    clear();
  });

  it('runs the registered unauthorized handler for shaped mutation 401 errors', async () => {
    const signOut = vi.fn();
    const clear = setTrpcUnauthorizedHandler(signOut);
    const queryClient = createKiloAppQueryClient();
    const error = Object.assign(new Error('unauthorized'), {
      shape: { data: { authRequired: true, httpStatus: 401 } },
    });

    const mutation = queryClient.getMutationCache().build(queryClient, {
      mutationFn: async () => {
        await Promise.resolve();
        throw error;
      },
    });

    await expect(mutation.execute(undefined)).rejects.toBe(error);
    expect(signOut).toHaveBeenCalledTimes(1);
    clear();
  });
});

describe('permission-denied query removal', () => {
  it('removes an org-scoped query on FORBIDDEN and keeps the user signed in', async () => {
    const signOut = vi.fn();
    const clear = setTrpcUnauthorizedHandler(signOut);
    const queryClient = createKiloAppQueryClient();

    const org1Key: readonly unknown[] = [
      ['organizations', 'withMembers'],
      { type: 'query', input: { organizationId: 'org-1' } },
    ];
    const org2Key: readonly unknown[] = [
      ['organizations', 'withMembers'],
      { type: 'query', input: { organizationId: 'org-2' } },
    ];
    queryClient.setQueryData(org1Key, { members: ['a'] });
    queryClient.setQueryData(org2Key, { members: ['b'] });

    const error = Object.assign(new Error('forbidden'), {
      data: { code: 'FORBIDDEN', httpStatus: 403 },
    });

    await expect(
      queryClient.fetchQuery({
        queryKey: org1Key,
        queryFn: () => {
          throw error;
        },
      })
    ).rejects.toBe(error);

    // The forbidden org's query is dropped; the sibling org's query survives.
    expect(queryClient.getQueryData(org1Key)).toBeUndefined();
    expect(queryClient.getQueryData(org2Key)).toEqual({ members: ['b'] });
    // Permission loss never signs the user out.
    expect(signOut).not.toHaveBeenCalled();
    clear();
  });

  it('removes a procedure UNAUTHORIZED without authRequired and keeps the user signed in', async () => {
    const signOut = vi.fn();
    const clear = setTrpcUnauthorizedHandler(signOut);
    const queryClient = createKiloAppQueryClient();

    const key: readonly unknown[] = [
      ['organizations', 'withMembers'],
      { type: 'query', input: { organizationId: 'org-1' } },
    ];
    queryClient.setQueryData(key, { members: ['a'] });

    const error = Object.assign(new Error('unauthorized'), {
      data: { code: 'UNAUTHORIZED', httpStatus: 401 },
    });

    await expect(
      queryClient.fetchQuery({
        queryKey: key,
        queryFn: () => {
          throw error;
        },
      })
    ).rejects.toBe(error);

    expect(queryClient.getQueryData(key)).toBeUndefined();
    expect(signOut).not.toHaveBeenCalled();
    clear();
  });

  it('keeps an actively-observed query in the cache on FORBIDDEN', async () => {
    const signOut = vi.fn();
    const clear = setTrpcUnauthorizedHandler(signOut);
    const queryClient = createKiloAppQueryClient();

    const key: readonly unknown[] = [
      ['organizations', 'withMembers'],
      { type: 'query', input: { organizationId: 'org-1' } },
    ];
    queryClient.setQueryData(key, { members: ['a'] });

    const error = Object.assign(new Error('forbidden'), {
      data: { code: 'FORBIDDEN', httpStatus: 403 },
    });

    const observer = new QueryObserver(queryClient, {
      queryKey: key,
      queryFn: () => {
        throw error;
      },
      retry: false,
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => undefined);

    // The observer makes the query active; a forced refetch fails FORBIDDEN but
    // must not drop the still-observed query (removal would rebuild and loop).
    await observer.refetch().catch(() => undefined);

    expect(queryClient.getQueryData(key)).toEqual({ members: ['a'] });
    expect(signOut).not.toHaveBeenCalled();
    unsubscribe();
    clear();
  });

  it('keeps a non-permission query error in the cache', async () => {
    const signOut = vi.fn();
    const clear = setTrpcUnauthorizedHandler(signOut);
    const queryClient = createKiloAppQueryClient();

    const key: readonly unknown[] = [
      ['organizations', 'withMembers'],
      { type: 'query', input: { organizationId: 'org-1' } },
    ];
    queryClient.setQueryData(key, { members: ['a'] });

    const error = Object.assign(new Error('not found'), {
      data: { code: 'NOT_FOUND', httpStatus: 404 },
    });

    await expect(
      queryClient.fetchQuery({
        queryKey: key,
        queryFn: () => {
          throw error;
        },
      })
    ).rejects.toBe(error);

    // A non-permission failure must not drop the cached data.
    expect(queryClient.getQueryData(key)).toEqual({ members: ['a'] });
    expect(signOut).not.toHaveBeenCalled();
    clear();
  });
});
