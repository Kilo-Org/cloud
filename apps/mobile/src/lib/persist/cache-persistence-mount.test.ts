/* eslint-disable typescript-eslint/no-deprecated -- mounted cache tests use the installed DOM-free renderer */
/* eslint-disable require-await, typescript-eslint/require-await -- native fixtures and async act callbacks settle synchronously */
/* eslint-disable max-params -- the KV fixture mirrors the four-argument guarded write API */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { hashKey } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bumpAuthEpoch, currentAuthEpoch } from '@/lib/auth/auth-epoch';
import { isSignOutActive, setSignOutActive } from '@/lib/auth/sign-out-state';
import {
  beginAuthenticatedOwner,
  confirmAuthenticatedOwner,
  getAuthenticatedOwner,
} from '@/lib/context-scope';
import { queryClient } from '@/lib/query-client';
import { ACTIVE_USER_ID_KEY } from '@/lib/storage-keys';
import { CachePersistenceMount } from './cache-persistence-mount';
import { resetReadCacheForTests, restorePersistedCacheOnColdStart } from './read-cache';
import { GET_ME_QUERY_KEY, makePersistedClient } from './test-fixtures';

const mocks = vi.hoisted(() => ({
  userId: undefined as string | undefined,
  store: new Map<string, string>(),
  hint: new Map<string, string>(),
  get: vi.fn(),
  set: vi.fn(),
  setHint: vi.fn(),
}));
vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({
    userId: mocks.userId,
    owner: getAuthenticatedOwner(),
    isLoading: false,
    isError: false,
  }),
}));
vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: () => ({ authEpoch: currentAuthEpoch(), isSigningOut: isSignOutActive() }),
}));
vi.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string) => mocks.hint.get(key) ?? null,
  setItemAsync: mocks.setHint,
}));
vi.mock('@/lib/persist/encrypted-kv', () => ({
  getItem: mocks.get,
  setItem: mocks.set,
  removeItem: async (scope: string, _key: string, guard?: () => boolean) => {
    if (!guard || guard()) {
      mocks.store.delete(scope);
    }
  },
  clearScopePrefix: async (prefix: string, guard?: () => boolean) => {
    if (guard && !guard()) {
      return;
    }
    for (const scope of mocks.store.keys()) {
      if (scope.startsWith(prefix)) {
        mocks.store.delete(scope);
      }
    }
  },
}));

const RECENT_KEY = [['cliSessionsV2', 'recentRepositories'], { type: 'query' }];
let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
function prove(userId: string) {
  bumpAuthEpoch();
  beginAuthenticatedOwner();
  mocks.userId = userId;
  queryClient.clear();
  queryClient.setQueryData(GET_ME_QUERY_KEY, { id: userId });
  confirmAuthenticatedOwner(getAuthenticatedOwner(), userId);
}
function seed(userId: string, text: string) {
  const blob = makePersistedClient({ id: userId });
  const fixture = blob.clientState.queries[0];
  if (!fixture) {
    throw new Error('Missing query fixture');
  }
  blob.clientState.queries.push({
    ...fixture,
    queryHash: hashKey(RECENT_KEY),
    queryKey: RECENT_KEY,
    state: { ...fixture.state, data: { text } },
  });
  mocks.store.set(`cache:${userId}:1`, JSON.stringify(blob));
}
async function mount() {
  await act(async () => {
    renderer = TestRenderer.create(createElement(CachePersistenceMount));
  });
}
async function update() {
  await act(async () => {
    renderer?.update(createElement(CachePersistenceMount));
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  resetReadCacheForTests();
  beginAuthenticatedOwner();
  queryClient.clear();
  mocks.userId = undefined;
  mocks.store.clear();
  mocks.hint.clear();
  mocks.get.mockImplementation(async (scope: string) => mocks.store.get(scope) ?? null);
  // eslint-disable-next-line max-params -- mirror the guarded KV write API
  mocks.set.mockImplementation(
    async (scope: string, _key: string, value: string, guard?: () => boolean) => {
      if (!guard || guard()) {
        mocks.store.set(scope, value);
      }
    }
  );
  mocks.setHint.mockImplementation(async (key: string, value: string) => {
    mocks.hint.set(key, value);
  });
});
afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
  });
  queryClient.clear();
});

describe('CachePersistenceMount owner proof', () => {
  it('does not restore or publish content from an active-user-id hint alone', async () => {
    seed('a', 'private a');
    mocks.hint.set(ACTIVE_USER_ID_KEY, 'a');
    await restorePersistedCacheOnColdStart(queryClient);
    await mount();
    expect(queryClient.getQueryData(RECENT_KEY)).toBeUndefined();
    expect(queryClient.getQueryData(GET_ME_QUERY_KEY)).toBeUndefined();
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it('restores matching owner content without replacing authoritative getMe', async () => {
    seed('a', 'private a');
    prove('a');
    await mount();
    expect(queryClient.getQueryData(RECENT_KEY)).toEqual({ text: 'private a' });
    expect(queryClient.getQueryData(GET_ME_QUERY_KEY)).toEqual({ id: 'a' });
    expect(mocks.hint.get(ACTIVE_USER_ID_KEY)).toBe('a');
  });
  it('ignores a mismatched cold hint and restores only the proved account', async () => {
    seed('a', 'private a');
    seed('b', 'private b');
    mocks.hint.set(ACTIVE_USER_ID_KEY, 'a');
    await restorePersistedCacheOnColdStart(queryClient);
    prove('b');
    await mount();
    expect(queryClient.getQueryData(RECENT_KEY)).toEqual({ text: 'private b' });
    expect(queryClient.getQueryData(GET_ME_QUERY_KEY)).toEqual({ id: 'b' });
  });
  it('drops an old account restore when B signs in during its cache read', async () => {
    seed('a', 'private a');
    seed('b', 'private b');
    const a = mocks.store.get('cache:a:1') ?? null;
    const gate = Promise.withResolvers<string | null>();
    mocks.get.mockReturnValueOnce(gate.promise);
    prove('a');
    await mount();
    await act(async () => {
      prove('b');
    });
    await update();
    await act(async () => {
      gate.resolve(a);
    });
    expect(queryClient.getQueryData(RECENT_KEY)).toEqual({ text: 'private b' });
    expect(queryClient.getQueryData(GET_ME_QUERY_KEY)).toEqual({ id: 'b' });
  });
  it('keeps restoration available after a failed hint write', async () => {
    seed('a', 'private a');
    prove('a');
    mocks.setHint.mockRejectedValueOnce(new Error('temporary keychain error'));
    await mount();
    expect(queryClient.getQueryData(RECENT_KEY)).toEqual({ text: 'private a' });
  });
  it('unsubscribes on sign-out and never rewrites the cleared old scope', async () => {
    prove('a');
    await mount();
    setSignOutActive(true);
    await update();
    mocks.store.clear();
    queryClient.setQueryData(RECENT_KEY, { text: 'late a' });
    await act(async () => {
      await new Promise(resolve => {
        setTimeout(resolve, 0);
      });
    });
    expect(mocks.store.size).toBe(0);
  });
  it('does not hydrate after unmount while the cache read is pending', async () => {
    seed('a', 'private a');
    const a = mocks.store.get('cache:a:1') ?? null;
    const gate = Promise.withResolvers<string | null>();
    mocks.get.mockReturnValueOnce(gate.promise);
    prove('a');
    await mount();
    await act(async () => {
      renderer?.unmount();
      gate.resolve(a);
    });
    expect(queryClient.getQueryData(RECENT_KEY)).toBeUndefined();
  });
});
