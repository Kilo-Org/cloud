import { CancelledError, QueryObserver } from '@tanstack/react-query';

import {
  deferred,
  makeTestQueryClient as makeClient,
  QUERY_KEY,
} from './active-sessions-live-sync.test-helpers';
import {
  createKiloAppQueryClient,
  getActiveSessionsQueryMetadata,
  subscribeActiveSessionsQueryMetadata,
} from './query-client';
import { describe, expect, it, vi } from 'vitest';

import { setTrpcUnauthorizedHandler } from '@/lib/auth/trpc-unauthorized';

describe('createKiloAppQueryClient', () => {
  it.each([
    { data: { authRequired: true, httpStatus: 401 } },
    { shape: { data: { authRequired: true, httpStatus: 401 } } },
  ])('runs the unauthorized handler for mutation errors shaped as %j', async metadata => {
    let signedIn = true;
    const clear = setTrpcUnauthorizedHandler(() => {
      signedIn = false;
    });
    const client = createKiloAppQueryClient();
    const error = Object.assign(new Error('unauthorized'), metadata);
    const mutation = client.getMutationCache().build(client, {
      mutationFn: async () => {
        await Promise.resolve();
        throw error;
      },
    });
    await expect(mutation.execute(undefined)).rejects.toBe(error);
    expect(signedIn).toBe(false);
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

const emptyResult = { sessions: [] };

describe('accepted active-session outcomes', () => {
  it('does not accept manual empty data, timestamps, or generic success as a server result', async () => {
    const client = makeClient();
    const absent = getActiveSessionsQueryMetadata(undefined);
    client.setQueryData(QUERY_KEY, emptyResult);
    const query = client.getQueryCache().find({ queryKey: QUERY_KEY, exact: true });
    query?.setState({ status: 'success', dataUpdatedAt: Date.now() - 1 });
    expect(getActiveSessionsQueryMetadata(query)).toBe(absent);
    await client.fetchQuery({ queryKey: QUERY_KEY, queryFn: () => emptyResult, staleTime: 0 });
    const accepted = getActiveSessionsQueryMetadata(query);
    expect(accepted.acceptedRevision).toBe(1);
    client.setQueryData(QUERY_KEY, emptyResult);
    expect(getActiveSessionsQueryMetadata(query)).toBe(accepted);
  });

  it.each([
    ['retryable', new Error('offline')],
    [
      'non-retryable',
      Object.assign(new Error('denied'), { shape: { data: { code: 'FORBIDDEN' } } }),
    ],
  ] as const)(
    'retains the original %s failure through manual writes, retry, and cancellation',
    async (kind, error) => {
      const client = makeClient();
      const observer = new QueryObserver(client, {
        queryKey: QUERY_KEY,
        enabled: false,
        retry: false,
        queryFn: () => {
          throw error;
        },
      });
      const unsubscribe = observer.subscribe(() => undefined);
      // An enabled observer keeps permission failures in the cache.
      observer.setOptions({ ...observer.options, enabled: true });
      await observer.refetch();
      const query = client.getQueryCache().find({ queryKey: QUERY_KEY, exact: true });
      const failed = getActiveSessionsQueryMetadata(query);
      expect(failed.terminalError).toEqual({ error, kind });
      expect(failed.terminalError?.error).toBe(error);
      expect(failed.acceptedRevision).toBe(0);
      client.setQueryData(QUERY_KEY, { sessions: [{ id: 'live', title: 'socket' }] });
      const recovery = deferred<typeof emptyResult>();
      const retry = client.fetchQuery({
        queryKey: QUERY_KEY,
        queryFn: async () => {
          const result = await recovery.promise;
          return result;
        },
      });
      expect(getActiveSessionsQueryMetadata(query)).toBe(failed);
      await client.cancelQueries({ queryKey: QUERY_KEY, exact: true });
      await retry;
      expect(getActiveSessionsQueryMetadata(query)).toBe(failed);
      recovery.resolve(emptyResult);
      await client.fetchQuery({ queryKey: QUERY_KEY, queryFn: () => emptyResult });
      expect(getActiveSessionsQueryMetadata(query)).toEqual({
        acceptedRevision: 1,
        terminalError: null,
      });
      unsubscribe();
    }
  );

  it('ignores retry attempts and a terminal cancellation error', async () => {
    const client = makeClient();
    const result = deferred<typeof emptyResult>();
    let attempts = 0;
    const pending = client.fetchQuery({
      queryKey: QUERY_KEY,
      retry: 1,
      retryDelay: 0,
      queryFn: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('retry attempt');
        }
        const accepted = await result.promise;
        return accepted;
      },
    });
    const query = client.getQueryCache().find({ queryKey: QUERY_KEY, exact: true });
    await vi.waitFor(() => {
      expect(attempts).toBe(2);
    });
    expect(getActiveSessionsQueryMetadata(query)).toBe(getActiveSessionsQueryMetadata(undefined));
    result.reject(new CancelledError());
    await expect(pending).rejects.toBeInstanceOf(CancelledError);
    expect(getActiveSessionsQueryMetadata(query).terminalError).toBeNull();
  });

  it.each(['remove', 'clear'] as const)(
    'preserves provenance across remounts but resets it after %s',
    async removal => {
      const client = makeClient();
      await client.fetchQuery({ queryKey: QUERY_KEY, queryFn: () => emptyResult });
      const query = client.getQueryCache().find({ queryKey: QUERY_KEY, exact: true });
      const accepted = getActiveSessionsQueryMetadata(query);
      const observer = new QueryObserver(client, { queryKey: QUERY_KEY, staleTime: Infinity });
      observer.subscribe(() => undefined)();
      const unsubscribe = observer.subscribe(() => undefined);
      expect(getActiveSessionsQueryMetadata(query)).toBe(accepted);
      unsubscribe();
      const published: number[] = [];
      subscribeActiveSessionsQueryMetadata(query, () => {
        published.push(getActiveSessionsQueryMetadata(query).acceptedRevision);
      });
      if (removal === 'clear') {
        client.clear();
      } else {
        client.removeQueries({ queryKey: QUERY_KEY, exact: true });
      }
      expect(published).toEqual([0]);
      expect(getActiveSessionsQueryMetadata(query)).toBe(getActiveSessionsQueryMetadata(undefined));
      client.setQueryData(QUERY_KEY, emptyResult);
      const recreated = client.getQueryCache().find({ queryKey: QUERY_KEY, exact: true });
      expect(recreated).not.toBe(query);
      expect(getActiveSessionsQueryMetadata(recreated).acceptedRevision).toBe(0);
      await client.fetchQuery({ queryKey: QUERY_KEY, queryFn: () => emptyResult });
      expect(getActiveSessionsQueryMetadata(recreated).acceptedRevision).toBe(1);
      expect(published).toEqual([0]);
    }
  );

  it.each([
    { otherKey: [['activeSessions', 'list', 'detail'], { type: 'query' }] },
    { otherKey: [['activeSessions', 'list'], { type: 'infinite' }] },
    { otherKey: [['cliSessionsV2', 'list'], { type: 'query' }] },
    { otherKey: [['activeSessions', 'list'], { type: 'query' }, 'extra'] },
    { otherKey: ['activeSessions', 'list'] },
  ])('isolates clients and subscriptions and excludes $otherKey', async ({ otherKey }) => {
    const client = makeClient();
    const otherClient = makeClient();
    client.setQueryData(QUERY_KEY, emptyResult);
    otherClient.setQueryData(QUERY_KEY, emptyResult);
    const query = client.getQueryCache().find({ queryKey: QUERY_KEY, exact: true });
    const otherQuery = otherClient.getQueryCache().find({ queryKey: QUERY_KEY, exact: true });
    const published: number[] = [];
    const otherPublished: number[] = [];
    subscribeActiveSessionsQueryMetadata(query, () => {
      published.push(getActiveSessionsQueryMetadata(query).acceptedRevision);
    });
    subscribeActiveSessionsQueryMetadata(otherQuery, () => {
      otherPublished.push(getActiveSessionsQueryMetadata(otherQuery).acceptedRevision);
    });
    await client.fetchQuery({ queryKey: otherKey, queryFn: () => emptyResult });
    expect(
      getActiveSessionsQueryMetadata(client.getQueryCache().find({ queryKey: otherKey }))
        .acceptedRevision
    ).toBe(0);
    expect(published).toEqual([]);
    await client.fetchQuery({ queryKey: QUERY_KEY, queryFn: () => emptyResult });
    expect(published).toEqual([1]);
    client.setQueryData(QUERY_KEY, emptyResult);
    expect(published).toEqual([1]);
    await client.fetchQuery({ queryKey: QUERY_KEY, queryFn: () => emptyResult });
    expect(published).toEqual([1, 2]);
    expect(otherPublished).toEqual([]);
    expect(getActiveSessionsQueryMetadata(otherQuery).acceptedRevision).toBe(0);
  });
});
