import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ArtifactMirrorSyncMount } from '@/lib/artifacts/artifact-mirror-sync-mount';
import { act, TestRenderer } from '@/test/renderer';

// The mount reads three process-wide inputs: the auth session, the resolved
// user id, and `AppState`. All three are stand-ins here, so a mounted render
// drives the real effect without a device. The interval is the engine's value:
// `artifact-mirror-sync-mount.test.ts` pins the policy against the real
// constant, and this suite drives the mount's behaviour with the same number.
const appState = vi.hoisted(() => {
  const listeners = new Set<(state: string) => void>();
  return {
    count: () => listeners.size,
    emit: (state: string): void => {
      for (const listener of listeners) {
        listener(state);
      }
    },
    register: (_event: string, listener: (state: string) => void) => {
      listeners.add(listener);
      return {
        remove: () => {
          listeners.delete(listener);
        },
      };
    },
    reset: () => {
      listeners.clear();
    },
  };
});

const clock = vi.hoisted(() => ({ now: 0 }));

const auth = vi.hoisted(() => ({
  value: {
    authEpoch: 0,
    isLoading: false,
    isSigningOut: false,
    token: 'token-1' as string | undefined,
  },
}));

const user = vi.hoisted(() => ({
  value: {
    isError: false,
    isLoading: false,
    userId: 'user-1' as string | undefined,
  },
}));

const mocks = vi.hoisted(() => ({
  MIRROR_SYNC_MIN_INTERVAL_MS: 5 * 60 * 1000,
  registerArtifactsProviderDomain: vi.fn(),
  syncArtifactMirror: vi.fn(),
}));

vi.mock('react-native', () => ({ AppState: { addEventListener: appState.register } }));
vi.mock('@/lib/artifacts/artifact-mirror-sync', () => ({
  MIRROR_SYNC_MIN_INTERVAL_MS: mocks.MIRROR_SYNC_MIN_INTERVAL_MS,
  syncArtifactMirror: mocks.syncArtifactMirror,
}));
vi.mock('@/lib/artifacts/artifact-provider-native', () => ({
  registerArtifactsProviderDomain: mocks.registerArtifactsProviderDomain,
}));
vi.mock('@/lib/auth/auth-context', () => ({ useAuth: () => auth.value }));
vi.mock('@/lib/hooks/use-current-user-id', () => ({ useCurrentUserId: () => user.value }));

/** Mount time the policy's window is measured from. */
const MOUNT_TIME = 1_700_000_000_000;

/** Named so a renderer held across the `act` boundary reads as an owned contract. */
type PendingRendererRef = { current: TestRenderer.ReactTestRenderer | undefined };

const mounted: TestRenderer.ReactTestRenderer[] = [];

async function mount(): Promise<void> {
  const ref: PendingRendererRef = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(createElement(ArtifactMirrorSyncMount));
    await Promise.resolve();
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('ArtifactMirrorSyncMount did not mount');
  }
  mounted.push(renderer);
}

function unmountAll(): void {
  for (const renderer of mounted.splice(0)) {
    renderer.unmount();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  clock.now = MOUNT_TIME;
  vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
  appState.reset();
  auth.value = { authEpoch: 0, isLoading: false, isSigningOut: false, token: 'token-1' };
  user.value = { isError: false, isLoading: false, userId: 'user-1' };
});

afterEach(() => {
  unmountAll();
  appState.reset();
  vi.restoreAllMocks();
});

describe('ArtifactMirrorSyncMount', () => {
  it('forces one run and registers the provider domain for a signed-in user', async () => {
    await mount();

    expect(mocks.syncArtifactMirror).toHaveBeenCalledTimes(1);
    expect(mocks.syncArtifactMirror).toHaveBeenCalledWith({ force: true });
    expect(mocks.registerArtifactsProviderDomain).toHaveBeenCalledTimes(1);
  });

  it('waits for the resolved user instead of running as no-user', async () => {
    user.value = { isError: false, isLoading: true, userId: undefined };

    await mount();

    expect(mocks.syncArtifactMirror).not.toHaveBeenCalled();
    expect(appState.count()).toBe(0);
  });

  it('does not run while sign-out is in progress', async () => {
    auth.value = { authEpoch: 0, isLoading: false, isSigningOut: true, token: 'token-1' };

    await mount();

    expect(mocks.syncArtifactMirror).not.toHaveBeenCalled();
    expect(mocks.registerArtifactsProviderDomain).not.toHaveBeenCalled();
  });

  it('re-runs on a foreground regain only after the interval', async () => {
    await mount();

    appState.emit('background');
    appState.emit('active');
    expect(mocks.syncArtifactMirror).toHaveBeenCalledTimes(1);

    clock.now = MOUNT_TIME + mocks.MIRROR_SYNC_MIN_INTERVAL_MS - 1;
    appState.emit('active');
    expect(mocks.syncArtifactMirror).toHaveBeenCalledTimes(1);

    clock.now = MOUNT_TIME + mocks.MIRROR_SYNC_MIN_INTERVAL_MS;
    appState.emit('active');
    expect(mocks.syncArtifactMirror).toHaveBeenCalledTimes(2);
    // Not forced: the engine's persisted `lastRunAt` stays the authority.
    expect(mocks.syncArtifactMirror).toHaveBeenLastCalledWith();
  });

  it('stops listening on unmount', async () => {
    await mount();
    expect(appState.count()).toBe(1);

    unmountAll();

    expect(appState.count()).toBe(0);
  });
});
