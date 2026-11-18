import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ArtifactMirrorSyncMount,
  MIRROR_BURST_SETTLE_MS,
} from '@/lib/artifacts/artifact-mirror-sync-mount';
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
  captureException: vi.fn(),
  registerArtifactsProviderDomain: vi.fn(),
  syncArtifactMirror: vi.fn(),
}));

vi.mock('react-native', () => ({ AppState: { addEventListener: appState.register } }));
// The same way `notifyArtifactsChanged` is mocked elsewhere: the module mock is
// the registration seam this suite drives.
vi.mock('@sentry/react-native', () => ({ captureException: mocks.captureException }));
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

async function mountReturning(): Promise<TestRenderer.ReactTestRenderer> {
  const ref: PendingRendererRef = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(createElement(ArtifactMirrorSyncMount));
    await Promise.resolve();
  });
  // The mount's first run waits for the launch burst to settle
  // (`MIRROR_BURST_SETTLE_MS`); advancing the clock past that edge is what
  // a launch does once the tree is up and its own requests have gone out.
  await act(async () => {
    vi.advanceTimersByTime(MIRROR_BURST_SETTLE_MS);
    await Promise.resolve();
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('ArtifactMirrorSyncMount did not mount');
  }
  mounted.push(renderer);
  return renderer;
}

async function mount(): Promise<void> {
  await mountReturning();
}

function unmountAll(): void {
  for (const renderer of mounted.splice(0)) {
    renderer.unmount();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  // The bridge hands back a promise now; tests that need a failure override
  // this per case.
  mocks.registerArtifactsProviderDomain.mockResolvedValue(undefined);
  vi.useFakeTimers();
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
  vi.useRealTimers();
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

  it('re-runs on a foreground regain only after the interval, past the burst', async () => {
    await mount();

    appState.emit('background');
    appState.emit('active');
    expect(mocks.syncArtifactMirror).toHaveBeenCalledTimes(1);

    clock.now = MOUNT_TIME + mocks.MIRROR_SYNC_MIN_INTERVAL_MS - 1;
    appState.emit('active');
    expect(mocks.syncArtifactMirror).toHaveBeenCalledTimes(1);

    clock.now = MOUNT_TIME + mocks.MIRROR_SYNC_MIN_INTERVAL_MS;
    appState.emit('active');
    // The transition is accepted, but the run waits out the transition's own
    // request burst so the mirror's session-list read does not join the app's
    // foreground refresh (device check p2).
    expect(mocks.syncArtifactMirror).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(MIRROR_BURST_SETTLE_MS);
      await Promise.resolve();
    });
    expect(mocks.syncArtifactMirror).toHaveBeenCalledTimes(2);
    // Not forced: the engine's persisted `lastRunAt` stays the authority.
    expect(mocks.syncArtifactMirror).toHaveBeenLastCalledWith();
  });

  it('drops a scheduled foreground run when the app leaves the foreground', async () => {
    await mount();

    clock.now = MOUNT_TIME + mocks.MIRROR_SYNC_MIN_INTERVAL_MS;
    appState.emit('active');
    appState.emit('background');

    await act(async () => {
      vi.advanceTimersByTime(MIRROR_BURST_SETTLE_MS);
      await Promise.resolve();
    });

    // The trigger is foreground-only: a run scheduled by a regain that ended
    // before the burst settled never starts.
    expect(mocks.syncArtifactMirror).toHaveBeenCalledTimes(1);
  });

  it('stops listening on unmount', async () => {
    await mount();
    expect(appState.count()).toBe(1);

    unmountAll();

    expect(appState.count()).toBe(0);
  });

  it('reports a failed registration to Sentry without an unhandled rejection', async () => {
    mocks.registerArtifactsProviderDomain.mockRejectedValue(new Error('no file provider domain'));

    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      await mount();

      // The failure is absorbed by the mount itself and reported once, with
      // the artifact-mirror tags; the signed-in run proceeds regardless.
      expect(mocks.captureException).toHaveBeenCalledTimes(1);
      const [reported, options] = mocks.captureException.mock.calls[0] ?? [];
      expect(reported).toBeInstanceOf(Error);
      expect((reported as Error).message).toBe('Artifact File Provider registration failed');
      expect(options).toEqual({
        tags: {
          'error.subsystem': 'artifact-mirror',
          'error.operation': 'register-file-provider-domain',
        },
      });
      expect(mocks.syncArtifactMirror).toHaveBeenCalledTimes(1);
      // Wait out the burst settle so the fire-and-forget await lands inside
      // the fake timers' run; nothing else scheduled rejected.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('registers again on the next signed-in run after a failure', async () => {
    mocks.registerArtifactsProviderDomain.mockRejectedValue(new Error('no file provider domain'));
    const renderer = await mountReturning();
    expect(mocks.registerArtifactsProviderDomain).toHaveBeenCalledTimes(1);

    // There is no retry timer: time alone never re-runs the effect.
    await act(async () => {
      vi.advanceTimersByTime(mocks.MIRROR_SYNC_MIN_INTERVAL_MS * 2);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.registerArtifactsProviderDomain).toHaveBeenCalledTimes(1);

    // A new signed-in context (auth epoch) re-runs the effect.
    auth.value = { authEpoch: 1, isLoading: false, isSigningOut: false, token: 'token-1' };
    await act(async () => {
      renderer.update(createElement(ArtifactMirrorSyncMount));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.registerArtifactsProviderDomain).toHaveBeenCalledTimes(2);
    expect(mocks.captureException).toHaveBeenCalledTimes(2);
  });
});
