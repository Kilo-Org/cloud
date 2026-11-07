/* eslint-disable require-await -- the mocks settle without awaiting because they resolve immediately */
import { QueryClient } from '@tanstack/react-query';
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The provider is the lock's only source of truth; this suite moves its status
// the way a cold start, a background return and a successful unlock do.
const unlock = vi.hoisted(() => ({
  status: 'unlocked' as 'locked' | 'preference-loading' | 'unlocked',
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
  return {
    update: async status => {
      unlock.status = status;
      await act(async () => {
        renderer?.update(createElement(SystemSearchIndexMount));
        await Promise.resolve();
      });
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

  it('publishes nothing while the launch is still reading the lock preference', async () => {
    seedSession('Fix login bug');
    unlock.status = 'preference-loading';

    const mounted = await mountSync();

    expect(nativeBridge.replaceNativeSessionCatalog).not.toHaveBeenCalled();
    // The lock surface already covers the app during that read, so the titles
    // the previous process persisted are wiped for its length.
    expect(nativeBridge.clearNativeSessionCatalog).toHaveBeenCalledOnce();

    // The unlock edge is the retry for a publish the gate refused.
    await mounted.update('unlocked');

    expect(nativeBridge.replaceNativeSessionCatalog).toHaveBeenCalledWith([
      { id: 'sess-1', title: 'Fix login bug' },
    ]);
    mounted.unmount();
  });

  it('wipes the titles when the lock closes and refuses to republish them', async () => {
    seedSession('Fix login bug');
    const mounted = await mountSync();
    nativeBridge.replaceNativeSessionCatalog.mockClear();

    // The app goes to the background past the lock interval: the provider
    // publishes `locked`, and the mount follows it.
    await mounted.update('locked');

    expect(nativeBridge.clearNativeSessionCatalog).toHaveBeenCalledOnce();

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
});
