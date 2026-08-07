/* oxlint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer for RN trees under vitest (node env, no jsdom) */
/* oxlint-disable @typescript-eslint/no-unsafe-call @typescript-eslint/no-unsafe-member-access */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

  return { callOrder, secureStore, posthog, appsflyer, controller, posthogStorage, sentry };
});

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
  AppState: {
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
  },
}));

// ---- helpers ----

type AuthContextValue = {
  token: string | undefined;
  isLoading: boolean;
  signIn: (token: string) => Promise<void>;
  signOut: () => Promise<void>;
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
});
