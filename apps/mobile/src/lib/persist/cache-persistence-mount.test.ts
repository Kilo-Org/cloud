/* eslint-disable max-lines -- cohesive mount suite for identity resolution, mismatch recovery, and persister lifecycle */
/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (node env, no jsdom); its React 19 deprecation notice points to the DOM-based Testing Library, which cannot render this app's non-DOM tree. See src/app/(app)/(tabs)/(2_agents)/index.mounted.test.tsx. */
/* eslint-disable require-await, @typescript-eslint/require-await -- the fake KV and SecureStore factories settle without await because they resolve immediately */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { type Mutation } from '@tanstack/react-query';
import { type PersistedQueryClientSaveOptions } from '@tanstack/react-query-persist-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bumpAuthEpoch, currentAuthEpoch } from '@/lib/auth/auth-epoch';
import { CachePersistenceMount } from './cache-persistence-mount';
import { queryClient } from '@/lib/query-client';
import {
  clearCacheScopeForSignOut,
  createReadCachePersister,
  resetReadCacheForTests,
  restorePersistedCacheOnColdStart,
  setSignOutActive,
  shouldPersistReadCacheQuery,
  takeOverColdStartRestore,
} from './read-cache';
import { GET_ME_QUERY_KEY, makePersistedClient } from './test-fixtures';
import { ACTIVE_USER_ID_KEY } from '@/lib/storage-keys';

type Identity = {
  userId: string | undefined;
  isLoading: boolean;
  isError: boolean;
};

const identityMock = vi.hoisted<{ value: Identity }>(() => ({
  value: { userId: undefined, isLoading: true, isError: false },
}));

const authMock = vi.hoisted<{ value: { authEpoch: number; isSigningOut: boolean } }>(() => ({
  value: { authEpoch: 0, isSigningOut: false },
}));

const persistQueryClientSubscribeMock = vi.hoisted(() =>
  vi.fn<(options: PersistedQueryClientSaveOptions) => () => void>()
);
const persistQueryClientRestoreMock = vi.hoisted(() => vi.fn(async () => undefined));
const unsubscribeMock = vi.hoisted(() => vi.fn<() => void>());

const kvMock = vi.hoisted(() => ({
  getItem: vi.fn(async (): Promise<string | null> => null),
  setItem: vi.fn(async (): Promise<void> => undefined),
  removeItem: vi.fn(async (): Promise<void> => undefined),
  clearScope: vi.fn(async (): Promise<void> => undefined),
  clearScopePrefix: vi.fn(async (): Promise<void> => undefined),
}));

const secureStoreMock = vi.hoisted(() => ({
  getItemAsync: vi.fn(async (): Promise<string | null> => null),
  setItemAsync: vi.fn(async (): Promise<void> => undefined),
  deleteItemAsync: vi.fn(async (): Promise<void> => undefined),
}));

vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: vi.fn(() => identityMock.value),
}));

vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: vi.fn(() => authMock.value),
}));

vi.mock('@/lib/persist/encrypted-kv', () => ({
  getItem: kvMock.getItem,
  setItem: kvMock.setItem,
  removeItem: kvMock.removeItem,
  clearScope: kvMock.clearScope,
  clearScopePrefix: kvMock.clearScopePrefix,
}));

vi.mock('@tanstack/react-query-persist-client', () => ({
  persistQueryClientSubscribe: persistQueryClientSubscribeMock,
  persistQueryClientRestore: persistQueryClientRestoreMock,
}));

vi.mock('expo-secure-store', () => secureStoreMock);

beforeEach(() => {
  vi.clearAllMocks();
  resetReadCacheForTests();
  identityMock.value = { userId: undefined, isLoading: true, isError: false };
  authMock.value = { authEpoch: 0, isSigningOut: false };
  kvMock.getItem.mockResolvedValue(null);
  kvMock.setItem.mockResolvedValue(undefined);
  kvMock.removeItem.mockResolvedValue(undefined);
  kvMock.clearScope.mockResolvedValue(undefined);
  kvMock.clearScopePrefix.mockResolvedValue(undefined);
  secureStoreMock.getItemAsync.mockResolvedValue(null);
  secureStoreMock.setItemAsync.mockResolvedValue(undefined);
  secureStoreMock.deleteItemAsync.mockResolvedValue(undefined);
  persistQueryClientSubscribeMock.mockReturnValue(unsubscribeMock);
  persistQueryClientRestoreMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mount(): TestRenderer.ReactTestRenderer {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  act(() => {
    rendererRef.current = TestRenderer.create(createElement(CachePersistenceMount));
  });
  if (!rendererRef.current) {
    throw new Error('CachePersistenceMount did not render');
  }
  return rendererRef.current;
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });
  });
}

function latestPersistOptions(): PersistedQueryClientSaveOptions | undefined {
  return persistQueryClientSubscribeMock.mock.calls.at(-1)?.[0];
}

function mutationLike(state: Partial<Mutation['state']>): Mutation {
  return { state } as unknown as Mutation;
}

describe('CachePersistenceMount', () => {
  it('resolves identity, writes the hint, and subscribes one scoped persister', async () => {
    identityMock.value = { userId: 'u1', isLoading: false, isError: false };
    const renderer = mount();
    await flushMicrotasks();

    // The identity hint for the next cold start was written via the fenced helper.
    expect(secureStoreMock.setItemAsync).toHaveBeenCalledWith(ACTIVE_USER_ID_KEY, 'u1');

    // One mounted subscription with the allowlist-only dehydrate filters. The
    // root layout already performed the only cold-start restore, so the mount
    // subscribes without restoring — no `maxAge` and no restore promise. The
    // schema version lives in the scope, so no `buster` is passed.
    expect(persistQueryClientSubscribeMock).toHaveBeenCalledTimes(1);
    expect(latestPersistOptions()).toMatchObject({
      queryClient,
      dehydrateOptions: {
        shouldDehydrateQuery: shouldPersistReadCacheQuery,
        shouldDehydrateMutation: expect.any(Function),
      },
    });
    expect(latestPersistOptions()?.buster).toBeUndefined();

    // The persister is bound to exactly the user's scope for the schema.
    await latestPersistOptions()?.persister.restoreClient();
    expect(kvMock.getItem).toHaveBeenCalledWith('cache:u1:1', 'read-cache');

    // No cold-start restore claimed a scope, so nothing is cleared.
    expect(kvMock.clearScope).not.toHaveBeenCalled();

    act(() => {
      renderer.unmount();
    });
  });

  it('regression: a failed identity-hint write never escapes as an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      identityMock.value = { userId: 'u1', isLoading: false, isError: false };
      secureStoreMock.setItemAsync.mockRejectedValueOnce(new Error('keychain unavailable'));
      const renderer = mount();
      await flushMicrotasks();

      // The hint write was still attempted even though SecureStore rejects.
      expect(secureStoreMock.setItemAsync).toHaveBeenCalledWith(ACTIVE_USER_ID_KEY, 'u1');
      // Give the runtime a turn to flag an unhandled rejection if the mount
      // ever fires the write without containing it.
      await new Promise(resolve => {
        setImmediate(resolve);
      });
      expect(unhandled).toEqual([]);

      act(() => {
        renderer.unmount();
      });
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('does nothing while identity is loading', () => {
    identityMock.value = { userId: undefined, isLoading: true, isError: false };
    const renderer = mount();

    expect(persistQueryClientSubscribeMock).not.toHaveBeenCalled();
    expect(secureStoreMock.setItemAsync).not.toHaveBeenCalled();
    act(() => {
      renderer.unmount();
    });
  });

  it('does nothing when identity resolution errored', () => {
    identityMock.value = { userId: undefined, isLoading: false, isError: true };
    const renderer = mount();

    expect(persistQueryClientSubscribeMock).not.toHaveBeenCalled();
    expect(secureStoreMock.setItemAsync).not.toHaveBeenCalled();
    act(() => {
      renderer.unmount();
    });
  });

  it('does nothing before a userId resolves', () => {
    identityMock.value = { userId: undefined, isLoading: false, isError: false };
    const renderer = mount();

    expect(persistQueryClientSubscribeMock).not.toHaveBeenCalled();
    act(() => {
      renderer.unmount();
    });
  });

  it('keeps a restored scope that matches the authoritative user', async () => {
    secureStoreMock.getItemAsync.mockResolvedValue('u1');
    await restorePersistedCacheOnColdStart(queryClient);

    const clearSpy = vi.spyOn(queryClient, 'clear');
    identityMock.value = { userId: 'u1', isLoading: false, isError: false };
    const renderer = mount();
    await flushMicrotasks();

    // The mount consumed the cold-start takeover and did not clear anything.
    expect(takeOverColdStartRestore()).toBeNull();
    expect(clearSpy).not.toHaveBeenCalled();
    expect(kvMock.clearScope).not.toHaveBeenCalled();
    expect(persistQueryClientSubscribeMock).toHaveBeenCalledTimes(1);

    clearSpy.mockRestore();
    act(() => {
      renderer.unmount();
    });
  });

  it('clears a mismatched restored scope and the query client before rescoping', async () => {
    secureStoreMock.getItemAsync.mockResolvedValue('user-a');
    await restorePersistedCacheOnColdStart(queryClient);

    const clearSpy = vi.spyOn(queryClient, 'clear');
    identityMock.value = { userId: 'user-b', isLoading: false, isError: false };
    const renderer = mount();
    await flushMicrotasks();

    // Authoritative identity wins: the other account's restored data and the
    // query client are cleared before the new scope subscribes.
    expect(takeOverColdStartRestore()).toBeNull();
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(kvMock.clearScope).toHaveBeenCalledWith('cache:user-a:1');
    await latestPersistOptions()?.persister.restoreClient();
    expect(kvMock.getItem).toHaveBeenCalledWith('cache:user-b:1', 'read-cache');

    clearSpy.mockRestore();
    act(() => {
      renderer.unmount();
    });
  });

  it('unsubscribes the previous persister when the user changes', async () => {
    identityMock.value = { userId: 'u1', isLoading: false, isError: false };
    const renderer = mount();
    await flushMicrotasks();
    expect(persistQueryClientSubscribeMock).toHaveBeenCalledTimes(1);

    identityMock.value = { userId: 'u2', isLoading: false, isError: false };
    act(() => {
      renderer.update(createElement(CachePersistenceMount));
    });
    await flushMicrotasks();

    expect(persistQueryClientSubscribeMock).toHaveBeenCalledTimes(2);
    expect(unsubscribeMock).toHaveBeenCalled();
    act(() => {
      renderer.unmount();
    });
  });

  it('unsubscribes the persister on unmount', async () => {
    identityMock.value = { userId: 'u1', isLoading: false, isError: false };
    const renderer = mount();
    await flushMicrotasks();

    act(() => {
      renderer.unmount();
    });

    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
  });

  it('denies every mutation from the persisted client, including paused ones', async () => {
    identityMock.value = { userId: 'u1', isLoading: false, isError: false };
    const renderer = mount();
    await flushMicrotasks();

    const shouldDehydrateMutation =
      latestPersistOptions()?.dehydrateOptions?.shouldDehydrateMutation;
    expect(shouldDehydrateMutation).toBeTypeOf('function');
    // The library default dehydrates paused mutations; the mount denies them
    // so a restored read cache can never replay one (never-replay).
    expect(shouldDehydrateMutation?.(mutationLike({ isPaused: true }))).toBe(false);
    expect(shouldDehydrateMutation?.(mutationLike({ isPaused: false }))).toBe(false);
    act(() => {
      renderer.unmount();
    });
  });

  it('unsubscribes and resubscribes when the auth epoch changes and the user stays equal', async () => {
    identityMock.value = { userId: 'u1', isLoading: false, isError: false };
    authMock.value = { authEpoch: 1, isSigningOut: false };
    const renderer = mount();
    await flushMicrotasks();
    expect(persistQueryClientSubscribeMock).toHaveBeenCalledTimes(1);

    // The epoch bumps (sign-out or newer sign-in) while the authoritative user
    // id stays equal: the mount must tear down the old persister and
    // resubscribe so the new subscription is fenced on the current epoch.
    authMock.value = { authEpoch: 2, isSigningOut: false };
    act(() => {
      renderer.update(createElement(CachePersistenceMount));
    });
    await flushMicrotasks();

    expect(persistQueryClientSubscribeMock).toHaveBeenCalledTimes(2);
    expect(unsubscribeMock).toHaveBeenCalled();
    act(() => {
      renderer.unmount();
    });
  });

  it('regression: sign-out unsubscribes the mount and a query update during delayed cleanup never rewrites the old user blob', async () => {
    // The old user id stays cached for the whole sign-out teardown (the query
    // client is only cleared at the end of sign-out).
    queryClient.setQueryData(GET_ME_QUERY_KEY, { id: 'u1' });
    identityMock.value = { userId: 'u1', isLoading: false, isError: false };
    authMock.value = { authEpoch: 0, isSigningOut: false };
    const renderer = mount();
    await flushMicrotasks();
    expect(persistQueryClientSubscribeMock).toHaveBeenCalledTimes(1);
    const stalePersister = latestPersistOptions()?.persister;
    expect(stalePersister).toBeDefined();

    // Delay the sign-out scope clear so a query update can land mid-teardown.
    const cleanupGate: { release: (() => void) | null } = { release: null };
    const cleanupHeld = new Promise<void>(resolve => {
      cleanupGate.release = resolve;
    });
    kvMock.clearScopePrefix.mockImplementationOnce(async () => {
      await cleanupHeld;
    });

    // Sign-out starts: the module epoch bumps and the reactive sign-out state
    // flips in the same render while the old user id is still cached.
    bumpAuthEpoch();
    setSignOutActive(true);
    authMock.value = { authEpoch: 1, isSigningOut: true };
    act(() => {
      renderer.update(createElement(CachePersistenceMount));
    });
    await flushMicrotasks();

    // The mount tore down the old subscription and refused to resubscribe.
    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
    expect(persistQueryClientSubscribeMock).toHaveBeenCalledTimes(1);

    // The sign-out cleanup starts and is held open.
    const cleanupPromise = clearCacheScopeForSignOut('u1');
    await vi.waitFor(() => {
      expect(kvMock.clearScopePrefix).toHaveBeenCalled();
    });

    // A query update fires a throttled save from the torn-down subscription
    // while cleanup is still in flight: no cache blob may be written.
    await stalePersister?.persistClient(makePersistedClient({ id: 'u1' }));
    expect(kvMock.setItem).not.toHaveBeenCalled();

    cleanupGate.release?.();
    await cleanupPromise;

    // Even a persister created at the CURRENT epoch with a matching cached
    // user id (the resubscription the race used to create) refuses to publish
    // while sign-out is active, so cleanup is final: a save after the clear
    // also writes nothing.
    const freshPersister = createReadCachePersister({
      queryClient,
      userId: 'u1',
      epoch: currentAuthEpoch(),
    });
    await freshPersister.persistClient(makePersistedClient({ id: 'u1' }));
    expect(kvMock.setItem).not.toHaveBeenCalled();

    act(() => {
      renderer.unmount();
    });
    queryClient.removeQueries({ queryKey: GET_ME_QUERY_KEY });
  });
});
