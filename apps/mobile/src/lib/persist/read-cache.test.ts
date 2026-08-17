/* eslint-disable max-lines -- cohesive unit suite for the read-cache allowlist, budget, fences, takeover, mismatch, and cleanup contract */
/* eslint-disable require-await, @typescript-eslint/require-await -- the fake KV factories settle without await because they resolve immediately */
import { type Query, QueryClient } from '@tanstack/react-query';
import { type PersistedClient } from '@tanstack/react-query-persist-client';
import * as SecureStore from 'expo-secure-store';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { bumpAuthEpoch, currentAuthEpoch } from '@/lib/auth/auth-epoch';
import { ACTIVE_USER_ID_KEY } from '@/lib/storage-keys';

// The read cache calls the encrypted-kv module directly; the mock below is an
// in-memory per-scope store with the real map semantics, and it also keeps the
// native SQLCipher chain out of this node suite.
const kvMock = vi.hoisted(() => {
  const scopes = new Map<string, Map<string, string>>();
  return {
    scopes,
    getItem: vi.fn<(scope: string, k: string) => Promise<string | null>>(
      async (scope, k) => scopes.get(scope)?.get(k) ?? null
    ),
    setItem: vi.fn(async (scope: string, k: string, v: string) => {
      let bucket = scopes.get(scope);
      if (!bucket) {
        bucket = new Map<string, string>();
        scopes.set(scope, bucket);
      }
      bucket.set(k, v);
    }),
    removeItem: vi.fn(async (scope: string, k: string) => {
      scopes.get(scope)?.delete(k);
    }),
    clearScope: vi.fn(async (scope: string) => {
      scopes.delete(scope);
    }),
    clearScopePrefix: vi.fn(async (prefix: string) => {
      for (const scope of scopes.keys()) {
        if (scope.startsWith(prefix)) {
          scopes.delete(scope);
        }
      }
    }),
  };
});

vi.mock('@/lib/persist/encrypted-kv', () => ({
  getItem: kvMock.getItem,
  setItem: kvMock.setItem,
  removeItem: kvMock.removeItem,
  clearScope: kvMock.clearScope,
  clearScopePrefix: kvMock.clearScopePrefix,
}));

const store = new Map<string, string>();

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => store.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    store.delete(key);
  }),
}));

/* eslint-disable import/first */
import {
  clearCacheScopeForSignOut,
  createReadCachePersister,
  isReadCacheAllowedKey,
  READ_CACHE_MAX_AGE_MS,
  READ_CACHE_MAX_BYTES,
  readCachedUserId,
  readCacheScope,
  resetReadCacheForTests,
  restorePersistedCacheOnColdStart,
  SCHEMA_VERSION,
  setSignOutActive,
  shouldPersistReadCacheQuery,
  takeOverColdStartRestore,
} from './read-cache';
import { GET_ME_QUERY_KEY, makePersistedClient } from './test-fixtures';
/* eslint-enable import/first */

// The flat application key that must be denied without throwing.
const FLAT_APPLICATION_KEY: readonly unknown[] = ['org-default-model', 'model-1'];

/** The shared encrypted-kv mock, with an empty store for one test. */
function createFakeKv(): { kv: typeof kvMock; scopes: Map<string, Map<string, string>> } {
  kvMock.scopes.clear();
  return { kv: kvMock, scopes: kvMock.scopes };
}

function queryLike(state: Partial<Query['state']>, queryKey: unknown): Query {
  return { state, queryKey } as unknown as Query;
}

function makeAuthoritativeQueryClient(userId: string): QueryClient {
  const queryClient = new QueryClient();
  queryClient.setQueryData(GET_ME_QUERY_KEY, { id: userId });
  return queryClient;
}

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  resetReadCacheForTests();
});

describe('scope derivation', () => {
  it('derives one scope per user per schema version', () => {
    expect(SCHEMA_VERSION).toBe(1);
    expect(readCacheScope('u1')).toBe('cache:u1:1');
    expect(readCacheScope('u2')).toBe('cache:u2:1');
  });
});

describe('allowlist filter', () => {
  it('allows the default no-input procedures', () => {
    expect(isReadCacheAllowedKey([['user', 'getMe'], { type: 'query' }])).toBe(true);
    expect(isReadCacheAllowedKey([['organizations', 'list'], { type: 'query' }])).toBe(true);
    expect(
      isReadCacheAllowedKey([['cliSessionsV2', 'recentRepositories'], { type: 'query' }])
    ).toBe(true);
  });

  it('denies a no-input cliSessionsV2.list key: the default always carries input', () => {
    // The real list key always carries the default input object from
    // `buildAgentSessionListInput`, so a bare `{ type: 'query' }` shape is not
    // the approved snapshot shape.
    expect(isReadCacheAllowedKey([['cliSessionsV2', 'list'], { type: 'query' }])).toBe(false);
  });

  it('allows the default personal-context list input with an omitted organization', () => {
    // A caller that omits the organization option still builds the personal
    // default: `organizationId` is then `undefined`, which is not an
    // organization-scoped variant.
    expect(
      isReadCacheAllowedKey([
        ['cliSessionsV2', 'list'],
        {
          type: 'query',
          input: {
            limit: 30,
            orderBy: 'updated_at',
            includeChildren: false,
            createdOnPlatform: undefined,
            gitUrl: undefined,
            organizationId: undefined,
          },
        },
      ])
    ).toBe(true);
  });

  it('denies partial, empty, and cursor-bearing list inputs', () => {
    // A partial input is not the default shape the app builds: an empty
    // input, a bare cursor, or an unrelated field all diverge from it.
    expect(isReadCacheAllowedKey([['cliSessionsV2', 'list'], { type: 'query', input: {} }])).toBe(
      false
    );
    expect(
      isReadCacheAllowedKey([['cliSessionsV2', 'list'], { type: 'query', input: { cursor: null } }])
    ).toBe(false);
    expect(
      isReadCacheAllowedKey([['cliSessionsV2', 'list'], { type: 'query', input: { pageSize: 20 } }])
    ).toBe(false);
    expect(
      isReadCacheAllowedKey([['cliSessionsV2', 'list'], { type: 'query', input: { limit: 30 } }])
    ).toBe(false);
  });

  it('allows the default personal-context recentRepositories variant', () => {
    expect(
      isReadCacheAllowedKey([
        ['cliSessionsV2', 'recentRepositories'],
        { type: 'query', input: { organizationId: null } },
      ])
    ).toBe(true);
  });

  it('allows the real infinite cliSessionsV2.list first-page key the app builds', () => {
    // `useStoredSessions` builds exactly this key via
    // `trpc.cliSessionsV2.list.infiniteQueryOptions(buildAgentSessionListInput(...))`:
    // the library stores the input without a cursor and marks the meta segment
    // `type: 'infinite'`.
    const realFirstPageKey: readonly unknown[] = [
      ['cliSessionsV2', 'list'],
      {
        input: {
          limit: 30,
          orderBy: 'updated_at',
          includeChildren: false,
          createdOnPlatform: undefined,
          gitUrl: undefined,
          organizationId: null,
        },
        type: 'infinite',
      },
    ];
    expect(isReadCacheAllowedKey(realFirstPageKey)).toBe(true);
  });

  it('allows the real recentRepositories key the app builds', () => {
    // `useRecentAgentRepositories` always passes `updatedSince`; only the
    // personal-context variant (no organizationId) persists.
    expect(
      isReadCacheAllowedKey([
        ['cliSessionsV2', 'recentRepositories'],
        {
          type: 'query',
          input: { organizationId: null, updatedSince: '2026-07-07T00:00:00.000Z' },
        },
      ])
    ).toBe(true);
  });

  it('denies organization, repo, platform, sort, extra-field, and cursor list variants', () => {
    const defaultInput = {
      limit: 30,
      orderBy: 'updated_at',
      includeChildren: false,
      createdOnPlatform: undefined,
      gitUrl: undefined,
      organizationId: null,
    };
    expect(
      isReadCacheAllowedKey([
        ['cliSessionsV2', 'list'],
        { type: 'query', input: { ...defaultInput, organizationId: 'org-1' } },
      ])
    ).toBe(false);
    expect(
      isReadCacheAllowedKey([
        ['cliSessionsV2', 'list'],
        { type: 'query', input: { ...defaultInput, gitUrl: 'https://github.com/foo/bar' } },
      ])
    ).toBe(false);
    expect(
      isReadCacheAllowedKey([
        ['cliSessionsV2', 'list'],
        { type: 'query', input: { ...defaultInput, createdOnPlatform: 'cli' } },
      ])
    ).toBe(false);
    expect(
      isReadCacheAllowedKey([
        ['cliSessionsV2', 'list'],
        { type: 'query', input: { ...defaultInput, orderBy: 'created_at' } },
      ])
    ).toBe(false);
    expect(
      isReadCacheAllowedKey([
        ['cliSessionsV2', 'list'],
        { type: 'query', input: { ...defaultInput, version: 2 } },
      ])
    ).toBe(false);
    expect(
      isReadCacheAllowedKey([
        ['cliSessionsV2', 'list'],
        { type: 'query', input: { ...defaultInput, fetchReviewDecision: true } },
      ])
    ).toBe(false);
    expect(
      isReadCacheAllowedKey([
        ['cliSessionsV2', 'list'],
        { type: 'query', input: { ...defaultInput, cursor: 'abc' } },
      ])
    ).toBe(false);
    expect(
      isReadCacheAllowedKey([
        ['cliSessionsV2', 'list'],
        { type: 'query', input: { ...defaultInput, cursor: 20 } },
      ])
    ).toBe(false);
  });

  it('denies organization-scoped recentRepositories variants', () => {
    expect(
      isReadCacheAllowedKey([
        ['cliSessionsV2', 'recentRepositories'],
        { type: 'query', input: { organizationId: 'org-1' } },
      ])
    ).toBe(false);
  });

  it('denies getMe with any input', () => {
    expect(
      isReadCacheAllowedKey([['user', 'getMe'], { type: 'query', input: { fields: ['id'] } }])
    ).toBe(false);
  });

  it('denies unknown, flat, and malformed shapes without throwing', () => {
    expect(isReadCacheAllowedKey([['unknown', 'procedure'], { type: 'query' }])).toBe(false);
    // Every sensitive path is off the allowlist, so it is denied for that
    // reason alone: transcripts, patches, diffs, tokens, secrets, kiloclaw.
    expect(
      isReadCacheAllowedKey([['cliSessionsV2', 'getSessionMessagesPage'], { type: 'query' }])
    ).toBe(false);
    expect(isReadCacheAllowedKey([['git', 'getPatch'], { type: 'query' }])).toBe(false);
    expect(isReadCacheAllowedKey([['auth', 'getToken'], { type: 'query' }])).toBe(false);
    expect(isReadCacheAllowedKey([['kiloclaw', 'list'], { type: 'query' }])).toBe(false);
    expect(isReadCacheAllowedKey(FLAT_APPLICATION_KEY)).toBe(false);
    expect(isReadCacheAllowedKey('flat-key')).toBe(false);
    expect(isReadCacheAllowedKey(null)).toBe(false);
    expect(isReadCacheAllowedKey(undefined)).toBe(false);
    expect(isReadCacheAllowedKey({})).toBe(false);
    expect(isReadCacheAllowedKey([])).toBe(false);
    expect(isReadCacheAllowedKey([['user', 'getMe']])).toBe(false);
    expect(isReadCacheAllowedKey([[], { type: 'query' }])).toBe(false);
  });
});

describe('dehydration filter', () => {
  it('persists only successful queries on allowlisted shapes', () => {
    expect(shouldPersistReadCacheQuery(queryLike({ status: 'success' }, GET_ME_QUERY_KEY))).toBe(
      true
    );
    expect(shouldPersistReadCacheQuery(queryLike({ status: 'pending' }, GET_ME_QUERY_KEY))).toBe(
      false
    );
    expect(shouldPersistReadCacheQuery(queryLike({ status: 'error' }, GET_ME_QUERY_KEY))).toBe(
      false
    );
    expect(
      shouldPersistReadCacheQuery(queryLike({ status: 'success' }, FLAT_APPLICATION_KEY))
    ).toBe(false);
  });

  it('persists only the first page of an allowlisted infinite query', () => {
    const infiniteListKey: readonly unknown[] = [
      ['cliSessionsV2', 'list'],
      {
        input: {
          limit: 30,
          orderBy: 'updated_at',
          includeChildren: false,
          createdOnPlatform: undefined,
          gitUrl: undefined,
          organizationId: null,
        },
        type: 'infinite',
      },
    ];
    // First page only: the one-page snapshot may persist.
    expect(
      shouldPersistReadCacheQuery(
        queryLike(
          { status: 'success', data: { pages: [{ cliSessions: [] }], pageParams: [undefined] } },
          infiniteListKey
        )
      )
    ).toBe(true);
    // A later loaded page shares the same key (the tRPC adapter strips the
    // cursor from infinite-query keys), so the loaded page count must deny
    // the multi-page snapshot.
    expect(
      shouldPersistReadCacheQuery(
        queryLike(
          {
            status: 'success',
            data: {
              pages: [{ cliSessions: [] }, { cliSessions: [] }],
              pageParams: [undefined, 'cursor-1'],
            },
          },
          infiniteListKey
        )
      )
    ).toBe(false);
  });
});

describe('readCachedUserId', () => {
  it('reads the authoritative user id from the cached getMe result', () => {
    expect(readCachedUserId(makeAuthoritativeQueryClient('u1'))).toBe('u1');
  });

  it('returns null when getMe is absent or carries no non-empty string id', () => {
    expect(readCachedUserId(new QueryClient())).toBeNull();
    const noId = new QueryClient();
    noId.setQueryData(GET_ME_QUERY_KEY, { email: 'a@b.c' });
    expect(readCachedUserId(noId)).toBeNull();
    const emptyId = new QueryClient();
    emptyId.setQueryData(GET_ME_QUERY_KEY, { id: '' });
    expect(readCachedUserId(emptyId)).toBeNull();
  });
});

describe('publication budget', () => {
  it('writes a blob within the 2 MB budget to the scoped key', async () => {
    const { kv, scopes } = createFakeKv();
    const queryClient = makeAuthoritativeQueryClient('u1');
    const persister = createReadCachePersister({
      queryClient,
      userId: 'u1',
      epoch: currentAuthEpoch(),
    });

    await persister.persistClient(makePersistedClient({ id: 'u1' }));

    expect(kv.setItem).toHaveBeenCalledTimes(1);
    const [scope, key, value] = vi.mocked(kv.setItem).mock.calls[0] ?? [];
    expect(scope).toBe('cache:u1:1');
    expect(key).toBe('read-cache');
    expect(JSON.parse(value ?? '{}') as PersistedClient).toMatchObject({
      clientState: { queries: [{ queryKey: GET_ME_QUERY_KEY }] },
    });
    expect(scopes.get('cache:u1:1')?.get('read-cache')).toBe(value);
  });

  it('drops a blob over 2 MB and removes the previous blob for the scope', async () => {
    const { kv, scopes } = createFakeKv();
    const queryClient = makeAuthoritativeQueryClient('u1');
    scopes.set('cache:u1:1', new Map([['read-cache', 'stale-blob']]));
    const persister = createReadCachePersister({
      queryClient,
      userId: 'u1',
      epoch: currentAuthEpoch(),
    });

    const oversized = makePersistedClient({ payload: 'x'.repeat(READ_CACHE_MAX_BYTES) });
    await persister.persistClient(oversized);

    // Never written partially: the previous blob for the scope is removed.
    expect(kv.removeItem).toHaveBeenCalledWith('cache:u1:1', 'read-cache');
    expect(kv.setItem).not.toHaveBeenCalled();
    expect(scopes.get('cache:u1:1')?.has('read-cache')).toBe(false);
  });

  it('restores from the scope even when the publication fence would block a write', async () => {
    const { scopes } = createFakeKv();
    const queryClient = new QueryClient();
    scopes.set(
      'cache:u1:1',
      new Map([['read-cache', JSON.stringify(makePersistedClient({ id: 'u1' }))]])
    );
    const persister = createReadCachePersister({
      queryClient,
      userId: 'u1',
      epoch: currentAuthEpoch(),
    });
    bumpAuthEpoch();

    const restored = await persister.restoreClient();
    expect(restored?.clientState.queries[0]?.state.data).toEqual({ id: 'u1' });
  });
});

describe('publication fence', () => {
  it('skips publication when the auth epoch moved after persister creation', async () => {
    const { kv } = createFakeKv();
    const queryClient = makeAuthoritativeQueryClient('u1');
    const epoch = currentAuthEpoch();
    const persister = createReadCachePersister({ queryClient, userId: 'u1', epoch });

    bumpAuthEpoch();
    await persister.persistClient(makePersistedClient({ id: 'u1' }));

    expect(kv.setItem).not.toHaveBeenCalled();
  });

  it('skips publication when the cached authoritative user differs from the persister user', async () => {
    const { kv } = createFakeKv();
    const queryClient = makeAuthoritativeQueryClient('u2');
    const persister = createReadCachePersister({
      queryClient,
      userId: 'u1',
      epoch: currentAuthEpoch(),
    });

    await persister.persistClient(makePersistedClient({ id: 'u1' }));

    expect(kv.setItem).not.toHaveBeenCalled();
  });

  it('refuses publication while sign-out is active, even at the current epoch with a matching user', async () => {
    const { kv } = createFakeKv();
    const queryClient = makeAuthoritativeQueryClient('u1');
    const epoch = currentAuthEpoch();
    const persister = createReadCachePersister({ queryClient, userId: 'u1', epoch });

    // Sign-out flips the fence while the epoch and the cached user id still
    // look current — the exact window in which the old mount resubscribed and
    // rewrote the old user's blob before the cleanup finished.
    setSignOutActive(true);
    await persister.persistClient(makePersistedClient({ id: 'u1' }));
    expect(kv.setItem).not.toHaveBeenCalled();

    // A sign-in that published its credentials clears the fence.
    setSignOutActive(false);
    await persister.persistClient(makePersistedClient({ id: 'u1' }));
    expect(kv.setItem).toHaveBeenCalledTimes(1);
  });
});

describe('cold-start restore and takeover', () => {
  it('restores the hint user scope and reports it to the authenticated mount', async () => {
    const { scopes } = createFakeKv();
    store.set(ACTIVE_USER_ID_KEY, 'u1');
    scopes.set(
      'cache:u1:1',
      new Map([['read-cache', JSON.stringify(makePersistedClient({ id: 'u1' }))]])
    );
    const queryClient = new QueryClient();

    await restorePersistedCacheOnColdStart(queryClient);

    // The allowlisted getMe query was hydrated from the hint account's scope.
    expect(queryClient.getQueryData(GET_ME_QUERY_KEY)).toEqual({ id: 'u1' });
    expect(takeOverColdStartRestore()).toBe('cache:u1:1');
    // A completed restore is reported exactly once.
    expect(takeOverColdStartRestore()).toBeNull();
  });

  it('drops an expired blob instead of hydrating it', async () => {
    const { kv, scopes } = createFakeKv();
    store.set(ACTIVE_USER_ID_KEY, 'u1');
    const expired = makePersistedClient({ id: 'u1' });
    expired.timestamp = Date.now() - READ_CACHE_MAX_AGE_MS - 1;
    scopes.set('cache:u1:1', new Map([['read-cache', JSON.stringify(expired)]]));
    const queryClient = new QueryClient();

    await restorePersistedCacheOnColdStart(queryClient);

    expect(queryClient.getQueryData(GET_ME_QUERY_KEY)).toBeUndefined();
    expect(kv.removeItem).toHaveBeenCalledWith('cache:u1:1', 'read-cache');
    expect(takeOverColdStartRestore()).toBe('cache:u1:1');
  });

  it('never restores a blob written by an older schema: it lives in another scope', async () => {
    const { kv, scopes } = createFakeKv();
    store.set(ACTIVE_USER_ID_KEY, 'u1');
    // The previous schema version wrote into `cache:u1:0`; the current scope is
    // `cache:u1:1`, so the old blob is never read and never hydrated.
    const oldSchemaBlob = JSON.stringify(makePersistedClient({ id: 'u1' }));
    scopes.set('cache:u1:0', new Map([['read-cache', oldSchemaBlob]]));
    const queryClient = new QueryClient();

    await restorePersistedCacheOnColdStart(queryClient);

    expect(queryClient.getQueryData(GET_ME_QUERY_KEY)).toBeUndefined();
    expect(kv.getItem).toHaveBeenCalledWith('cache:u1:1', 'read-cache');
    expect(kv.getItem).not.toHaveBeenCalledWith('cache:u1:0', 'read-cache');
  });

  it('is best effort: a corrupt blob never blocks startup and is discarded', async () => {
    const { kv, scopes } = createFakeKv();
    store.set(ACTIVE_USER_ID_KEY, 'u1');
    scopes.set('cache:u1:1', new Map([['read-cache', 'not-json']]));
    const queryClient = new QueryClient();

    await expect(restorePersistedCacheOnColdStart(queryClient)).resolves.toBeUndefined();

    expect(kv.removeItem).toHaveBeenCalledWith('cache:u1:1', 'read-cache');
    expect(takeOverColdStartRestore()).toBeNull();
  });

  it('abandons a still-pending restore once the authenticated mount takes over', async () => {
    createFakeKv();
    const hintRead: { resolve: ((value: string | null) => void) | null } = { resolve: null };
    vi.mocked(SecureStore.getItemAsync).mockImplementationOnce(
      async () =>
        new Promise<string | null>(resolve => {
          hintRead.resolve = resolve;
        })
    );
    const queryClient = new QueryClient();

    const restorePromise = restorePersistedCacheOnColdStart(queryClient);
    // The mount takes over while the hint read is still in flight.
    expect(takeOverColdStartRestore()).toBeNull();
    hintRead.resolve?.('u1');
    await restorePromise;

    // The late restore never claimed a scope.
    expect(takeOverColdStartRestore()).toBeNull();
  });

  it('never hydrates when the mount takes over while the restore read is in flight', async () => {
    const { kv, scopes } = createFakeKv();
    store.set(ACTIVE_USER_ID_KEY, 'u1');
    scopes.set(
      'cache:u1:1',
      new Map([['read-cache', JSON.stringify(makePersistedClient({ id: 'u1' }))]])
    );
    const restoreRead: { resolve: ((value: string | null) => void) | null } = { resolve: null };
    kv.getItem.mockImplementationOnce(
      async () =>
        new Promise<string | null>(resolve => {
          restoreRead.resolve = resolve;
        })
    );
    const queryClient = new QueryClient();

    const restorePromise = restorePersistedCacheOnColdStart(queryClient);
    await vi.waitFor(() => {
      expect(kv.getItem).toHaveBeenCalled();
    });
    // The mount takes over while the KV read is still in flight: the restore
    // must not hydrate after the authoritative identity has taken over.
    expect(takeOverColdStartRestore()).toBeNull();
    restoreRead.resolve?.(JSON.stringify(makePersistedClient({ id: 'u1' })));
    await restorePromise;

    expect(queryClient.getQueryData(GET_ME_QUERY_KEY)).toBeUndefined();
    expect(takeOverColdStartRestore()).toBeNull();
  });

  it('never hydrates when the auth epoch changes while the restore read is in flight', async () => {
    const { kv, scopes } = createFakeKv();
    store.set(ACTIVE_USER_ID_KEY, 'u1');
    scopes.set(
      'cache:u1:1',
      new Map([['read-cache', JSON.stringify(makePersistedClient({ id: 'u1' }))]])
    );
    const restoreRead: { resolve: ((value: string | null) => void) | null } = { resolve: null };
    kv.getItem.mockImplementationOnce(
      async () =>
        new Promise<string | null>(resolve => {
          restoreRead.resolve = resolve;
        })
    );
    const queryClient = new QueryClient();

    const restorePromise = restorePersistedCacheOnColdStart(queryClient);
    await vi.waitFor(() => {
      expect(kv.getItem).toHaveBeenCalled();
    });
    // A sign-out (or sign-in) bumps the epoch while the KV read is in flight,
    // before the authenticated mount takes over: the restore must not hydrate
    // the hint account into the query client.
    bumpAuthEpoch();
    restoreRead.resolve?.(JSON.stringify(makePersistedClient({ id: 'u1' })));
    await restorePromise;

    expect(queryClient.getQueryData(GET_ME_QUERY_KEY)).toBeUndefined();
    expect(takeOverColdStartRestore()).toBeNull();
  });

  it('never restores when the auth epoch changes while the hint read is in flight', async () => {
    const { kv } = createFakeKv();
    const hintRead: { resolve: ((value: string | null) => void) | null } = { resolve: null };
    vi.mocked(SecureStore.getItemAsync).mockImplementationOnce(
      async () =>
        new Promise<string | null>(resolve => {
          hintRead.resolve = resolve;
        })
    );
    const queryClient = new QueryClient();

    const restorePromise = restorePersistedCacheOnColdStart(queryClient);
    // The epoch moved before the hint read settled: the restore is abandoned
    // before it can even read the cache.
    bumpAuthEpoch();
    hintRead.resolve?.('u1');
    await restorePromise;

    expect(kv.getItem).not.toHaveBeenCalled();
    expect(takeOverColdStartRestore()).toBeNull();
  });

  it('does nothing when the identity hint is absent', async () => {
    const { kv } = createFakeKv();
    const queryClient = new QueryClient();

    await restorePersistedCacheOnColdStart(queryClient);

    expect(kv.getItem).not.toHaveBeenCalled();
    expect(takeOverColdStartRestore()).toBeNull();
  });
});

// The restored-scope mismatch now lives inline in the mount; the match,
// mismatch, and no-restore cases are asserted in cache-persistence-mount.test.

describe('sign-out cleanup', () => {
  it('clears every schema version of the known user cache scope on sign-out', async () => {
    const { kv } = createFakeKv();

    await clearCacheScopeForSignOut('u1');

    // The user prefix, not the current version's scope: a schema bump must not
    // leave the previous version's blob on the device after sign-out.
    expect(kv.clearScopePrefix).toHaveBeenCalledWith('cache:u1:');
    expect(kv.clearScope).not.toHaveBeenCalled();
  });

  it('keeps the other account cache and every draft when one user signs out', async () => {
    const { scopes } = createFakeKv();
    scopes.set('cache:u1:0', new Map([['read-cache', 'u1-previous-schema']]));
    scopes.set('cache:u1:1', new Map([['read-cache', 'u1-current-schema']]));
    scopes.set('cache:u12:1', new Map([['read-cache', 'other-user']]));
    scopes.set('draft:u1', new Map([['agent-composer:new', '"unsent text"']]));

    await clearCacheScopeForSignOut('u1');

    expect(scopes.has('cache:u1:0')).toBe(false);
    expect(scopes.has('cache:u1:1')).toBe(false);
    expect(scopes.get('cache:u12:1')?.get('read-cache')).toBe('other-user');
    expect(scopes.get('draft:u1')?.get('agent-composer:new')).toBe('"unsent text"');
  });

  it('clears every cache scope when the user id is unknown (privacy wins)', async () => {
    const { kv } = createFakeKv();

    await clearCacheScopeForSignOut(null);

    expect(kv.clearScopePrefix).toHaveBeenCalledWith('cache:');
    expect(kv.clearScope).not.toHaveBeenCalled();
  });

  it('is best effort: a failing scope clear never rejects sign-out cleanup', async () => {
    const { kv } = createFakeKv();
    kv.clearScopePrefix.mockRejectedValueOnce(new Error('kv down'));

    await expect(clearCacheScopeForSignOut('u1')).resolves.toBeUndefined();
    expect(kv.clearScopePrefix).toHaveBeenCalledWith('cache:u1:');
  });

  it('is best effort when clearing every scope fails', async () => {
    const { kv } = createFakeKv();
    kv.clearScopePrefix.mockRejectedValueOnce(new Error('kv down'));

    await expect(clearCacheScopeForSignOut(null)).resolves.toBeUndefined();
    expect(kv.clearScopePrefix).toHaveBeenCalledWith('cache:');
  });
});
