/* oxlint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer for RN trees under vitest (node env, no jsdom) */
/* oxlint-disable @typescript-eslint/no-unsafe-call @typescript-eslint/no-unsafe-member-access */
/* eslint-disable max-lines -- one cohesive auth-context suite: sign-out teardown ordering and stale sign-in fencing share the provider mount and the SecureStore mock */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuthContextModule from './auth-context';

// ---- hoisted mocks ----

const hoisted = vi.hoisted(() => {
  const callOrder: string[] = [];

  const secureStore = {
    getItem: vi.fn().mockReturnValue(null),
    getItemAsync: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockReturnValue(undefined),
    setItemAsync: vi.fn().mockResolvedValue(undefined),
    // eslint-disable-next-line require-await -- mock returning a resolved promise
    deleteItemAsync: vi.fn().mockImplementation(async (_key: string) => {
      // Track the call in callOrder for ordering checks.
      callOrder.push('SecureStore.deleteItemAsync');
    }),
  };

  const posthog = {
    // eslint-disable-next-line require-await -- mock returning a resolved promise
    discardPostHog: vi.fn().mockImplementation(async () => {
      callOrder.push('discardPostHog');
    }),
  };

  const appsflyer = {
    resetAppsFlyerState: vi.fn().mockImplementation(() => {
      callOrder.push('resetAppsFlyerState');
    }),
    trackEvent: vi.fn(),
  };

  const controller = {
    clearTelemetryDecision: vi.fn().mockImplementation(() => {
      callOrder.push('clearTelemetryDecision');
    }),
  };

  const posthogStorage = {
    purgePostHogPersistence: vi.fn().mockImplementation(() => {
      callOrder.push('purgePostHogPersistence');
    }),
  };

  const sentry = {
    setUser: vi.fn().mockImplementation(() => {
      callOrder.push('Sentry.setUser');
    }),
  };

  // Hoisted so the foreground tests can capture AppState listeners from the
  // same mock instance every module registry resolves to.
  const appState = {
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
  };

  return {
    callOrder,
    secureStore,
    posthog,
    appsflyer,
    controller,
    posthogStorage,
    sentry,
    appState,
  };
});

// Hoisted so the sign-out regression test can make cache cleanup reject
// without loading the native-bound read-cache chain.
const readCacheMock = vi.hoisted(() => ({
  clearCacheScopeForSignOut: vi.fn().mockResolvedValue(undefined),
  readCachedUserId: vi.fn().mockReturnValue(null),
}));

// Hoisted so the FIFO and failure-matrix tests can hold remote cleanup open or
// force it to reject without loading the tRPC/notifications chain.
const logoutCleanupMock = vi.hoisted(() => ({
  runLogoutCleanup: vi.fn().mockResolvedValue(undefined),
}));

// ---- all vi.mock calls ----

vi.mock('expo-secure-store', () => ({
  getItem: hoisted.secureStore.getItem,
  getItemAsync: hoisted.secureStore.getItemAsync,
  setItem: hoisted.secureStore.setItem,
  setItemAsync: hoisted.secureStore.setItemAsync,
  deleteItemAsync: hoisted.secureStore.deleteItemAsync,
}));

vi.mock('@sentry/react-native', () => ({
  setUser: hoisted.sentry.setUser,
}));

vi.mock('@/lib/analytics/posthog', () => ({
  discardPostHog: hoisted.posthog.discardPostHog,
}));

vi.mock('@/lib/appsflyer', () => ({
  resetAppsFlyerState: hoisted.appsflyer.resetAppsFlyerState,
  trackEvent: hoisted.appsflyer.trackEvent,
}));

vi.mock('@/lib/telemetry/controller', () => ({
  clearTelemetryDecision: hoisted.controller.clearTelemetryDecision,
}));

vi.mock('@/lib/telemetry/posthog-storage', () => ({
  purgePostHogPersistence: hoisted.posthogStorage.purgePostHogPersistence,
}));

vi.mock('@/lib/query-client', () => ({
  queryClient: { clear: vi.fn() },
}));

vi.mock('@/lib/persist/read-cache', () => readCacheMock);

vi.mock('@/lib/auth/logout-cleanup', () => logoutCleanupMock);

vi.mock('@/lib/auth/trpc-unauthorized', () => ({
  setTrpcUnauthorizedHandler: vi.fn(),
}));

vi.mock('@/lib/hooks/use-persisted-agent-model', () => ({
  clearAgentModelPreference: vi.fn(),
}));

const { clearKeepScreenOnPreference, clearReasoningPreference } = vi.hoisted(() => ({
  clearKeepScreenOnPreference: vi.fn(),
  clearReasoningPreference: vi.fn(),
}));
vi.mock('@/lib/hooks/use-keep-screen-on-preference', () => ({ clearKeepScreenOnPreference }));

vi.mock('@/lib/hooks/use-reasoning-preference', () => ({ clearReasoningPreference }));

vi.mock('@/lib/last-active-instance', () => ({
  clearLastActiveInstance: vi.fn().mockResolvedValue(undefined),
}));

// The ownership module is intentionally NOT mocked here: the sign-out gate
// regression test must observe the real gate closing before any await and
// blocking a late persist from calling SecureStore.setItem.

vi.mock('@/lib/kilo-pass/use-store-kilo-pass-purchase', () => ({
  resetPurchaseErrorToastDedup: vi.fn(),
}));

vi.mock('@/lib/pr-review/recent-prs', () => ({
  clearRecentPrs: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/pr-review/viewed-files', () => ({
  clearViewedFiles: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/storage-keys', () => ({
  ACTIVE_USER_ID_KEY: 'active-user-id',
  AUTH_TOKEN_KEY: 'auth-token',
  KEEP_SCREEN_ON_KEY: 'keep-session-screen-on',
  KILOCLAW_OWNED_KEY: 'kiloclaw-owned',
  LEGACY_EXCHANGE_DONE_KEY: 'legacy-exchange-done',
  NOTIFICATION_PROMPT_SEEN_KEY: 'notification-prompt-seen',
  ORGANIZATION_STORAGE_KEY: 'organization',
  REFRESH_TOKEN_KEY: 'refresh-token',
  SESSION_FILTERS_KEY: 'session-filters',
  TOKEN_EXPIRES_AT_KEY: 'token-expires-at',
}));

vi.mock('@/lib/config', () => ({
  API_BASE_URL: 'https://api.example.com',
}));

vi.mock('react-native', () => ({
  AppState: hoisted.appState,
}));

// ---- helpers ----

type AuthContextValue = {
  token: string | undefined;
  isLoading: boolean;
  sessionEnded: boolean;
  authEpoch: number;
  isSigningOut: boolean;
  signIn: (token: string) => Promise<void>;
  signOut: (ended?: boolean) => Promise<void>;
};

/** Load the auth-context module from a fresh module registry so
 *  module-level state (preloadedToken) is clean. Returns the module
 *  and a helper to extract the context value from a mounted tree. */
// oxlint-disable-next-line require-await -- dynamic import is awaited
async function loadAuthModule() {
  vi.resetModules();
  const mod = await import('./auth-context');
  return mod;
}

/** Mount the AuthProvider and extract the auth context value via a
 *  consumer child. The context is captured synchronously once the
 *  component mounts inside act. */
async function mountAndGetContext(): Promise<{ ctx: AuthContextValue; unmount: () => void }> {
  const mod = await loadAuthModule();

  let capturedCtx: AuthContextValue | undefined = undefined;
  // The consumer captures ctx before any act flush.
  function Consumer(): null {
    capturedCtx = mod.useAuth();
    return null;
  }

  let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
  await act(async () => {
    renderer = TestRenderer.create(createElement(mod.AuthProvider, null, createElement(Consumer)));
    await Promise.resolve();
  });

  // After mount, isLoading becomes false because the preloaded token resolves.
  // We need to wait for the loading effect to complete.
  await act(async () => {
    await new Promise<void>(resolve => {
      void setTimeout(resolve, 0);
    });
  });

  // oxlint-disable-next-line @typescript-eslint/no-unnecessary-condition -- safety net for test failures
  if (!capturedCtx) {
    throw new Error('auth context not captured');
  }

  return {
    ctx: capturedCtx,
    unmount: () => {
      renderer?.unmount();
    },
  };
}

// ---- tests ----

describe('sign-out teardown ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.callOrder.length = 0;
    hoisted.secureStore.getItemAsync.mockResolvedValue(null);
  });

  it('calls clearTelemetryDecision and Sentry.setUser first, synchronously', async () => {
    const { ctx, unmount } = await mountAndGetContext();

    await act(async () => {
      await ctx.signOut();
    });

    // clearTelemetryDecision must be called
    expect(hoisted.controller.clearTelemetryDecision).toHaveBeenCalled();
    // Sentry.setUser must be called
    expect(hoisted.sentry.setUser).toHaveBeenCalledWith(null);

    // The first two calls in order must be clearTelemetryDecision then Sentry.setUser
    expect(hoisted.callOrder[0]).toBe('clearTelemetryDecision');
    expect(hoisted.callOrder[1]).toBe('Sentry.setUser');

    unmount();
  });

  it('calls AppsFlyer and PostHog teardown before SecureStore awaits', async () => {
    const { ctx, unmount } = await mountAndGetContext();

    await act(async () => {
      await ctx.signOut();
    });

    // resetAppsFlyerState must be called
    expect(hoisted.appsflyer.resetAppsFlyerState).toHaveBeenCalled();
    // discardPostHog must be called
    expect(hoisted.posthog.discardPostHog).toHaveBeenCalled();
    // purgePostHogPersistence must be called
    expect(hoisted.posthogStorage.purgePostHogPersistence).toHaveBeenCalled();

    // SDK teardown calls must appear before any SecureStore delete.
    // The first 5 synchronous calls must be in this exact order.
    const expectedPreamble = hoisted.callOrder.slice(0, 5);
    expect(expectedPreamble).toEqual([
      'clearTelemetryDecision',
      'Sentry.setUser',
      'resetAppsFlyerState',
      'discardPostHog',
      'purgePostHogPersistence',
    ]);

    // All SDK teardown must complete before SecureStore deletion starts.
    // Verify through invocationCallOrder.
    const sdkInvocationOrders = [
      hoisted.controller.clearTelemetryDecision.mock.invocationCallOrder[0],
      hoisted.sentry.setUser.mock.invocationCallOrder[0],
      hoisted.appsflyer.resetAppsFlyerState.mock.invocationCallOrder[0],
      hoisted.posthog.discardPostHog.mock.invocationCallOrder[0],
      hoisted.posthogStorage.purgePostHogPersistence.mock.invocationCallOrder[0],
    ];
    const secureStoreOrder = hoisted.secureStore.deleteItemAsync.mock.invocationCallOrder[0];
    expect(secureStoreOrder).toBeDefined();
    for (const invocationOrder of sdkInvocationOrders) {
      expect(invocationOrder).toBeLessThan(secureStoreOrder);
    }

    unmount();
  });

  it('tears down per-user SecureStore keys', async () => {
    const { ctx, unmount } = await mountAndGetContext();

    await act(async () => {
      await ctx.signOut();
    });

    expect(hoisted.secureStore.deleteItemAsync).toHaveBeenCalledWith('auth-token');
    expect(hoisted.secureStore.deleteItemAsync).toHaveBeenCalledWith('organization');
    expect(hoisted.secureStore.deleteItemAsync).toHaveBeenCalledWith('session-filters');
    expect(hoisted.secureStore.deleteItemAsync).toHaveBeenCalledWith('notification-prompt-seen');

    unmount();
  });

  it('clears both local preferences on sign-out', async () => {
    const { ctx } = await mountAndGetContext();

    await act(async () => {
      await ctx.signOut();
    });

    expect(clearKeepScreenOnPreference).toHaveBeenCalled();
    expect(clearReasoningPreference).toHaveBeenCalled();
  });

  it('closes the ownership gate before any await and blocks a late persist', async () => {
    const { ctx, unmount } = await mountAndGetContext();
    const ownership = await import('@/lib/kiloclaw-tab-ownership');

    // The old account's tab layout already resolved and persisted ownership.
    ownership.persistKiloClawOwned(true);
    expect(hoisted.secureStore.setItem).toHaveBeenCalledTimes(1);

    // Sign-out starts; the gate closes synchronously at the first line,
    // before the first await, while the teardown awaits are still in flight.
    const signOutPromise = ctx.signOut();

    // A late list reconcile from the old observer runs before
    // clearKiloClawOwned is reached.
    ownership.persistKiloClawOwned(false);

    await act(async () => {
      await signOutPromise;
    });

    // The late persist could not call SecureStore.setItem; only the
    // pre-sign-out write happened, and the clear step still deleted the key.
    expect(hoisted.secureStore.setItem).toHaveBeenCalledTimes(1);
    expect(hoisted.secureStore.setItem).toHaveBeenCalledWith('kiloclaw-owned', '1');
    expect(hoisted.secureStore.deleteItemAsync).toHaveBeenCalledWith('kiloclaw-owned');

    unmount();
  });

  it('regression: sign-out deletes run through deleteAccountMetadata and land after in-flight metadata writes', async () => {
    const { ctx, unmount } = await mountAndGetContext();
    const amw = await import('@/lib/auth/account-metadata-write');
    const secureStore = hoisted.secureStore;

    // An in-flight write holds the filters key's chain open.
    let releaseInFlight: (() => void) | undefined = undefined;
    const inFlightGate = new Promise<void>(resolve => {
      releaseInFlight = resolve;
    });
    let markStarted: (() => void) | undefined = undefined;
    const started = new Promise<void>(resolve => {
      markStarted = resolve;
    });
    const inFlight = amw.writeAccountMetadata('session-filters', async () => {
      markStarted?.();
      await inFlightGate;
      await secureStore.setItemAsync('session-filters', 'stale-filters');
    });
    // A second, now-stale write is queued behind it before the user signs out.
    const staleWrite = amw.writeAccountMetadata('session-filters', async () => {
      await secureStore.setItemAsync('session-filters', 'stale-filters-2');
    });

    // Wait until the in-flight write has started and holds the chain.
    await started;

    const signOutPromise = ctx.signOut();
    // Let signOut reach the per-key metadata deletes while the filters write
    // is still in flight, so the filters delete must serialize behind it.
    await vi.waitFor(() => {
      expect(secureStore.deleteItemAsync).toHaveBeenCalledWith('organization');
    });
    releaseInFlight?.();
    await act(async () => {
      await signOutPromise;
    });
    await Promise.all([inFlight, staleWrite]);

    // The stale queued write was fenced by the sign-out epoch bump: only the
    // in-flight write landed on the key.
    expect(secureStore.setItemAsync).toHaveBeenCalledTimes(1);
    expect(secureStore.setItemAsync).toHaveBeenCalledWith('session-filters', 'stale-filters');

    // The sign-out delete for the filters key ran through the per-key chain,
    // so it landed after the in-flight write to the same key — a plain
    // SecureStore delete could have been overtaken by the queued stale write.
    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith('session-filters');
    const deleteCalls = secureStore.deleteItemAsync.mock.calls;
    const deleteIndex = deleteCalls.findIndex((call: string[]) => call[0] === 'session-filters');
    expect(deleteIndex).toBeGreaterThanOrEqual(0);
    const deleteOrder = secureStore.deleteItemAsync.mock.invocationCallOrder[deleteIndex];
    expect(deleteOrder).toBeGreaterThan(secureStore.setItemAsync.mock.invocationCallOrder[0]);

    unmount();
  });

  it('regression: a cache cleanup failure does not abort sign-out query or auth state reset', async () => {
    const { ctx, unmount } = await mountAndGetContext();
    const { queryClient: queryClientMock } = await import('@/lib/query-client');
    const clearMock = vi.mocked(queryClientMock.clear);

    // The encrypted-kv clear rejects (storage failure): logout must still
    // attempt the cleanup before the query client clear, and the rejection
    // must not stop the clear, the credential deletes, or the state reset.
    readCacheMock.clearCacheScopeForSignOut.mockRejectedValueOnce(new Error('kv down'));

    await act(async () => {
      await ctx.signOut();
    });

    expect(readCacheMock.clearCacheScopeForSignOut).toHaveBeenCalledWith(null);
    const cleanupOrder: number =
      readCacheMock.clearCacheScopeForSignOut.mock.invocationCallOrder[0];
    const clearOrder: number = clearMock.mock.invocationCallOrder[0];
    expect(cleanupOrder).toBeLessThan(clearOrder);
    expect(clearMock).toHaveBeenCalledTimes(1);
    expect(hoisted.secureStore.deleteItemAsync).toHaveBeenCalledWith('active-user-id');

    unmount();
  });
});

describe('stale sign-in continuation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.callOrder.length = 0;
    hoisted.secureStore.getItemAsync.mockResolvedValue(null);
  });

  /** Mount the provider with a consumer that re-captures the context on
   *  every render, and resolve the preload effect. getCtx reads the latest
   *  captured value so a test can assert post-operation state. */
  // oxlint-disable-next-line require-await -- dynamic import is awaited
  async function mountStaleTest(): Promise<{
    getCtx: () => AuthContextValue;
    unmount: () => void;
  }> {
    vi.resetModules();
    const mod = await import('./auth-context');

    let capturedCtx: AuthContextValue | undefined = undefined;
    function Consumer(): null {
      capturedCtx = mod.useAuth();
      return null;
    }

    let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(mod.AuthProvider, null, createElement(Consumer))
      );
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise<void>(resolve => {
        void setTimeout(resolve, 0);
      });
    });

    return {
      getCtx: () => {
        // oxlint-disable-next-line @typescript-eslint/no-unnecessary-condition -- safety net for test failures
        if (!capturedCtx) {
          throw new Error('auth context not captured');
        }
        return capturedCtx;
      },
      unmount: () => {
        renderer?.unmount();
      },
    };
  }

  it('signs the new session out when a sign-out is queued behind a sign-in (FIFO)', async () => {
    const { getCtx, unmount } = await mountStaleTest();

    // Whole-body FIFO: the sign-in completes first (its credentials publish
    // and its login side effects run), then the sign-out runs the full
    // teardown of that new session.
    const signInPromise = getCtx().signIn('stale-token');
    const signOutPromise = getCtx().signOut(true);

    await act(async () => {
      await Promise.all([signInPromise, signOutPromise]);
    });

    expect(hoisted.appsflyer.trackEvent).toHaveBeenCalledTimes(1);
    const { resetPurchaseErrorToastDedup } =
      await import('@/lib/kilo-pass/use-store-kilo-pass-purchase');
    expect(resetPurchaseErrorToastDedup).toHaveBeenCalledTimes(1);
    // The sign-out won the race to the final state.
    expect(getCtx().token).toBeUndefined();
    expect(getCtx().sessionEnded).toBe(true);
    expect(getCtx().isSigningOut).toBe(true);
    const { queryClient: queryClientMock } = await import('@/lib/query-client');
    expect(vi.mocked(queryClientMock.clear)).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('runs each queued sign-in as a whole body; the newer sign-in wins', async () => {
    const { getCtx, unmount } = await mountStaleTest();

    // FIFO serialization means the first sign-in is NOT fenced by the second:
    // both publish and run their login side effects in queue order, and the
    // newer sign-in owns the final token.
    const firstSignIn = getCtx().signIn('first-token');
    const secondSignIn = getCtx().signIn('second-token');

    await act(async () => {
      await Promise.all([firstSignIn, secondSignIn]);
    });

    expect(hoisted.appsflyer.trackEvent).toHaveBeenCalledTimes(2);
    const { resetPurchaseErrorToastDedup } =
      await import('@/lib/kilo-pass/use-store-kilo-pass-purchase');
    expect(resetPurchaseErrorToastDedup).toHaveBeenCalledTimes(2);
    expect(getCtx().token).toBe('second-token');

    unmount();
  });

  it('regression: sign-out activates the reactive sign-out state and keeps it set after teardown', async () => {
    const { getCtx, unmount } = await mountStaleTest();

    expect(getCtx().isSigningOut).toBe(false);

    await act(async () => {
      await getCtx().signOut();
    });

    // The fence is closed at the synchronous start of sign-out and stays
    // closed through the whole teardown and after it: the cache mount cannot
    // resubscribe while the old user id is still cached or after the cleanup.
    expect(getCtx().isSigningOut).toBe(true);
    // Same flag, not a mirror: the cache write fence reads this module.
    const { isSignOutActive } = await import('@/lib/auth/sign-out-state');
    expect(isSignOutActive()).toBe(true);

    unmount();
  });

  it('regression: a published sign-in clears the sign-out state, a queued sign-out re-closes it', async () => {
    const { getCtx, unmount } = await mountStaleTest();

    // Sign out, then sign in successfully: the sign-in publishes on the
    // winning epoch and opens the fence.
    await act(async () => {
      await getCtx().signOut();
    });
    await act(async () => {
      await getCtx().signIn('new-token');
    });
    expect(getCtx().isSigningOut).toBe(false);
    const { isSignOutActive } = await import('@/lib/auth/sign-out-state');
    expect(isSignOutActive()).toBe(false);

    // FIFO: the sign-in runs its whole body (the fence opens), then the
    // sign-out queued behind it runs the full teardown and closes the fence
    // again — the final state is signed out.
    const signInPromise = getCtx().signIn('stale-token');
    const signOutPromise = getCtx().signOut(true);
    await act(async () => {
      await Promise.all([signInPromise, signOutPromise]);
    });
    expect(getCtx().isSigningOut).toBe(true);
    expect(getCtx().sessionEnded).toBe(true);

    unmount();
  });

  it('regression: sign-out sets the teardown guard and a published sign-in clears it', async () => {
    const { getCtx, unmount } = await mountStaleTest();
    const { isSignOutTeardownActive } = await import('@/lib/auth/token-owner');

    expect(isSignOutTeardownActive()).toBe(false);

    await act(async () => {
      await getCtx().signOut();
    });
    // The guard stays closed after teardown until a sign-in publishes.
    expect(isSignOutTeardownActive()).toBe(true);

    await act(async () => {
      await getCtx().signIn('new-token');
    });
    // The published sign-in ends the teardown window: refresh may rotate the
    // new session again.
    expect(isSignOutTeardownActive()).toBe(false);

    unmount();
  });
});

describe('bootstrap and foreground race fencing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.callOrder.length = 0;
    hoisted.secureStore.getItemAsync.mockResolvedValue(null);
  });

  /** Reset the module registry and mount the provider so the bootstrap load
   *  runs against the caller-installed SecureStore mock queue. The queue is
   *  consumed in this order: preloadedToken, preloadedRefreshToken, the
   *  bootstrap expiry read, then the bootstrap credential re-read. */
  async function mountProvider(): Promise<{
    getCtx: () => AuthContextValue;
    unmount: () => void;
    mod: AuthContextModule;
  }> {
    vi.resetModules();
    const mod = await import('./auth-context');

    let capturedCtx: AuthContextValue | undefined = undefined;
    function Consumer(): null {
      capturedCtx = mod.useAuth();
      return null;
    }

    let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(mod.AuthProvider, null, createElement(Consumer))
      );
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise<void>(resolve => {
        void setTimeout(resolve, 0);
      });
    });

    return {
      getCtx: () => {
        // oxlint-disable-next-line @typescript-eslint/no-unnecessary-condition -- safety net for test failures
        if (!capturedCtx) {
          throw new Error('auth context not captured');
        }
        return capturedCtx;
      },
      unmount: () => {
        renderer?.unmount();
      },
      mod,
    };
  }

  it('regression: sign-out during bootstrap does not restore the preloaded token into React state or the owner', async () => {
    let releaseRead: (() => void) | undefined = undefined;
    const readGate = new Promise<void>(resolve => {
      releaseRead = resolve;
    });
    // Mock queue consumed by the bootstrap load: preloadedToken,
    // preloadedRefreshToken, then the expiry read (held), then the
    // credential re-read (unchanged, so only the epoch fence can stop it).
    hoisted.secureStore.getItemAsync
      .mockResolvedValueOnce('stored-token')
      .mockResolvedValueOnce('stored-refresh')
      .mockImplementationOnce(async () => {
        // Bootstrap expiry read: hold open so a sign-out can land mid-read.
        await readGate;
        return '9999999999999';
      })
      .mockResolvedValueOnce('stored-token');

    const { getCtx, unmount } = await mountProvider();

    // Sign out while the bootstrap expiry read is in flight.
    await act(async () => {
      await getCtx().signOut(true);
    });

    releaseRead?.();
    await act(async () => {
      await new Promise<void>(resolve => {
        void setTimeout(resolve, 0);
      });
    });

    // The stale bootstrap never published — even with the stored credentials
    // unchanged, the epoch fence stops the preloaded token from being
    // resurrected into React state or the token owner.
    const tokenOwner = await import('@/lib/auth/token-owner');
    expect(tokenOwner.getActiveToken()).toBeNull();
    expect(getCtx().token).toBeUndefined();
    expect(getCtx().sessionEnded).toBe(true);

    unmount();
  });

  it('regression: bootstrap publishes the refreshed token when credentials change during the load', async () => {
    let releaseRead: (() => void) | undefined = undefined;
    const readGate = new Promise<void>(resolve => {
      releaseRead = resolve;
    });
    // Mock queue consumed by the bootstrap load: preloadedToken,
    // preloadedRefreshToken, then the expiry read (held). The credential
    // re-read falls back to the null base mock, so it reports the preloaded
    // snapshot no longer matches the stored session.
    hoisted.secureStore.getItemAsync
      .mockResolvedValueOnce('stored-token')
      .mockResolvedValueOnce('stored-refresh')
      .mockImplementationOnce(async () => {
        // Bootstrap expiry read: hold open while a same-session credential
        // write replaces the stored pair.
        await readGate;
        return '9999999999999';
      });

    const { getCtx, unmount } = await mountProvider();

    // A same-session refresh replaces the stored pair and publishes the owner
    // while the bootstrap expiry read is in flight.
    await act(async () => {
      const credentials = await import('@/lib/auth/credentials');
      await credentials.persistSignInCredentialsAtEpoch('newer-token', 'newer-refresh', {
        expiresIn: 3600,
      });
    });

    releaseRead?.();
    await act(async () => {
      await new Promise<void>(resolve => {
        void setTimeout(resolve, 0);
      });
    });

    // The refresh-owned session stands: the preloaded snapshot was not
    // republished over it, and bootstrap surfaced the refreshed token instead
    // of ending with none — publishing nothing sends a signed-in user to the
    // login screen until the next relaunch.
    const tokenOwner = await import('@/lib/auth/token-owner');
    expect(tokenOwner.getActiveToken()).toEqual({
      token: 'newer-token',
      expiresAtMs: expect.any(Number),
    });
    expect(getCtx().token).toBe('newer-token');

    unmount();
  });

  it('regression: sign-out during bootstrap wins over changed stored credentials', async () => {
    let releaseRead: (() => void) | undefined = undefined;
    const readGate = new Promise<void>(resolve => {
      releaseRead = resolve;
    });
    // Mock queue consumed by the bootstrap load: preloadedToken,
    // preloadedRefreshToken, then the expiry read (held). The credential
    // re-read falls back to the null base mock, so the stored pair no longer
    // matches the preloaded snapshot — the sign-out deleted it.
    hoisted.secureStore.getItemAsync
      .mockResolvedValueOnce('stored-token')
      .mockResolvedValueOnce('stored-refresh')
      .mockImplementationOnce(async () => {
        await readGate;
        return '9999999999999';
      });

    const { getCtx, unmount } = await mountProvider();

    // Sign out while the bootstrap expiry read is in flight.
    await act(async () => {
      await getCtx().signOut(true);
    });

    releaseRead?.();
    await act(async () => {
      await new Promise<void>(resolve => {
        void setTimeout(resolve, 0);
      });
    });

    // The changed-credentials branch publishes the session winner, but the
    // epoch fence stops it after sign-out: a torn-down session must never be
    // resurrected.
    const tokenOwner = await import('@/lib/auth/token-owner');
    expect(tokenOwner.getActiveToken()).toBeNull();
    expect(getCtx().token).toBeUndefined();
    expect(getCtx().sessionEnded).toBe(true);

    unmount();
  });

  it('regression: a foreground event from a stale epoch does not refresh or publish a token after sign-out', async () => {
    const { getCtx, unmount } = await mountProvider();

    // Sign in so the foreground effect re-subscribes with a token in scope.
    await act(async () => {
      await getCtx().signIn('active-token');
    });

    // Grab the listener registered by the token-bearing foreground effect.
    const listeners = hoisted.appState.addEventListener.mock.calls;
    const eventListener = listeners.at(-1)?.[1];

    // Hold the expiry read open so a sign-out can land inside the handler.
    let releaseRead: (() => void) | undefined = undefined;
    const readGate = new Promise<void>(resolve => {
      releaseRead = resolve;
    });
    hoisted.secureStore.getItemAsync.mockImplementationOnce(async () => {
      await readGate;
      // An expiry inside the refresh margin: without the epoch fence the
      // handler would proceed to refresh.
      return String(Date.now() + 60_000);
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await act(async () => {
      eventListener?.('active');
      await Promise.resolve();
    });

    // Sign out while the foreground event's expiry read is in flight.
    await act(async () => {
      await getCtx().signOut(true);
    });

    releaseRead?.();
    await act(async () => {
      await new Promise<void>(resolve => {
        void setTimeout(resolve, 0);
      });
    });

    // The stale event never initiated a refresh and never published a token.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getCtx().token).toBeUndefined();
    const tokenOwner = await import('@/lib/auth/token-owner');
    expect(tokenOwner.getActiveToken()).toBeNull();

    fetchSpy.mockRestore();
    unmount();
  });
});

describe('reactive auth epoch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.callOrder.length = 0;
    hoisted.secureStore.getItemAsync.mockResolvedValue(null);
  });

  /** Mount the provider with a consumer that re-captures the context on every
   *  render, so the test can read the epoch after sign-in or sign-out moved it. */
  // oxlint-disable-next-line require-await -- dynamic import is awaited
  async function mountEpochTest(): Promise<{
    getCtx: () => AuthContextValue;
    unmount: () => void;
  }> {
    vi.resetModules();
    const mod = await import('./auth-context');

    let capturedCtx: AuthContextValue | undefined = undefined;
    function Consumer(): null {
      capturedCtx = mod.useAuth();
      return null;
    }

    let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(mod.AuthProvider, null, createElement(Consumer))
      );
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise<void>(resolve => {
        void setTimeout(resolve, 0);
      });
    });

    return {
      getCtx: () => {
        // oxlint-disable-next-line @typescript-eslint/no-unnecessary-condition -- safety net for test failures
        if (!capturedCtx) {
          throw new Error('auth context not captured');
        }
        return capturedCtx;
      },
      unmount: () => {
        renderer?.unmount();
      },
    };
  }

  it('exposes the current auth epoch in the context value', async () => {
    const { getCtx, unmount } = await mountEpochTest();
    const { currentAuthEpoch } = await import('@/lib/auth/auth-epoch');

    expect(getCtx().authEpoch).toBe(currentAuthEpoch());

    unmount();
  });

  it('advances the reactive auth epoch immediately when signIn bumps the epoch', async () => {
    const { getCtx, unmount } = await mountEpochTest();
    const { currentAuthEpoch } = await import('@/lib/auth/auth-epoch');
    const before = getCtx().authEpoch;

    await act(async () => {
      await getCtx().signIn('new-token');
    });

    expect(getCtx().authEpoch).toBeGreaterThan(before);
    expect(getCtx().authEpoch).toBe(currentAuthEpoch());

    unmount();
  });

  it('advances the reactive auth epoch immediately when signOut bumps the epoch', async () => {
    const { getCtx, unmount } = await mountEpochTest();
    const { currentAuthEpoch } = await import('@/lib/auth/auth-epoch');
    const before = getCtx().authEpoch;

    await act(async () => {
      await getCtx().signOut();
    });

    expect(getCtx().authEpoch).toBeGreaterThan(before);
    expect(getCtx().authEpoch).toBe(currentAuthEpoch());

    unmount();
  });
});

describe('auth-transition queue and sign-out failure matrix', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.callOrder.length = 0;
    hoisted.secureStore.getItemAsync.mockResolvedValue(null);
  });

  async function mountQueueTest(): Promise<{
    getCtx: () => AuthContextValue;
    unmount: () => void;
  }> {
    vi.resetModules();
    const mod = await import('./auth-context');

    let capturedCtx: AuthContextValue | undefined = undefined;
    function Consumer(): null {
      capturedCtx = mod.useAuth();
      return null;
    }

    let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(mod.AuthProvider, null, createElement(Consumer))
      );
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise<void>(resolve => {
        void setTimeout(resolve, 0);
      });
    });

    return {
      getCtx: () => {
        // oxlint-disable-next-line @typescript-eslint/no-unnecessary-condition -- safety net for test failures
        if (!capturedCtx) {
          throw new Error('auth context not captured');
        }
        return capturedCtx;
      },
      unmount: () => {
        renderer?.unmount();
      },
    };
  }

  it('queues a sign-in behind an in-flight sign-out so it lands after the full teardown', async () => {
    const { getCtx, unmount } = await mountQueueTest();

    // Hold the sign-out's remote cleanup open so the teardown is mid-flight
    // when the sign-in is queued.
    let releaseCleanup: (() => void) | undefined = undefined;
    const cleanupGate = new Promise<void>(resolve => {
      releaseCleanup = resolve;
    });
    logoutCleanupMock.runLogoutCleanup.mockImplementationOnce(async () => {
      await cleanupGate;
    });

    const signOutPromise = getCtx().signOut();
    await vi.waitFor(() => {
      expect(logoutCleanupMock.runLogoutCleanup).toHaveBeenCalled();
    });

    // The sign-in is queued behind the sign-out: while the cleanup is held it
    // must not run its credential write or any login side effect.
    const signInPromise = getCtx().signIn('queued-token');
    await act(async () => {
      await new Promise<void>(resolve => {
        void setTimeout(resolve, 0);
      });
    });
    expect(hoisted.secureStore.setItemAsync).not.toHaveBeenCalled();
    expect(hoisted.appsflyer.trackEvent).not.toHaveBeenCalled();

    const { queryClient: queryClientMock } = await import('@/lib/query-client');
    const clearMock = vi.mocked(queryClientMock.clear);

    releaseCleanup?.();
    await act(async () => {
      await Promise.all([signOutPromise, signInPromise]);
    });

    // Whole-body FIFO: the sign-out's teardown (including the query-client
    // clear) settled before the sign-in's credential write ran.
    expect(clearMock).toHaveBeenCalledTimes(1);
    const clearOrder = clearMock.mock.invocationCallOrder[0];
    const setOrder = hoisted.secureStore.setItemAsync.mock.invocationCallOrder[0];
    expect(clearOrder).toBeLessThan(setOrder);
    expect(hoisted.appsflyer.trackEvent).toHaveBeenCalledTimes(1);
    expect(getCtx().token).toBe('queued-token');
    expect(getCtx().sessionEnded).toBe(false);
    expect(getCtx().isSigningOut).toBe(false);

    unmount();
  });

  it('runs a double sign-out teardown exactly once (in-run dedupe)', async () => {
    const { getCtx, unmount } = await mountQueueTest();

    const first = getCtx().signOut();
    const second = getCtx().signOut();

    await act(async () => {
      await Promise.all([first, second]);
    });

    // The second queued sign-out no-ops: teardown ran exactly once.
    expect(hoisted.posthog.discardPostHog).toHaveBeenCalledTimes(1);
    const { queryClient: queryClientMock } = await import('@/lib/query-client');
    expect(vi.mocked(queryClientMock.clear)).toHaveBeenCalledTimes(1);
    expect(hoisted.secureStore.deleteItemAsync).toHaveBeenCalledWith('auth-token');
    expect(getCtx().token).toBeUndefined();
    expect(getCtx().sessionEnded).toBe(false);

    unmount();
  });

  it('still runs cleanup, the epoch bump, the deletion batch, and state reset when PostHog teardown throws', async () => {
    const { getCtx, unmount } = await mountQueueTest();
    hoisted.posthog.discardPostHog.mockRejectedValueOnce(new Error('posthog down'));

    await act(async () => {
      await getCtx().signOut();
    });

    // Cleanup still ran, the deletion batch still ran, and auth state reset.
    expect(logoutCleanupMock.runLogoutCleanup).toHaveBeenCalledTimes(1);
    expect(hoisted.secureStore.deleteItemAsync).toHaveBeenCalledWith('auth-token');
    expect(hoisted.secureStore.deleteItemAsync).toHaveBeenCalledWith('organization');
    const { queryClient: queryClientMock } = await import('@/lib/query-client');
    expect(vi.mocked(queryClientMock.clear)).toHaveBeenCalledTimes(1);
    expect(getCtx().token).toBeUndefined();
    expect(getCtx().sessionEnded).toBe(false);

    unmount();
  });

  it('still bumps the epoch, clears the token, runs the batch, and resets state when runLogoutCleanup throws', async () => {
    const { getCtx, unmount } = await mountQueueTest();
    const { currentAuthEpoch } = await import('@/lib/auth/auth-epoch');
    const before: number = currentAuthEpoch();
    // Contract violation (runLogoutCleanup never throws): the outer finally
    // must still run the epoch bump and the local teardown.
    logoutCleanupMock.runLogoutCleanup.mockRejectedValueOnce(new Error('cleanup exploded'));

    const signOutPromise = getCtx().signOut();
    await act(async () => {
      await signOutPromise.catch(() => {
        // The rejection is the forced contract violation; only the finally
        // ordering matters here.
      });
    });

    expect(currentAuthEpoch()).toBeGreaterThan(before);
    const tokenOwner = await import('@/lib/auth/token-owner');
    expect(tokenOwner.getActiveToken()).toBeNull();
    expect(hoisted.secureStore.deleteItemAsync).toHaveBeenCalledWith('auth-token');
    expect(hoisted.secureStore.deleteItemAsync).toHaveBeenCalledWith('active-user-id');
    const { queryClient: queryClientMock } = await import('@/lib/query-client');
    expect(vi.mocked(queryClientMock.clear)).toHaveBeenCalledTimes(1);
    expect(getCtx().token).toBeUndefined();
    expect(getCtx().sessionEnded).toBe(false);

    unmount();
  });

  it('runs every other batch member, the preference clears, and state reset when one batch member rejects', async () => {
    const { getCtx, unmount } = await mountQueueTest();
    const { clearLastActiveInstance } = await import('@/lib/last-active-instance');
    vi.mocked(clearLastActiveInstance).mockRejectedValueOnce(new Error('storage down'));

    await act(async () => {
      await getCtx().signOut();
    });

    // All independent batch members still ran despite the one rejection.
    expect(hoisted.secureStore.deleteItemAsync).toHaveBeenCalledWith('auth-token');
    expect(hoisted.secureStore.deleteItemAsync).toHaveBeenCalledWith('organization');
    expect(hoisted.secureStore.deleteItemAsync).toHaveBeenCalledWith('session-filters');
    expect(hoisted.secureStore.deleteItemAsync).toHaveBeenCalledWith('active-user-id');
    const { clearAgentModelPreference } = await import('@/lib/hooks/use-persisted-agent-model');
    expect(clearAgentModelPreference).toHaveBeenCalled();
    const { queryClient: queryClientMock } = await import('@/lib/query-client');
    expect(vi.mocked(queryClientMock.clear)).toHaveBeenCalledTimes(1);
    expect(getCtx().token).toBeUndefined();

    unmount();
  });

  it('resets auth state even when the deletion batch phase throws synchronously', async () => {
    const { getCtx, unmount } = await mountQueueTest();
    // A synchronous throw while the allSettled batch is being built: the
    // batch never runs, the preference clears are skipped, and the inner
    // finally still resets query and auth state.
    readCacheMock.readCachedUserId.mockImplementationOnce(() => {
      throw new Error('cache read exploded');
    });

    const signOutPromise = getCtx().signOut();
    await act(async () => {
      await signOutPromise.catch(() => {
        // The synchronous batch-phase throw propagates after the finally.
      });
    });

    const { queryClient: queryClientMock } = await import('@/lib/query-client');
    expect(vi.mocked(queryClientMock.clear)).toHaveBeenCalledTimes(1);
    const { clearAgentModelPreference } = await import('@/lib/hooks/use-persisted-agent-model');
    expect(clearAgentModelPreference).not.toHaveBeenCalled();
    expect(getCtx().token).toBeUndefined();
    expect(getCtx().sessionEnded).toBe(false);

    unmount();
  });
});
