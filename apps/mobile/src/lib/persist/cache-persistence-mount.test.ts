/* eslint-disable max-lines -- cohesive mount suite for identity resolution, mismatch recovery, and persister lifecycle */
/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (node env, no jsdom); its React 19 deprecation notice points to the DOM-based Testing Library, which cannot render this app's non-DOM tree. See src/app/(app)/(tabs)/(2_agents)/index.mounted.test.tsx. */
/* eslint-disable require-await, @typescript-eslint/require-await -- the fake KV and SecureStore factories settle without await because they resolve immediately */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { type Mutation } from '@tanstack/react-query';
import { type PersistedQueryClientSaveOptions } from '@tanstack/react-query-persist-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CachePersistenceMount } from './cache-persistence-mount';
import { queryClient } from '@/lib/query-client';
import {
  bindReadCacheKv,
  resetReadCacheForTests,
  restorePersistedCacheOnColdStart,
  SCHEMA_VERSION,
  shouldPersistReadCacheQuery,
  takeOverColdStartRestore,
} from './read-cache';
import { ACTIVE_USER_ID_KEY } from '@/lib/storage-keys';

type Identity = {
  userId: string | undefined;
  isLoading: boolean;
  isError: boolean;
};

const identityMock = vi.hoisted<{ value: Identity }>(() => ({
  value: { userId: undefined, isLoading: true, isError: false },
}));

const authMock = vi.hoisted<{ value: { authEpoch: number } }>(() => ({
  value: { authEpoch: 0 },
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
  authMock.value = { authEpoch: 0 };
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
    bindReadCacheKv(kvMock);
    identityMock.value = { userId: 'u1', isLoading: false, isError: false };
    const renderer = mount();
    await flushMicrotasks();

    // The identity hint for the next cold start was written via the fenced helper.
    expect(secureStoreMock.setItemAsync).toHaveBeenCalledWith(ACTIVE_USER_ID_KEY, 'u1');

    // One mounted subscription with the schema buster and the allowlist-only
    // dehydrate filters. The root layout already performed the only cold-start
    // restore, so the mount subscribes without restoring — no `maxAge` and no
    // restore promise.
    expect(persistQueryClientSubscribeMock).toHaveBeenCalledTimes(1);
    expect(latestPersistOptions()).toMatchObject({
      queryClient,
      buster: String(SCHEMA_VERSION),
      dehydrateOptions: {
        shouldDehydrateQuery: shouldPersistReadCacheQuery,
        shouldDehydrateMutation: expect.any(Function),
      },
    });

    // The persister is bound to exactly the user's scope for the schema.
    await latestPersistOptions()?.persister.restoreClient();
    expect(kvMock.getItem).toHaveBeenCalledWith('cache:u1:1', 'read-cache');

    act(() => {
      renderer.unmount();
    });
  });

  it('does nothing while identity is loading', () => {
    bindReadCacheKv(kvMock);
    identityMock.value = { userId: undefined, isLoading: true, isError: false };
    const renderer = mount();

    expect(persistQueryClientSubscribeMock).not.toHaveBeenCalled();
    expect(secureStoreMock.setItemAsync).not.toHaveBeenCalled();
    act(() => {
      renderer.unmount();
    });
  });

  it('does nothing when identity resolution errored', () => {
    bindReadCacheKv(kvMock);
    identityMock.value = { userId: undefined, isLoading: false, isError: true };
    const renderer = mount();

    expect(persistQueryClientSubscribeMock).not.toHaveBeenCalled();
    expect(secureStoreMock.setItemAsync).not.toHaveBeenCalled();
    act(() => {
      renderer.unmount();
    });
  });

  it('does nothing before a userId resolves', () => {
    bindReadCacheKv(kvMock);
    identityMock.value = { userId: undefined, isLoading: false, isError: false };
    const renderer = mount();

    expect(persistQueryClientSubscribeMock).not.toHaveBeenCalled();
    act(() => {
      renderer.unmount();
    });
  });

  it('does nothing when the KV adapter is not bound yet', () => {
    identityMock.value = { userId: 'u1', isLoading: false, isError: false };
    const renderer = mount();

    expect(persistQueryClientSubscribeMock).not.toHaveBeenCalled();
    act(() => {
      renderer.unmount();
    });
  });

  it('keeps a restored scope that matches the authoritative user', async () => {
    bindReadCacheKv(kvMock);
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
    bindReadCacheKv(kvMock);
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
    bindReadCacheKv(kvMock);
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
    bindReadCacheKv(kvMock);
    identityMock.value = { userId: 'u1', isLoading: false, isError: false };
    const renderer = mount();
    await flushMicrotasks();

    act(() => {
      renderer.unmount();
    });

    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
  });

  it('denies every mutation from the persisted client, including paused ones', async () => {
    bindReadCacheKv(kvMock);
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
    bindReadCacheKv(kvMock);
    identityMock.value = { userId: 'u1', isLoading: false, isError: false };
    authMock.value = { authEpoch: 1 };
    const renderer = mount();
    await flushMicrotasks();
    expect(persistQueryClientSubscribeMock).toHaveBeenCalledTimes(1);

    // The epoch bumps (sign-out or newer sign-in) while the authoritative user
    // id stays equal: the mount must tear down the old persister and
    // resubscribe so the new subscription is fenced on the current epoch.
    authMock.value = { authEpoch: 2 };
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
});
