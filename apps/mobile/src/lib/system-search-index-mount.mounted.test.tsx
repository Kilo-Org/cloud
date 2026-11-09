/* eslint-disable require-await -- the mocks settle without awaiting because they resolve immediately */
import { QueryClient } from '@tanstack/react-query';
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The provider is the lock's only source of truth; this suite moves its status
// the way a cold start, a background return and a successful unlock do, and its
// switch the way Preferences does.
const unlock = vi.hoisted(() => ({
  status: 'unlocked' as 'locked' | 'preference-loading' | 'unlocked',
  enabled: false,
  intervalMs: 1_234,
  useAppUnlock: () => ({ status: unlock.status, enabled: unlock.enabled }),
}));

vi.mock('@/lib/app-unlock-context', () => ({
  useAppUnlock: unlock.useAppUnlock,
  BACKGROUND_LOCK_MS: unlock.intervalMs,
}));

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
  setNativeSessionCatalogLock: vi.fn<() => void>(),
  setNativeSessionCatalogVisible: vi.fn<() => void>(),
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
  const { QueryClient: Client } = await import('@tanstack/react-query');
  hoisted.queryClient ??= new Client();
  return { queryClient: hoisted.queryClient };
});

function client(): QueryClient {
  if (hoisted.queryClient === null) {
    hoisted.queryClient = new QueryClient();
  }
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
        cliSessions: [
          {
            session_id: 'sess-1',
            title,
            organization_id: null,
            git_branch: null,
            updated_at: new Date().toISOString(),
          },
        ],
        nextCursor: null,
      },
    ],
  });
}

type Mounted = {
  update: (status: 'locked' | 'preference-loading' | 'unlocked') => Promise<void>;
  setLock: (enabled: boolean) => Promise<void>;
  unmount: () => void;
};

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

/**
 * Mounts a fresh copy of the module graph, so the lock state starts from its
 * process default instead of the previous case's status.
 */
async function mountSync(): Promise<Mounted> {
  vi.resetModules();
  const { SystemSearchIndexMount } = await import('@/lib/system-search-index-mount');
  act(() => {
    renderer = TestRenderer.create(createElement(SystemSearchIndexMount));
  });
  await act(async () => {
    // The sync awaits its own run queue on the unlock edge.
    await Promise.resolve();
  });
  const rerender = async (): Promise<void> => {
    await act(async () => {
      renderer?.update(createElement(SystemSearchIndexMount));
      await Promise.resolve();
    });
  };
  return {
    update: async status => {
      unlock.status = status;
      await rerender();
    },
    setLock: async enabled => {
      unlock.enabled = enabled;
      await rerender();
    },
    unmount: () => {
      act(() => {
        renderer?.unmount();
      });
      renderer = undefined;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  unlock.status = 'unlocked';
  unlock.enabled = false;
  appState.listeners.length = 0;
  client().clear();
  nativeBridge.replaceNativeSessionCatalog.mockResolvedValue(true);
  nativeBridge.clearNativeSessionCatalog.mockResolvedValue(true);
  renderer = undefined;
});

describe('the App Intents catalog and the privacy lock', () => {
  it('publishes the account’s titles once the app is known to be unlocked', async () => {
    seedSession('Fix login bug');

    const mounted = await mountSync();

    expect(nativeBridge.replaceNativeSessionCatalog).toHaveBeenCalledWith([
      { id: 'sess-1', title: 'Fix login bug' },
    ]);
    mounted.unmount();
  });

  it('leaves the stored titles alone on a launch with no cached session rows', async () => {
    // A cold launch runs the sync before the stored history answers, and a
    // rename runs it again while the list entry is gone and its first page is
    // refetching. Neither may replace the device's catalog with the nothing it
    // saw: a saved shortcut resolves its session against what is stored.
    const mounted = await mountSync();

    expect(nativeBridge.replaceNativeSessionCatalog).not.toHaveBeenCalled();
    expect(nativeBridge.clearNativeSessionCatalog).not.toHaveBeenCalled();

    // The foreground event is the retry that runs once the list has loaded.
    seedSession('Fix login bug');
    await act(async () => {
      for (const listener of appState.listeners) {
        listener('active');
      }
      await Promise.resolve();
    });

    expect(nativeBridge.replaceNativeSessionCatalog).toHaveBeenCalledWith([
      { id: 'sess-1', title: 'Fix login bug' },
    ]);
    mounted.unmount();
  });

  it('clears the stored titles when the settled session read is empty', async () => {
    // The list answered and holds no rows, so an empty catalog is the truth.
    client().setQueryData(SESSION_LIST_KEY, {
      pages: [{ cliSessions: [], nextCursor: null }],
    });

    const mounted = await mountSync();

    expect(nativeBridge.replaceNativeSessionCatalog).toHaveBeenCalledExactlyOnceWith([]);
    mounted.unmount();
  });

  it('publishes nothing while the launch is still reading the lock preference', async () => {
    seedSession('Fix login bug');
    unlock.status = 'preference-loading';

    const mounted = await mountSync();

    expect(nativeBridge.replaceNativeSessionCatalog).not.toHaveBeenCalled();
    // The lock surface already covers the app during that read, so the titles
    // the previous process persisted stay hidden for its length — hidden, not
    // wiped, because a launch the system starts for an App Intent still has to
    // be able to resolve a session a saved shortcut names.
    expect(nativeBridge.setNativeSessionCatalogVisible).toHaveBeenLastCalledWith(false);
    expect(nativeBridge.clearNativeSessionCatalog).not.toHaveBeenCalled();
    // The stored switch is the last launch's answer, and the store checks it
    // before the visibility above: writing this process's unread `false` here
    // would open the titles the visibility flag just closed.
    expect(nativeBridge.setNativeSessionCatalogLock).not.toHaveBeenCalled();

    // The unlock edge is the retry for a publish the gate refused.
    await mounted.update('unlocked');

    expect(nativeBridge.replaceNativeSessionCatalog).toHaveBeenCalledWith([
      { id: 'sess-1', title: 'Fix login bug' },
    ]);
    expect(nativeBridge.setNativeSessionCatalogVisible).toHaveBeenLastCalledWith(true);
    expect(nativeBridge.setNativeSessionCatalogLock).toHaveBeenCalledWith(false, 1_234);
    mounted.unmount();
  });

  it('hides the titles when the lock closes and refuses to republish them', async () => {
    seedSession('Fix login bug');
    const mounted = await mountSync();
    nativeBridge.replaceNativeSessionCatalog.mockClear();

    // The app goes to the background past the lock interval: the provider
    // publishes `locked`, and the mount follows it.
    await mounted.update('locked');

    expect(nativeBridge.setNativeSessionCatalogVisible).toHaveBeenLastCalledWith(false);

    // A return to the foreground while the lock stands must not put the titles
    // back.
    await act(async () => {
      for (const listener of appState.listeners) {
        listener('active');
      }
      await Promise.resolve();
    });

    expect(nativeBridge.replaceNativeSessionCatalog).not.toHaveBeenCalled();
    mounted.unmount();
  });

  it('publishes again after the lock opens', async () => {
    seedSession('Fix login bug');
    const mounted = await mountSync();
    await mounted.update('locked');
    nativeBridge.replaceNativeSessionCatalog.mockClear();

    await mounted.update('unlocked');

    expect(nativeBridge.replaceNativeSessionCatalog).toHaveBeenCalledWith([
      { id: 'sess-1', title: 'Fix login bug' },
    ]);
    mounted.unmount();
  });

  it('hands the native catalog the lock switch and the interval it allows', async () => {
    const mounted = await mountSync();

    // The interval is the provider's, not a second copy: the store withholds
    // the titles at exactly the point the app would lock its own surface.
    expect(nativeBridge.setNativeSessionCatalogLock).toHaveBeenCalledWith(false, 1_234);

    await mounted.setLock(true);

    expect(nativeBridge.setNativeSessionCatalogLock).toHaveBeenLastCalledWith(true, 1_234);
    mounted.unmount();
  });
});
