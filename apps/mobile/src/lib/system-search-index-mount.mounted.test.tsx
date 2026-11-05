/* eslint-disable require-await -- the mocks settle without awaiting because they resolve immediately */
import { type QueryClient } from '@tanstack/react-query';
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SystemSearchIndexMount } from '@/lib/system-search-index-mount';

// The provider is the lock's only source of truth; this suite moves its status
// the way a background return and a successful unlock do.
const unlock = vi.hoisted(() => ({
  status: 'unlocked' as 'locked' | 'unlocked',
  useAppUnlock: () => ({ status: unlock.status }),
}));

vi.mock('@/lib/app-unlock-context', () => ({ useAppUnlock: unlock.useAppUnlock }));

const nativeSearch = vi.hoisted(() => ({
  applySystemSearchUpdate: vi.fn(async () => undefined),
  indexedSystemSearchFingerprints: vi.fn<() => Promise<Record<string, string>>>(async () => ({})),
}));

vi.mock('@/lib/native-system-search', () => ({
  isSystemSearchAvailable: true,
  applySystemSearchUpdate: nativeSearch.applySystemSearchUpdate,
  indexedSystemSearchFingerprints: nativeSearch.indexedSystemSearchFingerprints,
}));

const nativeBridge = vi.hoisted(() => ({
  replaceNativeSessionCatalog: vi.fn<(entries: readonly { id: string }[]) => Promise<boolean>>(),
  clearNativeSessionCatalog: vi.fn<() => Promise<boolean>>(),
}));

vi.mock('@/lib/app-actions/native-bridge', () => nativeBridge);

const telemetry = vi.hoisted(() => ({ captureTelemetry: vi.fn() }));
vi.mock('@/lib/telemetry/error-sink', () => telemetry);

// The recents reader is the collector's one storage read.
vi.mock('expo-secure-store', () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => undefined,
  deleteItemAsync: async () => undefined,
}));

const appState = vi.hoisted(() => ({
  listeners: [] as ((state: string) => void)[],
}));

vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: (_event: string, listener: (state: string) => void) => {
      appState.listeners.push(listener);
      return { remove: () => undefined };
    },
  },
}));

const hoisted = vi.hoisted(() => ({ queryClient: null as unknown }));

// The mount reads the app's one client at call time, so the fake is created
// once for the whole suite and handed back through the module factory.
vi.mock('@/lib/query-client', async () => {
  const { QueryClient } = await import('@tanstack/react-query');
  hoisted.queryClient ??= new QueryClient();
  return { queryClient: hoisted.queryClient };
});

function client(): QueryClient {
  return hoisted.queryClient as QueryClient;
}

const SESSION_LIST_KEY = [
  ['cliSessionsV2', 'list'],
  { type: 'infinite', input: { organizationId: null } },
];

function seedSession(title: string): void {
  client().setQueryData(SESSION_LIST_KEY, {
    pages: [
      {
        cliSessions: [{ session_id: 'sess-1', title, organization_id: null, git_branch: null }],
        nextCursor: null,
      },
    ],
  });
}

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

/** Mounts the sync through one of its own retry triggers, and lets it settle. */
async function mountAndSync(): Promise<void> {
  act(() => {
    renderer ??= TestRenderer.create(createElement(SystemSearchIndexMount));
  });
  await act(async () => {
    for (const listener of appState.listeners) {
      listener('active');
    }
    // The sync coalesces nothing here: `syncNow` awaits its own run queue.
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  unlock.status = 'unlocked';
  appState.listeners.length = 0;
  client().clear();
  nativeBridge.replaceNativeSessionCatalog.mockResolvedValue(true);
  nativeBridge.clearNativeSessionCatalog.mockResolvedValue(true);
  renderer = undefined;
});

describe('the App Intents catalog and the privacy lock', () => {
  it('publishes the account’s titles while the app is unlocked', async () => {
    seedSession('Fix login bug');

    await mountAndSync();

    expect(nativeBridge.replaceNativeSessionCatalog).toHaveBeenCalledWith([
      { id: 'sess-1', title: 'Fix login bug' },
    ]);
  });

  it('wipes the titles when the lock closes and refuses to republish them', async () => {
    seedSession('Fix login bug');
    await mountAndSync();
    nativeBridge.replaceNativeSessionCatalog.mockClear();

    // The app goes to the background past the lock interval: the provider
    // publishes `locked`, and the mount follows it.
    unlock.status = 'locked';
    await act(async () => {
      renderer?.update(createElement(SystemSearchIndexMount));
    });

    expect(nativeBridge.clearNativeSessionCatalog).toHaveBeenCalledOnce();

    // A cache write and a return to the foreground while the lock stands must
    // not put the titles back.
    seedSession('Another title');
    await mountAndSync();

    expect(nativeBridge.replaceNativeSessionCatalog).not.toHaveBeenCalled();
  });

  it('publishes again once the lock opens', async () => {
    seedSession('Fix login bug');
    await mountAndSync();

    unlock.status = 'locked';
    await act(async () => {
      renderer?.update(createElement(SystemSearchIndexMount));
    });
    nativeBridge.replaceNativeSessionCatalog.mockClear();

    unlock.status = 'unlocked';
    await act(async () => {
      renderer?.update(createElement(SystemSearchIndexMount));
    });
    await mountAndSync();

    expect(nativeBridge.replaceNativeSessionCatalog).toHaveBeenCalledWith([
      { id: 'sess-1', title: 'Fix login bug' },
    ]);
  });
});
