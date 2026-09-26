/// <reference lib="es2024.promise" />
/* oxlint-disable @typescript-eslint/no-unsafe-call @typescript-eslint/no-unsafe-member-access */
/* eslint-disable max-lines -- one cohesive auth-context suite: sign-out teardown ordering and stale sign-in fencing share the provider mount and the SecureStore mock */
import { createElement } from 'react';
import { type AppState } from 'react-native';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type * as AuthContextModule from './auth-context';
import type * as ContextScopeModule from '../context-scope';
import type * as TokenOwnerModule from './token-owner';
import { ORGANIZATION_PERSONAL_STORAGE_KEY } from '@/lib/storage-keys';

// The mobile-app gate runs `vitest related` over ~170 files concurrently with
// the device stack, so every real timer in this file stretches several-fold.
// Give each test room for the load-aware settle budget below instead of the
// 5 s default (the sibling intl-cache Hermes test carries the same node-load
// budget for the same reason).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

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
    captureEvent: vi.fn().mockImplementation(() => {
      callOrder.push('captureEvent');
    }),
    // eslint-disable-next-line require-await -- mock returning a resolved promise
    flushLastPostHogEvent: vi.fn().mockImplementation(async () => {
      callOrder.push('flushLastPostHogEvent');
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
    setTag: vi.fn(),
  };

  // Hoisted so the foreground tests can capture AppState listeners from the
  // same mock instance every module registry resolves to.
  const appState = {
    addEventListener: vi.fn<typeof AppState.addEventListener>(() => ({
      remove: vi.fn<() => void>(),
    })),
  };

  const deepLinkLaunch = {
    clearAccountBoundPendingDeepLink: vi.fn(),
    setCurrentDeepLinkUserId: vi.fn(),
  };

  // The legacy-exchange branch of the bootstrap load. Resolves null (a failed
  // or already-done exchange: the load falls through to the main restore)
  // unless a test overrides it, so tests that never take the legacy branch
  // keep today's behavior.
  const exchange = {
    exchangeLegacyToken: vi.fn().mockResolvedValue(null),
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
    deepLinkLaunch,
    exchange,
  };
});

// Hoisted so the sign-out regression test can make cache cleanup reject
// without loading the native-bound read-cache chain.
const readCacheMock = vi.hoisted(() => ({
  clearCacheScopeForSignOut: vi.fn().mockResolvedValue(undefined),
  readCachedUserId: vi.fn().mockReturnValue(null),
}));

// Hoisted so the sign-out test can assert the offline translation cache is
// cleared without loading the native-bound encrypted-KV chain.
const toolSummaryTranslationCacheMock = vi.hoisted(() => ({
  clearToolSummaryTranslationsForSignOut: vi.fn().mockResolvedValue(undefined),
}));

// Hoisted so the sign-out test can assert the runtime's in-memory retry memory
// is dropped with the disk scope, without loading the transcript graph.
const toolSummaryTranslationRuntimeMock = vi.hoisted(() => ({
  clearToolSummaryTranslationMemory: vi.fn(),
  clearToolSummaryTranslationMemoryForSignOut: vi.fn().mockResolvedValue(undefined),
}));

// Hoisted so the FIFO and failure-matrix tests can hold remote cleanup open or
// force it to reject without loading the tRPC/notifications chain.
const logoutCleanupMock = vi.hoisted(() => ({
  runLogoutCleanup: vi.fn().mockResolvedValue(undefined),
  unregisterActivityTokensAndTombstone: vi.fn().mockResolvedValue(undefined),
}));

// Hoisted so sign-out can assert the queued consent outcome is cleared during
// teardown without loading the consent module's SecureStore/PostHog chain.
const consentMock = vi.hoisted(() => ({
  clearPendingConsentOutcome: vi.fn(),
}));

// Hoisted so the sign-out case can seed the remote MCP server store and assert
// it is cleared, without loading the native-bound store chain (secure-store-
// preference -> sonner-native -> react-native) into the node test environment.
const remoteMcpMock = vi.hoisted(() => ({
  servers: [] as string[],
  forgetRemoteMcp: vi.fn(),
  clearRemoteMcpServers: vi.fn(() => {
    remoteMcpMock.servers.length = 0;
  }),
  clearSettingsToolsEnabled: vi.fn(),
}));

// Hoisted so the sign-out suite can assert the launcher-surface clears without
// loading the last-opened store's secure-store chain or the native module.
const lastOpenedSessionMock = vi.hoisted(() => ({
  clearLastOpenedSession: vi.fn(),
}));

const nativeLauncherSurfacesMock = vi.hoisted(() => ({
  clearLauncherSurfaces: vi.fn(),
}));

// Hoisted so the unauthorized-handler tests can capture the handler the
// provider registers, across the vi.resetModules() re-imports every mount
// performs: the mock factory closes over this object, so the captured handler
// is the one the latest mount registered.
const unauthorizedMock = vi.hoisted(() => {
  let handler: (() => Promise<void> | void) | null = null;
  return {
    setTrpcUnauthorizedHandler: vi.fn((next: () => Promise<void> | void) => {
      handler = next;
      return () => {
        handler = null;
      };
    }),
    getHandler: () => handler,
  };
});

// Hoisted so the unauthorized-handler tests can assert the branch record the
// provider writes without loading the telemetry transport chain.
const signOutTelemetryMock = vi.hoisted(() => ({
  reportAuthBranch: vi.fn(),
}));

const ownerProducer = vi.hoisted(() => ({
  getMe: vi.fn<() => Promise<{ id: string }>>().mockResolvedValue({ id: 'user-a' }),
  ticket: vi.fn().mockResolvedValue({ token: 'ingest-ticket' }),
  getAuthToken: undefined as (() => Promise<string>) | undefined,
}));

vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    user: { getMe: { query: ownerProducer.getMe } },
    activeSessions: { createWebTicket: { mutate: ownerProducer.ticket } },
  },
}));
vi.mock('@/lib/user-web-connection-lifecycle', () => ({
  createNativeUserWebConnectionLifecycleHooks: () => ({}),
}));
// Capture the real provider's credential callback. The mounted connection suite uses the real SDK.
vi.mock('@kilocode/cloud-agent-sdk/user-web-connection', () => ({
  createUserWebConnection: (config: { getAuthToken: () => Promise<string> }) => {
    ownerProducer.getAuthToken = config.getAuthToken;
    return { retain: () => vi.fn(), destroy: vi.fn() };
  },
}));

async function requestOwnerTicket() {
  const request = ownerProducer.getAuthToken;
  if (!request) {
    throw new Error('committed connection producer did not mount');
  }
  const token = await request();
  return token;
}

// ---- all vi.mock calls ----

vi.mock('expo-secure-store', () => ({
  getItem: hoisted.secureStore.getItem,
  getItemAsync: hoisted.secureStore.getItemAsync,
  setItem: hoisted.secureStore.setItem,
  setItemAsync: hoisted.secureStore.setItemAsync,
  deleteItemAsync: hoisted.secureStore.deleteItemAsync,
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
}));

vi.mock('@sentry/react-native', () => ({
  setUser: hoisted.sentry.setUser,
  setTag: hoisted.sentry.setTag,
}));

vi.mock('@/lib/analytics/posthog', () => ({
  discardPostHog: hoisted.posthog.discardPostHog,
  captureEvent: hoisted.posthog.captureEvent,
  flushLastPostHogEvent: hoisted.posthog.flushLastPostHogEvent,
  LOGOUT_EVENT: 'logout',
}));

vi.mock('@/lib/appsflyer', () => ({
  resetAppsFlyerState: hoisted.appsflyer.resetAppsFlyerState,
  trackEvent: hoisted.appsflyer.trackEvent,
}));

vi.mock('@/lib/deep-link-launch', () => ({
  clearAccountBoundPendingDeepLink: hoisted.deepLinkLaunch.clearAccountBoundPendingDeepLink,
  setCurrentDeepLinkUserId: hoisted.deepLinkLaunch.setCurrentDeepLinkUserId,
}));

vi.mock('@/lib/auth/exchange-legacy-token', () => ({
  exchangeLegacyToken: hoisted.exchange.exchangeLegacyToken,
}));

vi.mock('@/lib/telemetry/controller', () => ({
  clearTelemetryDecision: hoisted.controller.clearTelemetryDecision,
}));

vi.mock('@/lib/telemetry/posthog-storage', () => ({
  purgePostHogPersistence: hoisted.posthogStorage.purgePostHogPersistence,
}));

const queryClientMock = vi.hoisted(() => ({ clear: vi.fn() }));
vi.mock('@/lib/query-client', () => ({ queryClient: queryClientMock }));

vi.mock('@/lib/persist/read-cache', () => readCacheMock);

vi.mock('@/lib/persist/tool-summary-translation-cache', () => toolSummaryTranslationCacheMock);

vi.mock(
  '@/lib/tool-summary-translation/tool-summary-translation-runtime',
  async importOriginal => ({
    ...(await importOriginal()),
    clearToolSummaryTranslationMemory:
      toolSummaryTranslationRuntimeMock.clearToolSummaryTranslationMemory,
    clearToolSummaryTranslationMemoryForSignOut:
      toolSummaryTranslationRuntimeMock.clearToolSummaryTranslationMemoryForSignOut,
  })
);

// The sign-out teardown reaches the OS search bridge through
// `session-scoped-state`. That bridge imports the root `expo` entry, which
// reads `__DEV__` at import time and does not parse under the node test
// environment; the clear is a no-op here.
vi.mock('@/lib/native-system-search', () => ({
  clearSystemSearchIndex: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/auth/logout-cleanup', () => logoutCleanupMock);

vi.mock('@/lib/consent', () => ({
  clearPendingConsentOutcome: consentMock.clearPendingConsentOutcome,
}));

vi.mock('@/lib/last-opened-session', () => lastOpenedSessionMock);

vi.mock('@/lib/native-launcher-surfaces', () => nativeLauncherSurfacesMock);

vi.mock('@/lib/auth/trpc-unauthorized', () => ({
  setTrpcUnauthorizedHandler: unauthorizedMock.setTrpcUnauthorizedHandler,
}));

vi.mock('@/lib/auth/sign-out-telemetry', () => signOutTelemetryMock);

vi.mock('@/lib/hooks/use-persisted-agent-model', () => ({
  clearAgentModelPreference: vi.fn(),
}));

vi.mock('@/lib/hooks/use-persisted-run-on-destination', () => ({
  clearRunOnDestinationPreference: vi.fn(),
}));

const {
  clearHideThinkingPreference,
  clearKeepScreenOnPreference,
  clearReasoningPreference,
  clearPrReviewFooterPreference,
  clearCondenseToolCallsPreference,
  clearCollapsedConnectCtasPreference,
} = vi.hoisted(() => ({
  clearHideThinkingPreference: vi.fn(),
  clearKeepScreenOnPreference: vi.fn(),
  clearReasoningPreference: vi.fn(),
  clearPrReviewFooterPreference: vi.fn(),
  clearCondenseToolCallsPreference: vi.fn(),
  clearCollapsedConnectCtasPreference: vi.fn(),
}));
vi.mock('@/lib/hooks/use-keep-screen-on-preference', () => ({ clearKeepScreenOnPreference }));
vi.mock('@/lib/hooks/use-live-activity-preference', () => ({
  clearLiveActivityPreference: vi.fn(),
}));

vi.mock('@/lib/hooks/use-reasoning-preference', () => ({ clearReasoningPreference }));

// Like use-trusted-hosts below: the real module pulls secure-store-preference
// -> sonner-native -> react-native (Flow `import typeof`), which crashes the
// node test environment. Mock it to keep sign-out teardown under test.
vi.mock('@/lib/hooks/use-hide-thinking-preference', () => ({ clearHideThinkingPreference }));

// These imported session-clear modules pull in native bindings that crash the
// node test environment: use-trusted-hosts -> secure-store-preference ->
// sonner-native -> react-native (Flow `import typeof`), and the cache/file
// modules -> expo-file-system / expo-clipboard / expo-crypto. Mock them the
// same way use-persisted-agent-model is, since this suite only asserts the
// teardown ordering of the modules it lists as tracked mocks.
vi.mock('@/lib/hooks/use-trusted-hosts', () => ({
  clearTrustedHosts: vi.fn(),
}));

vi.mock('@/components/agents/markdown-image-confirm', () => ({
  clearMarkdownImageConfirmMemory: vi.fn(),
}));

vi.mock('@/components/agents/tool-card-image-cache', () => ({
  clearToolCardImageCache: vi.fn(),
}));

vi.mock('@/components/agents/file-part-cache', () => ({
  clearFilePartCache: vi.fn(),
}));

vi.mock('@/lib/agent-attachments/clipboard-image', () => ({
  clearClipboardImages: vi.fn(),
}));

vi.mock('@/lib/temp-file-registry', () => ({
  reapTempFiles: vi.fn(),
}));

// The artifact mirror members of the same teardown read expo-file-system and
// the native provider bridge. This suite asserts the teardown ordering of the
// modules it tracks, and the mirror's own suite covers the wipe and its
// provider signal.
vi.mock('@/lib/artifacts/artifact-mirror', () => ({
  clearArtifactMirror: vi.fn(),
}));

vi.mock('@/lib/artifacts/artifact-mirror-sync', () => ({
  resetArtifactMirrorSyncState: vi.fn(),
}));

vi.mock('@/lib/artifacts/artifact-provider-native', () => ({
  notifyArtifactsChanged: vi.fn(),
}));

vi.mock('@/lib/hooks/use-pr-review-footer-preference', () => ({ clearPrReviewFooterPreference }));

vi.mock('@/lib/hooks/use-condense-tool-calls-preference', () => ({
  clearCondenseToolCallsPreference,
}));

// Same reason as use-condense-tool-calls-preference above: the real module
// pulls secure-store-preference -> sonner-native -> react-native.
vi.mock('@/lib/hooks/use-collapsed-connect-ctas-preference', () => ({
  clearCollapsedConnectCtasPreference,
}));

vi.mock('@/lib/last-active-instance', () => ({
  clearLastActiveInstance: vi.fn().mockResolvedValue(undefined),
}));

// The ownership module is intentionally NOT mocked here: the sign-out gate
// regression test must observe the real gate closing before any await and
// blocking a late persist from calling SecureStore.setItem.

vi.mock('@/lib/kilo-pass/use-store-kilo-pass-purchase', () => ({
  resetPurchaseErrorToastDedup: vi.fn(),
}));

vi.mock('@/lib/chat/sign-out', () => ({
  clearChatsForSignOut: vi.fn().mockResolvedValue(undefined),
  releaseChatsForAccountSwitch: vi.fn().mockResolvedValue(undefined),
}));

// The remote MCP connection and the stored servers behind it ride on the
// native-bound secure-store preference chain (sonner-native -> react-native),
// so the sign-out body's clears are stubbed here and asserted by call.
vi.mock('@/lib/chat/remote-mcp', () => ({
  forgetRemoteMcp: remoteMcpMock.forgetRemoteMcp,
}));
vi.mock('@/lib/chat/remote-mcp-store', () => ({
  clearRemoteMcpServers: remoteMcpMock.clearRemoteMcpServers,
}));
vi.mock('@/lib/chat/settings-tools-switch', () => ({
  clearSettingsToolsEnabled: remoteMcpMock.clearSettingsToolsEnabled,
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
  ORGANIZATION_PERSONAL_STORAGE_KEY: 'selected-organization-personal',
  PENDING_DEEP_LINK_KEY: 'pending-deep-link',
  PICKER_LAUNCH_CONTEXT_KEY: 'picker-launch-context',
  REFRESH_TOKEN_KEY: 'refresh-token',
  LIVE_SESSION_FILTERS_KEY: 'live-session-filters',
  SESSION_FILTERS_KEY: 'session-filters',
  TOKEN_EXPIRES_AT_KEY: 'token-expires-at',
  USER_SESSION_TITLES_KEY: 'user-session-titles',
}));

vi.mock('@/lib/config', () => ({
  API_BASE_URL: 'https://api.example.com',
  SESSION_INGEST_WS_URL: 'wss://ingest.example.com',
  // The E2E fault hook stays closed: these cases drive the failure through
  // the SecureStore mock instead.
  E2E_SECURE_STORE_FAULT_MS: 0,
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
  restoreFailed: boolean;
  retryRestore: () => void;
  signIn: (token: string, refreshToken?: string, expiresIn?: number) => Promise<void>;
  signOut: (ended?: boolean) => Promise<void>;
};

/** Build a Kilo JWT whose payload carries `kiloUserId` (same shape as
 *  `generateApiToken` in apps/web/src/lib/tokens.ts). */
function base64url(input: string): string {
  return btoa(input).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function makeToken(payload: Record<string, unknown>): string {
  return `${base64url('{"alg":"none"}')}.${base64url(JSON.stringify(payload))}.signature`;
}

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
async function mountAndGetContext(): Promise<{
  ctx: AuthContextValue;
  getCtx: () => AuthContextValue;
  unmount: () => void;
}> {
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

  // Wait for the loading effect to complete. Bootstrap can now span the
  // bounded retry backoff of a transient SecureStore failure (250/500/1000 ms),
  // so settle on `isLoading` rather than on a single tick — a healthy read
  // still finishes on the first pass.
  await settleBootstrap(() => capturedCtx);

  // oxlint-disable-next-line @typescript-eslint/no-unnecessary-condition -- safety net for test failures
  if (!capturedCtx) {
    throw new Error('auth context not captured');
  }

  const getCtx = (): AuthContextValue => {
    if (!capturedCtx) {
      throw new Error('auth context not captured');
    }
    return capturedCtx;
  };

  return {
    ctx: capturedCtx,
    getCtx,
    unmount: () => {
      renderer?.unmount();
    },
  };
}

/** Flush act passes on real timers until bootstrap stops loading, bounded so a
 *  stuck provider fails as a timeout rather than hanging the suite.
 *
 *  The budget is a count of act passes, not wall-clock milliseconds: the gate
 *  runs this file beside ~170 others and the device stack, so each 20 ms pass
 *  can stretch several-fold while the bootstrap's own backoff timers stretch
 *  with it. Counting passes keeps the two in step — a wall-clock deadline
 *  would expire early on exactly the loaded machine this guards against.
 *  1250 passes is far more than the ~90 the 1.75 s backoff needs, so a
 *  healthy bootstrap still returns on its first pass. The whole file carries a
 *  30 s per-test timeout (see the `vi.setConfig` at the top), above this. */
async function settleBootstrap(
  read: () => AuthContextValue | undefined,
  budgetPasses = 1250
): Promise<void> {
  for (let pass = 0; pass < budgetPasses; pass += 1) {
    // eslint-disable-next-line no-await-in-loop -- polling must flush and re-check sequentially between act cycles
    await act(async () => {
      await new Promise<void>(resolve => {
        void setTimeout(resolve, 20);
      });
    });
    if (read()?.isLoading === false) {
      return;
    }
  }
  throw new Error('bootstrap never settled');
}

// ---- tests ----

function invocationOrder(mock: { mock: { invocationCallOrder: number[] } }, index = 0): number {
  const order = mock.mock.invocationCallOrder[index];
  if (order === undefined) {
    throw new Error('Expected a recorded mock invocation');
  }
  return order;
}

describe('sign-out teardown ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.callOrder.length = 0;
    hoisted.secureStore.getItemAsync.mockResolvedValue(null);
  });

  it('orders capture, cleanup, flush, clearTelemetryDecision, then Sentry.setUser', async () => {
    const { ctx, unmount } = await mountAndGetContext();

    await act(async () => {
      await ctx.signOut();
    });

    // clearTelemetryDecision must be called
    expect(hoisted.controller.clearTelemetryDecision).toHaveBeenCalled();
    // Sentry.setUser must be called
    expect(hoisted.sentry.setUser).toHaveBeenCalledWith(null);

    const capture = invocationOrder(hoisted.posthog.captureEvent);
    const cleanup = invocationOrder(logoutCleanupMock.runLogoutCleanup);
    const flush = invocationOrder(hoisted.posthog.flushLastPostHogEvent);
    const clear = invocationOrder(hoisted.controller.clearTelemetryDecision);
    const sentry = invocationOrder(hoisted.sentry.setUser);

    expect(capture).toBeLessThan(cleanup);
    expect(cleanup).toBeLessThan(flush);
    expect(flush).toBeLessThan(clear);
    expect(clear).toBeLessThan(sentry);

    unmount();
  });

  it('clears a queued consent outcome during sign-out before discarding PostHog', async () => {
    const { ctx, unmount } = await mountAndGetContext();

    await act(async () => {
      await ctx.signOut();
    });

    expect(consentMock.clearPendingConsentOutcome).toHaveBeenCalledTimes(1);

    const clearConsent = invocationOrder(consentMock.clearPendingConsentOutcome);
    const discard = invocationOrder(hoisted.posthog.discardPostHog);
    expect(clearConsent).toBeLessThan(discard);

    unmount();
  });

  it('captures logout, then flushes, then discards PostHog', async () => {
    const { ctx, unmount } = await mountAndGetContext();

    await act(async () => {
      await ctx.signOut();
    });

    expect(hoisted.posthog.captureEvent).toHaveBeenCalledWith('logout');
    expect(hoisted.posthog.flushLastPostHogEvent).toHaveBeenCalledTimes(1);

    const capture = invocationOrder(hoisted.posthog.captureEvent);
    const flush = invocationOrder(hoisted.posthog.flushLastPostHogEvent);
    const discard = invocationOrder(hoisted.posthog.discardPostHog);
    expect(capture).toBeLessThan(flush);
    expect(flush).toBeLessThan(discard);

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
    // The first 7 calls must be in this exact order (logout capture and flush
    // precede the teardown steps; remote cleanup is awaited between them but
    // pushes no callOrder entry).
    const expectedPreamble = hoisted.callOrder.slice(0, 7);
    expect(expectedPreamble).toEqual([
      'captureEvent',
      'flushLastPostHogEvent',
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
    const secureStoreOrder = invocationOrder(hoisted.secureStore.deleteItemAsync);
    expect(secureStoreOrder).toBeDefined();
    for (const order of sdkInvocationOrders) {
      expect(order).toBeLessThan(secureStoreOrder);
    }

    unmount();
  });

  it('tears down per-user SecureStore keys', async () => {
    const { ctx, unmount } = await mountAndGetContext();

    await act(async () => {
      await ctx.signOut();
    });

    expect(hoisted.secureStore.deleteItemAsync).toHaveBeenCalledWith(
      'auth-token',
      expect.anything()
    );
    expect(hoisted.secureStore.deleteItemAsync).toHaveBeenCalledWith('organization');
    // The Personal-choice marker is account-scoped selection state too: if it
    // outlived the account, the next account on this device would inherit the
    // signed-out account's explicit Personal choice and skip its own default.
    expect(hoisted.secureStore.deleteItemAsync).toHaveBeenCalledWith(
      ORGANIZATION_PERSONAL_STORAGE_KEY
    );
    expect(hoisted.secureStore.deleteItemAsync).toHaveBeenCalledWith('session-filters');
    expect(hoisted.secureStore.deleteItemAsync).toHaveBeenCalledWith('live-session-filters');
    expect(hoisted.secureStore.deleteItemAsync).toHaveBeenCalledWith('notification-prompt-seen');
    expect(hoisted.secureStore.deleteItemAsync).toHaveBeenCalledWith('pending-deep-link');
    expect(hoisted.deepLinkLaunch.clearAccountBoundPendingDeepLink).toHaveBeenCalled();

    unmount();
  });

  it('clears the pending deep-link user id on sign-out', async () => {
    const { ctx, unmount } = await mountAndGetContext();

    await act(async () => {
      await ctx.signOut();
    });

    expect(hoisted.deepLinkLaunch.setCurrentDeepLinkUserId).toHaveBeenCalledWith(null);

    unmount();
  });

  it('binds the pending deep-link user id on sign-in from the token', async () => {
    const { ctx, unmount } = await mountAndGetContext();

    await act(async () => {
      await ctx.signIn(makeToken({ kiloUserId: 'user-1' }));
    });

    expect(hoisted.deepLinkLaunch.setCurrentDeepLinkUserId).toHaveBeenCalledWith('user-1');

    unmount();
  });

  it('unregisters the prior account activity tokens on sign-in (account switch)', async () => {
    const { ctx, unmount } = await mountAndGetContext();

    await act(async () => {
      await ctx.signIn(makeToken({ kiloUserId: 'user-2' }));
    });

    // The switch unregisters the prior scope's activity tokens (tombstone on
    // failure) without revoking the device session — runLogoutCleanup must not
    // run on a plain sign-in.
    expect(logoutCleanupMock.unregisterActivityTokensAndTombstone).toHaveBeenCalledTimes(1);
    expect(logoutCleanupMock.runLogoutCleanup).not.toHaveBeenCalled();

    unmount();
  });

  it('ends the prior account chats on sign-in, and signs in even when that fails', async () => {
    const { ctx, unmount } = await mountAndGetContext();
    const { releaseChatsForAccountSwitch } = await import('@/lib/chat/sign-out');
    const release = vi.mocked(releaseChatsForAccountSwitch);
    release.mockRejectedValueOnce(new Error('the store is locked'));

    await act(async () => {
      await ctx.signIn(makeToken({ kiloUserId: 'user-2' }));
    });

    expect(release).toHaveBeenCalledTimes(1);
    // The rest of the switch ran: a chat that would not close cannot stop the
    // prior account's cache being cleared.
    expect(queryClientMock.clear).toHaveBeenCalled();

    unmount();
  });

  it('clears the prior account Personal-choice marker on sign-in (account switch)', async () => {
    const { ctx, unmount } = await mountAndGetContext();

    await act(async () => {
      await ctx.signIn(makeToken({ kiloUserId: 'user-2' }));
    });

    // A direct account switch must resolve the new account's own organization
    // default; the prior account's explicit Personal choice must not leak.
    expect(hoisted.secureStore.deleteItemAsync).toHaveBeenCalledWith(
      ORGANIZATION_PERSONAL_STORAGE_KEY
    );

    unmount();
  });

  it('clears the session-scoped state on sign-in (account switch)', async () => {
    const { ctx, unmount } = await mountAndGetContext();
    const trustedHosts = await import('@/lib/hooks/use-trusted-hosts');
    const imageConfirm = await import('@/components/agents/markdown-image-confirm');
    const { getSessionAutoApproveEnabled, setSessionAutoApproveEnabled } =
      await import('@/components/agents/session-auto-approve');
    setSessionAutoApproveEnabled('switch-session-a', true);

    await act(async () => {
      await ctx.signIn(makeToken({ kiloUserId: 'user-2' }));
    });

    expect(trustedHosts.clearTrustedHosts).toHaveBeenCalled();
    expect(imageConfirm.clearMarkdownImageConfirmMemory).toHaveBeenCalled();
    // A per-session auto-approve flag must not survive the account boundary.
    expect(getSessionAutoApproveEnabled('switch-session-a')).toBe(false);

    unmount();
  });

  it('clears the local preferences on sign-out', async () => {
    const { ctx } = await mountAndGetContext();

    await act(async () => {
      await ctx.signOut();
    });

    expect(clearKeepScreenOnPreference).toHaveBeenCalled();
    expect(clearReasoningPreference).toHaveBeenCalled();
    expect(clearHideThinkingPreference).toHaveBeenCalled();
    expect(clearPrReviewFooterPreference).toHaveBeenCalled();
    expect(clearCondenseToolCallsPreference).toHaveBeenCalled();
    expect(clearCollapsedConnectCtasPreference).toHaveBeenCalled();
    const { clearRunOnDestinationPreference } =
      await import('@/lib/hooks/use-persisted-run-on-destination');
    expect(clearRunOnDestinationPreference).toHaveBeenCalled();
  });

  it('clears the remote MCP connection, its stored servers and the group switch on sign-out', async () => {
    const { ctx, unmount } = await mountAndGetContext();
    // The account added a remote server before signing out.
    remoteMcpMock.servers.push('alpha');

    await act(async () => {
      await ctx.signOut();
    });

    expect(remoteMcpMock.forgetRemoteMcp).toHaveBeenCalled();
    expect(remoteMcpMock.clearRemoteMcpServers).toHaveBeenCalled();
    expect(remoteMcpMock.clearSettingsToolsEnabled).toHaveBeenCalled();
    expect(remoteMcpMock.servers).toEqual([]);

    unmount();
  });

  it('clears the last-opened session and the launcher surfaces on sign-out', async () => {
    const { ctx } = await mountAndGetContext();

    await act(async () => {
      await ctx.signOut();
    });

    // The dynamic shortcuts/tile are dropped natively and the durable record is
    // deleted locally, so the next account never sees the previous session.
    expect(nativeLauncherSurfacesMock.clearLauncherSurfaces).toHaveBeenCalledTimes(1);
    expect(lastOpenedSessionMock.clearLastOpenedSession).toHaveBeenCalledTimes(1);
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
    const { promise: inFlightGate, resolve: releaseInFlight } = Promise.withResolvers<undefined>();
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
    releaseInFlight(undefined);
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
    expect(deleteOrder).toBeGreaterThan(invocationOrder(secureStore.setItemAsync));

    unmount();
  });

  it("takes the account's chats off the device, and survives a wipe that fails", async () => {
    const { ctx, unmount } = await mountAndGetContext();
    const { clearChatsForSignOut } = await import('@/lib/chat/sign-out');
    const wipe = vi.mocked(clearChatsForSignOut);
    wipe.mockRejectedValueOnce(new Error('database locked'));

    await act(async () => {
      await ctx.signOut();
    });

    expect(wipe).toHaveBeenCalledWith(null);
    expect(hoisted.secureStore.deleteItemAsync).toHaveBeenCalledWith('active-user-id');

    unmount();
  });

  it('regression: a cache cleanup failure does not abort sign-out query or auth state reset', async () => {
    const { ctx, unmount } = await mountAndGetContext();
    const clearMock = vi.mocked(queryClientMock.clear);

    // The encrypted-kv clear rejects (storage failure): logout must still
    // attempt the cleanup before the query client clear, and the rejection
    // must not stop the clear, the credential deletes, or the state reset.
    readCacheMock.clearCacheScopeForSignOut.mockRejectedValueOnce(new Error('kv down'));

    await act(async () => {
      await ctx.signOut();
    });

    expect(readCacheMock.clearCacheScopeForSignOut).toHaveBeenCalledWith(null);
    const cleanupOrder = invocationOrder(readCacheMock.clearCacheScopeForSignOut);
    const clearOrder = invocationOrder(clearMock);
    expect(cleanupOrder).toBeLessThan(clearOrder);
    expect(clearMock).toHaveBeenCalledTimes(1);
    expect(hoisted.secureStore.deleteItemAsync).toHaveBeenCalledWith('active-user-id');

    unmount();
  });

  it('still clears disk translations when the sign-out memory reset rejects', async () => {
    const { ctx, unmount } = await mountAndGetContext();
    onTestFinished(() => act(unmount));
    toolSummaryTranslationRuntimeMock.clearToolSummaryTranslationMemoryForSignOut.mockRejectedValueOnce(
      new Error('reset subscriber failed')
    );

    await act(async () => {
      await ctx.signOut();
    });

    expect(
      toolSummaryTranslationCacheMock.clearToolSummaryTranslationsForSignOut
    ).toHaveBeenCalledTimes(1);
    expect(queryClientMock.clear).toHaveBeenCalledTimes(1);
  });

  it('clears the offline translation cache exactly once, only after the runtime reset settles', async () => {
    const { ctx, unmount } = await mountAndGetContext();
    const clearMock = vi.mocked(queryClientMock.clear);

    // The runtime reset (generation bump + drain of the writes already
    // dispatched) is asynchronous. Hold it open: an invocation-order assertion
    // alone cannot see a dropped `await`, because both mocks are invoked
    // synchronously in that order either way.
    const gate = Promise.withResolvers<undefined>();
    toolSummaryTranslationRuntimeMock.clearToolSummaryTranslationMemoryForSignOut.mockReturnValueOnce(
      gate.promise
    );

    const signOutPromise = ctx.signOut();
    await vi.waitFor(() => {
      expect(
        toolSummaryTranslationRuntimeMock.clearToolSummaryTranslationMemoryForSignOut
      ).toHaveBeenCalledTimes(1);
    });

    // The disk scope still holds the signed-out account's tool text, so the
    // clear must not run while the reset that settles its dispatched writes is
    // in flight: a persist that settled afterwards would outlive the scope.
    expect(
      toolSummaryTranslationCacheMock.clearToolSummaryTranslationsForSignOut
    ).not.toHaveBeenCalled();

    gate.resolve(undefined);
    await act(async () => {
      await signOutPromise;
    });

    // The offline translation cache holds the signed-out account's tool text,
    // so sign-out drops it exactly once, as part of the same local cleanup
    // batch, before the query client is cleared.
    expect(
      toolSummaryTranslationCacheMock.clearToolSummaryTranslationsForSignOut
    ).toHaveBeenCalledTimes(1);
    // The runtime's in-memory retry memory and cache hold the same tool text:
    // without this reset the next account's retry re-sends it to the gateway.
    // It resolves only once the writes already dispatched have settled, so the
    // disk scope clear can never race one of them.
    expect(
      toolSummaryTranslationRuntimeMock.clearToolSummaryTranslationMemoryForSignOut
    ).toHaveBeenCalledTimes(1);
    const runtimeResetOrder = invocationOrder(
      toolSummaryTranslationRuntimeMock.clearToolSummaryTranslationMemoryForSignOut
    );
    const translationClearOrder = invocationOrder(
      toolSummaryTranslationCacheMock.clearToolSummaryTranslationsForSignOut
    );
    // The runtime reset (generation bump + dispatched-write drain) resolves
    // before the disk scope is cleared, so no fire-and-forget persist can land
    // after the scope is gone.
    expect(runtimeResetOrder).toBeLessThan(translationClearOrder);
    const clearOrder = invocationOrder(clearMock);
    expect(translationClearOrder).toBeLessThan(clearOrder);

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
    // The account-switch path in signIn clears once, and the sign-out teardown
    // clears a second time.
    expect(vi.mocked(queryClientMock.clear)).toHaveBeenCalledTimes(2);

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
    mod: typeof AuthContextModule;
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
    const { promise: readGate, resolve: releaseRead } = Promise.withResolvers<undefined>();
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

    releaseRead(undefined);
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

  it('regression: a bootstrap success landing mid-sign-out-teardown never republishes the torn-down credentials', async () => {
    const { promise: readGate, resolve: releaseRead } = Promise.withResolvers<undefined>();
    const storedToken = makeToken({ kiloUserId: 'user-1' });
    // Mock queue consumed by the bootstrap load: preloadedToken,
    // preloadedRefreshToken, then the expiry read (held), then the
    // credential re-read (unchanged, so only a fence can stop the publish).
    hoisted.secureStore.getItemAsync
      .mockResolvedValueOnce(storedToken)
      .mockResolvedValueOnce('stored-refresh')
      .mockImplementationOnce(async () => {
        // Bootstrap expiry read: hold open so a sign-out can land mid-read.
        await readGate;
        return '9999999999999';
      })
      .mockResolvedValueOnce(storedToken);

    const { getCtx, unmount } = await mountProvider();

    // Hold the sign-out's remote cleanup open: the teardown is mid-flight and
    // its epoch bump (which waits for the cleanup) has not happened when the
    // bootstrap read resolves — the epoch fence alone cannot stop the publish.
    const { promise: cleanupGate, resolve: releaseCleanup } = Promise.withResolvers<undefined>();
    logoutCleanupMock.runLogoutCleanup.mockImplementationOnce(async () => {
      await cleanupGate;
    });

    const signOutPromise = getCtx().signOut(true);
    await vi.waitFor(() => {
      expect(logoutCleanupMock.runLogoutCleanup).toHaveBeenCalled();
    });

    // Release the bootstrap read while the teardown is still in flight.
    releaseRead(undefined);
    await act(async () => {
      await new Promise<void>(resolve => {
        void setTimeout(resolve, 0);
      });
    });

    // The success path must not republish what sign-out is tearing down: no
    // owner token, no React token, no deep-link binding for the old account.
    const tokenOwner = await import('@/lib/auth/token-owner');
    expect(tokenOwner.getActiveToken()).toBeNull();
    expect(getCtx().token).toBeUndefined();
    expect(hoisted.deepLinkLaunch.setCurrentDeepLinkUserId).not.toHaveBeenCalledWith('user-1');

    // The teardown then finishes into the signed-out end state.
    releaseCleanup(undefined);
    await act(async () => {
      await signOutPromise;
    });
    expect(getCtx().token).toBeUndefined();
    expect(getCtx().sessionEnded).toBe(true);

    unmount();
  });

  it('regression: a legacy-exchange success landing mid-sign-out-teardown never republishes credentials', async () => {
    const { promise: exchangeGate, resolve: releaseExchange } = Promise.withResolvers<undefined>();
    const storedToken = makeToken({ kiloUserId: 'user-1' });
    // No stored refresh token: bootstrap takes the legacy-exchange branch.
    // Mock queue consumed by the bootstrap load: preloadedToken,
    // preloadedRefreshToken (null), then — after the fenced exchange publish
    // is refused and the main restore path continues — the expiry read and
    // the credential re-read.
    hoisted.secureStore.getItemAsync
      .mockResolvedValueOnce(storedToken)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('9999999999999')
      .mockResolvedValueOnce(storedToken);
    hoisted.exchange.exchangeLegacyToken.mockImplementationOnce(async () => {
      await exchangeGate;
      return { token: 'exchanged-token', refreshToken: 'exchanged-refresh', expiresIn: 3600 };
    });

    const { getCtx, unmount } = await mountProvider();

    // Hold the sign-out's remote cleanup open so the teardown is mid-flight
    // (epoch not yet bumped) when the exchange resolves: the exchange's own
    // epoch checks pass inside that window.
    const { promise: cleanupGate, resolve: releaseCleanup } = Promise.withResolvers<undefined>();
    logoutCleanupMock.runLogoutCleanup.mockImplementationOnce(async () => {
      await cleanupGate;
    });

    const signOutPromise = getCtx().signOut(true);
    await vi.waitFor(() => {
      expect(logoutCleanupMock.runLogoutCleanup).toHaveBeenCalled();
    });

    // Release the exchange while the teardown is still in flight.
    releaseExchange(undefined);
    await act(async () => {
      await new Promise<void>(resolve => {
        void setTimeout(resolve, 0);
      });
    });

    // The fenced exchange must not publish the exchanged pair mid-teardown:
    // no React token and no deep-link binding for the account being signed out.
    expect(getCtx().token).toBeUndefined();
    expect(hoisted.deepLinkLaunch.setCurrentDeepLinkUserId).not.toHaveBeenCalledWith('user-1');

    // The teardown then finishes into the signed-out end state.
    releaseCleanup(undefined);
    await act(async () => {
      await signOutPromise;
    });
    const tokenOwner = await import('@/lib/auth/token-owner');
    expect(tokenOwner.getActiveToken()).toBeNull();
    expect(getCtx().token).toBeUndefined();
    expect(getCtx().sessionEnded).toBe(true);
    unmount();
  });

  it('regression: bootstrap publishes the refreshed token when credentials change during the load', async () => {
    const { promise: readGate, resolve: releaseRead } = Promise.withResolvers<undefined>();
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

    releaseRead(undefined);
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
    const { promise: readGate, resolve: releaseRead } = Promise.withResolvers<undefined>();
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

    releaseRead(undefined);
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

  it('binds the deep-link user id from the restored session during bootstrap', async () => {
    const storedToken = makeToken({ kiloUserId: 'user-1' });
    // Mock queue consumed by the bootstrap load: preloadedToken,
    // preloadedRefreshToken, the bootstrap expiry read, then the bootstrap
    // credential re-read (unchanged, so the main restore publishes the token).
    hoisted.secureStore.getItemAsync
      .mockResolvedValueOnce(storedToken)
      .mockResolvedValueOnce('stored-refresh')
      .mockResolvedValueOnce('9999999999999')
      .mockResolvedValueOnce(storedToken);

    const { getCtx, unmount } = await mountProvider();

    // The restored session owns the user id: a destination captured while this
    // account is signed in drops on sign-out because the pending slot's
    // stash-time user id is non-null.
    expect(getCtx().token).toBe(storedToken);
    expect(hoisted.deepLinkLaunch.setCurrentDeepLinkUserId).toHaveBeenCalledWith('user-1');

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
    const { promise: readGate, resolve: releaseRead } = Promise.withResolvers<undefined>();
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

    releaseRead(undefined);
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

  it('regression: a refused refresh from a superseded epoch does not sign out the newer session', async () => {
    const { getCtx, unmount } = await mountProvider();

    // A session with a refresh token and an expiry inside the refresh margin,
    // so a foreground event initiates a proactive refresh.
    await act(async () => {
      await getCtx().signIn('active-token', 'active-refresh', 3600);
    });

    const listeners = hoisted.appState.addEventListener.mock.calls;
    const eventListener = listeners.at(-1)?.[1];

    // Serve the foreground's expiry read and the refresh's refresh-token read.
    // eslint-disable-next-line require-await -- mock returning a resolved promise
    hoisted.secureStore.getItemAsync.mockImplementation(async (key: string) => {
      if (key === 'token-expires-at') {
        return String(Date.now() + 60_000);
      }
      if (key === 'refresh-token') {
        return 'active-refresh';
      }
      return null;
    });

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ error: 'INVALID_REFRESH_TOKEN' }, { status: 401 }));

    // Hold the terminal clear open so the epoch can move inside it: this is the
    // window where the refresh still returns refused for the session that
    // owned it.
    const { promise: clearGate, resolve: releaseClear } = Promise.withResolvers<undefined>();
    hoisted.secureStore.deleteItemAsync.mockImplementationOnce(async () => {
      await clearGate;
    });

    await act(async () => {
      eventListener?.('active');
      await Promise.resolve();
    });

    // Wait until the clear is in flight, then move the epoch: a newer session
    // now owns the tree while the old refresh is still inside its clear.
    const authEpoch = await import('@/lib/auth/auth-epoch');
    let flushes = 0;
    while (hoisted.secureStore.deleteItemAsync.mock.calls.length === 0 && flushes < 50) {
      flushes += 1;
      // eslint-disable-next-line no-await-in-loop -- sequential flush until the clear is in flight
      await act(async () => {
        await new Promise<void>(resolve => {
          void setTimeout(resolve, 0);
        });
      });
    }
    expect(hoisted.secureStore.deleteItemAsync).toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalled();

    authEpoch.bumpAuthEpoch();
    releaseClear(undefined);

    await act(async () => {
      await new Promise<void>(resolve => {
        void setTimeout(resolve, 0);
      });
    });

    // The stale refusal must not tear down the newer session.
    expect(getCtx().sessionEnded).toBe(false);
    expect(getCtx().token).toBe('active-token');

    fetchSpy.mockRestore();
    unmount();
  });

  it('regression: the refusal-triggered sign-out cleanup still authenticates with the owner token', async () => {
    const { getCtx, unmount } = await mountProvider();

    // A session with a refresh token and an expiry inside the refresh margin,
    // so a foreground event initiates a proactive refresh.
    await act(async () => {
      await getCtx().signIn('active-token', 'active-refresh', 3600);
    });

    const listeners = hoisted.appState.addEventListener.mock.calls;
    const eventListener = listeners.at(-1)?.[1];

    // Serve the foreground's expiry read and the refresh's refresh-token read.
    // eslint-disable-next-line require-await -- mock returning a resolved promise
    hoisted.secureStore.getItemAsync.mockImplementation(async (key: string) => {
      if (key === 'token-expires-at') {
        return String(Date.now() + 60_000);
      }
      if (key === 'refresh-token') {
        return 'active-refresh';
      }
      return null;
    });

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ error: 'INVALID_REFRESH_TOKEN' }, { status: 401 }));

    // The 401 clear runs before the refusal-triggered sign-out. The owner must
    // still serve the token to runLogoutCleanup's revoke/unregister, which run
    // before the epoch bump and read the Authorization header through
    // `getAuthTokenForRequest`.
    const tokens: typeof TokenOwnerModule = await import('./token-owner');
    let cleanupToken: string | null | 'unset' = 'unset';
    logoutCleanupMock.runLogoutCleanup.mockImplementationOnce(async () => {
      cleanupToken = await tokens.getAuthTokenForRequest();
    });

    await act(async () => {
      eventListener?.('active');
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(logoutCleanupMock.runLogoutCleanup).toHaveBeenCalled();
    });
    await act(async () => {
      await new Promise<void>(resolve => {
        void setTimeout(resolve, 0);
      });
    });

    // The remote cleanup authenticated with the session's own access token.
    expect(cleanupToken).toBe('active-token');

    fetchSpy.mockRestore();
    unmount();
  });

  it('regression: a signed-out launch re-runs the OS search clear the teardown cannot await', async () => {
    // The beforeEach leaves every read null: the launch positively restored no
    // session, which is the retry for a teardown-time clear that failed or a
    // process killed before it landed. No sign-out runs here, so the launch
    // re-clear is the only call.
    const { getCtx, unmount } = await mountProvider();
    expect(getCtx().isLoading).toBe(false);
    expect(getCtx().token).toBeUndefined();
    expect(getCtx().restoreFailed).toBe(false);

    const search = await import('@/lib/native-system-search');
    expect(vi.mocked(search.clearSystemSearchIndex)).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('a restore-failure bootstrap never wipes the search index', async () => {
    // Every credential read rejects: the session is not known to be gone, so
    // the account may still own the index and only a positively signed-out
    // launch may clear it.
    hoisted.secureStore.getItemAsync.mockRejectedValue(new Error('keychain unavailable'));

    const { getCtx, unmount } = await mountProvider();
    await settleBootstrap(getCtx);
    expect(getCtx().restoreFailed).toBe(true);

    const search = await import('@/lib/native-system-search');
    expect(vi.mocked(search.clearSystemSearchIndex)).not.toHaveBeenCalled();

    unmount();
  }, 60_000);

  it('repro: an unreadable refresh-token read shows the restore error instead of signing out', async () => {
    const storedToken = makeToken({ kiloUserId: 'user-1' });
    // Bootstrap consumes: preloadedToken, preloadedRefreshToken, the expiry
    // read, then the credential re-read — all healthy, so the session restores.
    hoisted.secureStore.getItemAsync
      .mockResolvedValueOnce(storedToken)
      .mockResolvedValueOnce('stored-refresh')
      .mockResolvedValueOnce('9999999999999')
      .mockResolvedValueOnce(storedToken);

    const { getCtx, unmount } = await mountProvider();
    expect(getCtx().token).toBe(storedToken);
    expect(getCtx().sessionEnded).toBe(false);

    // Every refresh-token read — including `readStoredValueRetryingNull`'s
    // retries — answers null while the stored token stays present.
    hoisted.secureStore.getItemAsync.mockResolvedValue(null);

    const handler = unauthorizedMock.getHandler();
    if (!handler) {
      throw new Error('unauthorized handler was not registered');
    }
    await act(async () => {
      await handler();
    });

    // The credential set is one unit: an unreadable refresh token is not a
    // signed-out session, so the session stands and the retryable restore error
    // takes over instead of the login screen. No teardown ran.
    expect(getCtx().token).toBe(storedToken);
    expect(getCtx().sessionEnded).toBe(false);
    expect(getCtx().restoreFailed).toBe(true);
    expect(logoutCleanupMock.runLogoutCleanup).not.toHaveBeenCalled();
    expect(hoisted.posthog.captureEvent).not.toHaveBeenCalledWith('logout');
    expect(signOutTelemetryMock.reportAuthBranch).toHaveBeenCalledTimes(1);
    expect(signOutTelemetryMock.reportAuthBranch).toHaveBeenCalledWith({
      cause: 'credentials_unreadable',
      branch: 'refresh_token_unreadable',
      keyNames: ['auth-token'],
    });

    unmount();
  }, 30_000);

  it('regression: an unreadable read with an empty credential set raises no restore error and no sign-out', async () => {
    // The launch positively restored no session: every read answers null, so
    // bootstrap left the person on the login route with no error surface.
    const { getCtx, unmount } = await mountProvider();
    expect(getCtx().isLoading).toBe(false);
    expect(getCtx().token).toBeUndefined();
    expect(getCtx().restoreFailed).toBe(false);

    // The request settles with zero credential members present: no stored
    // token, no expiry, no active token. An empty set is genuinely no session,
    // not a failed read of one member.
    hoisted.secureStore.getItemAsync.mockResolvedValue(null);

    const handler = unauthorizedMock.getHandler();
    if (!handler) {
      throw new Error('unauthorized handler was not registered');
    }
    await act(async () => {
      await handler();
    });

    // No false restore error over the correct login destination, and no
    // teardown: the 401 belongs to no session.
    expect(getCtx().restoreFailed).toBe(false);
    expect(getCtx().sessionEnded).toBe(false);
    expect(getCtx().token).toBeUndefined();
    expect(signOutTelemetryMock.reportAuthBranch).not.toHaveBeenCalled();
    expect(logoutCleanupMock.runLogoutCleanup).not.toHaveBeenCalled();
    expect(hoisted.posthog.captureEvent).not.toHaveBeenCalledWith('logout');

    unmount();
  }, 30_000);

  it('a server-refused refresh signs out with the session-ended cause', async () => {
    const storedToken = makeToken({ kiloUserId: 'user-1' });
    // Bootstrap consumes: preloadedToken, preloadedRefreshToken, the expiry
    // read, then the credential re-read — all healthy, so the session restores.
    hoisted.secureStore.getItemAsync
      .mockResolvedValueOnce(storedToken)
      .mockResolvedValueOnce('stored-refresh')
      .mockResolvedValueOnce('9999999999999')
      .mockResolvedValueOnce(storedToken);

    const { getCtx, unmount } = await mountProvider();
    expect(getCtx().token).toBe(storedToken);

    // The refresh token is present and the server refuses it with a 401: a
    // genuine revocation, which must stay a sign-out.
    hoisted.secureStore.getItemAsync.mockResolvedValue('stored-refresh');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 401 }));
    onTestFinished(() => {
      fetchSpy.mockRestore();
    });

    const handler = unauthorizedMock.getHandler();
    if (!handler) {
      throw new Error('unauthorized handler was not registered');
    }
    await act(async () => {
      await handler();
    });

    // A real 401 still signs out, is announced as a session end, and records
    // the refresh_401 branch.
    expect(getCtx().sessionEnded).toBe(true);
    expect(getCtx().token).toBeUndefined();
    expect(getCtx().restoreFailed).toBe(false);
    expect(signOutTelemetryMock.reportAuthBranch).toHaveBeenCalledTimes(1);
    expect(signOutTelemetryMock.reportAuthBranch).toHaveBeenCalledWith({
      cause: 'session_ended',
      branch: 'refresh_401',
    });

    unmount();
  }, 30_000);
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
  async function mountEpochTest(withConnection = false): Promise<{
    getCtx: () => AuthContextValue;
    unmount: () => void;
  }> {
    vi.resetModules();
    ownerProducer.getAuthToken = undefined;
    ownerProducer.getMe.mockReset().mockResolvedValue({ id: 'user-a' });
    const mod = await import('./auth-context');
    const connectionModule = withConnection
      ? await import('../../components/agents/user-web-connection-provider')
      : null;
    const ConnectionProvider = connectionModule?.UserWebConnectionProvider;

    let capturedCtx: AuthContextValue | undefined = undefined;
    function Consumer(): null {
      capturedCtx = mod.useAuth();
      return null;
    }

    let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
    await act(async () => {
      const consumer = createElement(Consumer);
      renderer = TestRenderer.create(
        createElement(
          mod.AuthProvider,
          null,
          consumer,
          ConnectionProvider ? createElement(ConnectionProvider, null, null) : null
        )
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

  it('publishes pending ownership before credential writes and confirms only the committed successor', async () => {
    const { getCtx, unmount } = await mountEpochTest(true);
    onTestFinished(() => act(unmount));
    const scope: typeof ContextScopeModule = await import('../context-scope');
    const tokens: typeof TokenOwnerModule = await import('./token-owner');
    await act(async () => {
      await getCtx().signIn('account-a-token');
    });
    await act(async () => {
      await requestOwnerTicket();
    });
    const previous = scope.getAuthenticatedOwner();
    expect(previous.userId).toBe('user-a');
    // Establish the restored state a cold start sets, so the assertion after the
    // switch proves `signIn` clears a previously-restored flag instead of
    // starting from the `false` a never-restored bootstrap already holds.
    act(() => {
      scope.markRestoredAuthenticatedOwner();
    });
    expect(scope.getAuthenticatedOwner().restored).toBe(true);
    // The old credentials remain readable on disk while the replacement write is held.
    hoisted.secureStore.getItemAsync.mockResolvedValue('account-a-token');

    const published: { userId: string | null; token: string | null }[] = [];
    const unsubscribe = scope.subscribeAuthenticatedOwner(() => {
      published.push({
        userId: scope.getAuthenticatedOwner().userId,
        token: tokens.getActiveToken()?.token ?? null,
      });
    });
    onTestFinished(unsubscribe);
    const write = Promise.withResolvers<undefined>();
    onTestFinished(() => {
      write.resolve(undefined);
    });
    hoisted.secureStore.setItemAsync.mockImplementationOnce(async () => {
      await write.promise;
    });
    const transition: { promise?: Promise<void> } = {};
    await act(async () => {
      transition.promise = getCtx().signIn('account-b-token');
      await Promise.resolve();
    });

    expect(published).toEqual([{ userId: null, token: null }]);
    expect(scope.isAuthenticatedOwner(previous)).toBe(false);
    expect(getCtx().token).toBeUndefined();
    expect(getCtx().isSigningOut).toBe(true);
    await expect(tokens.getAuthTokenForRequest()).resolves.toBeNull();
    await expect(requestOwnerTicket()).rejects.toThrow('Authenticated owner changed');

    await act(async () => {
      write.resolve(undefined);
      await transition.promise;
    });
    expect(scope.getAuthenticatedOwner().userId).toBeNull();
    // A fresh sign-in is not a restore: the previous account's persisted hint
    // must not scope local data while these credentials are unconfirmed.
    expect(scope.getAuthenticatedOwner().restored).toBe(false);
    const requestedTokens: (string | undefined)[] = [];
    ownerProducer.getMe.mockImplementationOnce(async () => {
      requestedTokens.push(tokens.getActiveToken()?.token);
      await Promise.resolve();
      return { id: 'user-b' };
    });
    await act(async () => {
      await requestOwnerTicket();
    });

    expect(requestedTokens).toEqual(['account-b-token']);
    expect(scope.getAuthenticatedOwner().userId).toBe('user-b');
    expect(scope.getAuthenticatedOwner().generation).toBeGreaterThan(previous.generation);
    expect(getCtx().token).toBe('account-b-token');
    expect(getCtx().isSigningOut).toBe(false);
  });

  it('removes the previous identity hint before new credentials can survive a restart', async () => {
    const { getCtx, unmount } = await mountEpochTest();
    onTestFinished(() => act(unmount));
    const metadata = await import('./account-metadata-write');
    const disk = new Map([['active-user-id', 'user-a']]);
    const oldWrite = Promise.withResolvers<undefined>();
    const previousSet = hoisted.secureStore.setItemAsync.getMockImplementation();
    const previousDelete = hoisted.secureStore.deleteItemAsync.getMockImplementation();
    onTestFinished(() => {
      if (previousSet) {
        hoisted.secureStore.setItemAsync.mockImplementation(previousSet);
      }
      if (previousDelete) {
        hoisted.secureStore.deleteItemAsync.mockImplementation(previousDelete);
      }
    });
    hoisted.secureStore.setItemAsync.mockImplementation(async (key: string, value: string) => {
      if (key === 'active-user-id') {
        await oldWrite.promise;
      }
      disk.set(key, value);
    });
    hoisted.secureStore.deleteItemAsync.mockImplementation(async (key: string) => {
      await Promise.resolve();
      disk.delete(key);
    });
    const pendingHint = metadata.setAccountMetadata('active-user-id', 'user-a');
    await Promise.resolve();
    const transition: { promise?: Promise<void> } = {};
    await act(async () => {
      transition.promise = getCtx().signIn('account-b-token');
      await Promise.resolve();
    });
    // A crash at any credential write must not leave B's token beside A's hint.
    expect.soft(disk.has('auth-token')).toBe(false);
    await act(async () => {
      oldWrite.resolve(undefined);
      await pendingHint;
      await transition.promise;
    });
    expect(disk.get('auth-token')).toBe('account-b-token');
    expect(disk.has('active-user-id')).toBe(false);
    expect(hoisted.secureStore.deleteItemAsync).toHaveBeenCalledWith('active-user-id');
  });

  it('does not persist new credentials if removing the previous identity hint fails', async () => {
    const { getCtx, unmount } = await mountEpochTest();
    onTestFinished(() => act(unmount));
    hoisted.secureStore.deleteItemAsync.mockRejectedValueOnce(new Error('keychain unavailable'));
    await act(async () => {
      await expect(getCtx().signIn('account-b-token')).rejects.toThrow('keychain unavailable');
    });
    expect(hoisted.secureStore.setItemAsync).not.toHaveBeenCalled();
    expect(getCtx().isSigningOut).toBe(true);
    expect(getCtx().token).toBeUndefined();

    await act(async () => {
      await getCtx().signIn('account-b-token');
    });
    expect(getCtx().token).toBe('account-b-token');
    expect(getCtx().isSigningOut).toBe(false);
  });

  it('confirms a restored account from getMe rather than the decoded token hint', async () => {
    const token = makeToken({ kiloUserId: 'unconfirmed-hint' });
    hoisted.secureStore.getItemAsync
      .mockResolvedValueOnce(token)
      .mockResolvedValueOnce('stored-refresh')
      .mockResolvedValueOnce('9999999999999')
      .mockResolvedValueOnce(token);
    const { unmount } = await mountEpochTest(true);
    onTestFinished(() => act(unmount));
    const scope: typeof ContextScopeModule = await import('../context-scope');
    expect(scope.getAuthenticatedOwner().userId).toBeNull();
    // Credentials restored from storage on bootstrap: the persisted identity
    // hint may scope local data until getMe answers.
    expect(scope.getAuthenticatedOwner().restored).toBe(true);

    await act(async () => {
      await requestOwnerTicket();
    });

    expect(scope.getAuthenticatedOwner().userId).toBe('user-a');
    expect(scope.isAuthenticatedOwner(scope.getAuthenticatedOwner())).toBe(true);
  });

  it('rejects a prior account getMe completion after the current account confirms', async () => {
    const { getCtx, unmount } = await mountEpochTest(true);
    onTestFinished(() => act(unmount));
    await act(async () => {
      await getCtx().signIn('account-a-token');
    });
    const identity = Promise.withResolvers<{ id: string }>();
    ownerProducer.getMe.mockReturnValueOnce(identity.promise);
    const stale = requestOwnerTicket();
    const rejection = expect(stale).rejects.toThrow('Authenticated owner changed');

    await act(async () => {
      await getCtx().signIn('account-b-token');
    });
    ownerProducer.getMe.mockResolvedValueOnce({ id: 'user-b' });
    await act(async () => {
      await requestOwnerTicket();
      identity.resolve({ id: 'user-a' });
      await rejection;
    });

    const scope: typeof ContextScopeModule = await import('../context-scope');
    expect(scope.getAuthenticatedOwner().userId).toBe('user-b');
    expect(getCtx().token).toBe('account-b-token');
  });

  it('revokes the confirmed owner before remote logout cleanup or the epoch bump', async () => {
    const { getCtx, unmount } = await mountEpochTest(true);
    onTestFinished(() => act(unmount));
    await act(async () => {
      await getCtx().signIn('account-a-token');
    });
    await act(async () => {
      await requestOwnerTicket();
    });
    const scope: typeof ContextScopeModule = await import('../context-scope');
    const previous = scope.getAuthenticatedOwner();
    const cleanup = Promise.withResolvers<undefined>();
    onTestFinished(() => {
      cleanup.resolve(undefined);
    });
    logoutCleanupMock.runLogoutCleanup.mockReturnValueOnce(cleanup.promise);
    const transition: { promise?: Promise<void> } = {};
    await act(async () => {
      transition.promise = getCtx().signOut();
      await Promise.resolve();
    });

    expect(getCtx().authEpoch).toBe(previous.authEpoch);
    expect(getCtx().isSigningOut).toBe(true);
    expect(scope.getAuthenticatedOwner().userId).toBeNull();
    expect(scope.isAuthenticatedOwner(previous)).toBe(false);
    await expect(requestOwnerTicket()).rejects.toThrow('Authenticated owner changed');

    await act(async () => {
      cleanup.resolve(undefined);
      await transition.promise;
    });
    expect(getCtx().token).toBeUndefined();
  });

  it('keeps confirmed ownership stable during real request-time credential refresh', async () => {
    const { getCtx, unmount } = await mountEpochTest(true);
    onTestFinished(() => act(unmount));
    await act(async () => {
      await getCtx().signIn('account-a-token');
    });
    await act(async () => {
      await requestOwnerTicket();
    });
    const scope: typeof ContextScopeModule = await import('../context-scope');
    const owner = scope.getAuthenticatedOwner();
    const { performRefresh } = await import('@/lib/auth/credentials');
    const tokens: typeof TokenOwnerModule = await import('./token-owner');
    hoisted.secureStore.getItemAsync.mockResolvedValueOnce('refresh-a');
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json({ token: 'refreshed-token', refreshToken: 'refreshed-pair', expiresIn: 3600 })
      );
    onTestFinished(() => {
      fetch.mockRestore();
    });

    const outcome = await performRefresh();

    expect(outcome.ok).toBe(true);
    expect(tokens.getActiveToken()?.token).toBe('refreshed-token');
    expect(scope.getAuthenticatedOwner()).toBe(owner);
    expect(scope.isAuthenticatedOwner(owner)).toBe(true);
  });

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
    const { promise: cleanupGate, resolve: releaseCleanup } = Promise.withResolvers<undefined>();
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

    const clearMock = vi.mocked(queryClientMock.clear);

    releaseCleanup(undefined);
    await act(async () => {
      await Promise.all([signOutPromise, signInPromise]);
    });

    // Whole-body FIFO: the sign-out's teardown (including the query-client
    // clear) settled before the sign-in's credential write ran; the sign-in
    // account-switch path then clears a second time after its credential write.
    expect(clearMock).toHaveBeenCalledTimes(2);
    const clearOrder = clearMock.mock.invocationCallOrder[0];
    const setOrder = invocationOrder(hoisted.secureStore.setItemAsync);
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
    expect(vi.mocked(queryClientMock.clear)).toHaveBeenCalledTimes(1);
    expect(hoisted.secureStore.deleteItemAsync).toHaveBeenCalledWith(
      'auth-token',
      expect.anything()
    );
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
    expect(hoisted.secureStore.deleteItemAsync).toHaveBeenCalledWith(
      'auth-token',
      expect.anything()
    );
    expect(hoisted.secureStore.deleteItemAsync).toHaveBeenCalledWith('organization');
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
    expect(hoisted.secureStore.deleteItemAsync).toHaveBeenCalledWith(
      'auth-token',
      expect.anything()
    );
    expect(hoisted.secureStore.deleteItemAsync).toHaveBeenCalledWith('active-user-id');
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
    expect(hoisted.secureStore.deleteItemAsync).toHaveBeenCalledWith(
      'auth-token',
      expect.anything()
    );
    expect(hoisted.secureStore.deleteItemAsync).toHaveBeenCalledWith('organization');
    expect(hoisted.secureStore.deleteItemAsync).toHaveBeenCalledWith('session-filters');
    expect(hoisted.secureStore.deleteItemAsync).toHaveBeenCalledWith('live-session-filters');
    expect(hoisted.secureStore.deleteItemAsync).toHaveBeenCalledWith('active-user-id');
    const { clearAgentModelPreference } = await import('@/lib/hooks/use-persisted-agent-model');
    expect(clearAgentModelPreference).toHaveBeenCalled();
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

    expect(vi.mocked(queryClientMock.clear)).toHaveBeenCalledTimes(1);
    const { clearAgentModelPreference } = await import('@/lib/hooks/use-persisted-agent-model');
    expect(clearAgentModelPreference).not.toHaveBeenCalled();
    expect(getCtx().token).toBeUndefined();
    expect(getCtx().sessionEnded).toBe(false);

    unmount();
  });
});

describe('startup credential read failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.callOrder.length = 0;
  });

  /** The environmental keychain failure: reads of `auth-token` reject for the
   *  first `failures` attempts and then report the stored session (or
   *  `recoveredValue`, for the genuinely-no-session case). The refresh and
   *  expiry reads stay healthy, so only the credential read is faulty. */
  function failTokenReads(failures: number, recoveredValue: string | null = 'stored-token') {
    let tokenReads = 0;
    // eslint-disable-next-line require-await -- mock returning a resolved or rejected promise
    hoisted.secureStore.getItemAsync.mockImplementation(async (key: string) => {
      if (key === 'auth-token') {
        tokenReads += 1;
        if (tokenReads <= failures) {
          throw new Error('keychain unavailable');
        }
        return recoveredValue;
      }
      if (key === 'refresh-token') {
        return 'stored-refresh';
      }
      if (key === 'token-expires-at') {
        return '9999999999999';
      }
      return null;
    });
    return () => tokenReads;
  }

  // No `unhandledRejection` listener is scoped in this suite on purpose: the
  // fix is that the rejection never escapes `load()`, so an escape must fail
  // the file rather than be swallowed.

  it('repro: a rejected startup credential read keeps the person signed in', async () => {
    failTokenReads(1);

    // Fresh module registry: preloadedAuthToken is recreated and rejects.
    const { ctx, unmount } = await mountAndGetContext();

    // A transient keychain failure at startup must never sign the person
    // out: the retried read finds the stored session, so bootstrap settles
    // signed in instead of leaving the app on the login screen.
    expect(ctx.isLoading).toBe(false);
    expect(ctx.token).toBe('stored-token');
    expect(ctx.restoreFailed).toBe(false);

    unmount();
  });

  it('reports a retryable restore failure when every retry fails, without signing out', async () => {
    // Four attempts (the first plus three retries) all reject.
    const readCount = failTokenReads(4);

    const { ctx, unmount } = await mountAndGetContext();

    expect(readCount()).toBe(4);
    // No token is fabricated and no signed-out path is taken: the session is
    // not known to be gone, so the person is asked to retry.
    expect(ctx.isLoading).toBe(false);
    expect(ctx.restoreFailed).toBe(true);
    expect(ctx.token).toBeUndefined();
    expect(hoisted.deepLinkLaunch.setCurrentDeepLinkUserId).not.toHaveBeenCalled();

    unmount();
  }, 30_000);

  it('restores the session when retryRestore runs after the storage recovers', async () => {
    // Every attempt of the first bootstrap fails; the retry's reads succeed.
    failTokenReads(4);

    const { getCtx, unmount } = await mountAndGetContext();
    expect(getCtx().restoreFailed).toBe(true);

    act(() => {
      getCtx().retryRestore();
    });
    // The retry holds the settled error surface: the flag clears only once
    // `load()`'s primary reads resolve, never synchronously on tap, so the
    // surface never blanks behind a hidden loading gate.
    expect(getCtx().restoreFailed).toBe(true);
    expect(getCtx().isLoading).toBe(true);

    await settleBootstrap(getCtx);

    // The recovered read restored the session and cleared the flag.
    expect(getCtx().restoreFailed).toBe(false);
    expect(getCtx().token).toBe('stored-token');

    unmount();
  }, 30_000);

  it('a failed retry settles back onto the restore error surface', async () => {
    // Four reads for the first bootstrap, four for the retry: every attempt
    // of both runs rejects.
    failTokenReads(8);

    const { getCtx, unmount } = await mountAndGetContext();
    expect(getCtx().restoreFailed).toBe(true);

    act(() => {
      getCtx().retryRestore();
    });
    // The surface holds while the retry's reads are failing.
    expect(getCtx().restoreFailed).toBe(true);
    expect(getCtx().isLoading).toBe(true);

    await settleBootstrap(getCtx);

    // The failed retry re-settled the same surface: still flagged, still no
    // token, and the gate is gone again so Retry (and Sign out) are live.
    expect(getCtx().restoreFailed).toBe(true);
    expect(getCtx().isLoading).toBe(false);
    expect(getCtx().token).toBeUndefined();

    unmount();
  }, 30_000);

  it('sends the person to login when the retry finds no stored session', async () => {
    // Every attempt of the first bootstrap fails; the retry's reads resolve
    // null, so the session is genuinely gone and login is the destination.
    failTokenReads(4, null);

    const { getCtx, unmount } = await mountAndGetContext();
    expect(getCtx().restoreFailed).toBe(true);

    act(() => {
      getCtx().retryRestore();
    });
    expect(getCtx().restoreFailed).toBe(true);
    expect(getCtx().isLoading).toBe(true);

    await settleBootstrap(getCtx);

    // The known-empty answer clears the flag: no error surface and no token —
    // the login route is the correct destination.
    expect(getCtx().restoreFailed).toBe(false);
    expect(getCtx().isLoading).toBe(false);
    expect(getCtx().token).toBeUndefined();

    unmount();
  }, 30_000);

  it('does not resurrect the restore error surface when signOut lands mid-retry', async () => {
    // Four reads for the first bootstrap, four for the in-flight retry: the
    // abandoned retry's catch fires only after sign-out has begun.
    const readCount = failTokenReads(8);

    const { getCtx, unmount } = await mountAndGetContext();
    expect(getCtx().restoreFailed).toBe(true);

    act(() => {
      getCtx().retryRestore();
    });
    expect(getCtx().isLoading).toBe(true);

    // Sign out while the retry's reads are still failing inside their backoff
    // window: the escape hatch clears the surface and routes to login before
    // the abandoned load settles.
    await act(async () => {
      await getCtx().signOut();
    });
    expect(getCtx().restoreFailed).toBe(false);
    expect(getCtx().token).toBeUndefined();

    // Let the abandoned retry's remaining reads exhaust (~1.75 s of backoff)
    // and flush its catch. Resurrecting the flag here would repaint the error
    // screen over the login route, where the sign-out dedupe makes a second
    // tap a no-op — the escape hatch would be permanently dead. The budget is a
    // real wall-clock wait so a loaded machine's stretched cycles do not cut the
    // retry's backoff short.
    const abandonedSettleStartedAt = Date.now();
    while (Date.now() - abandonedSettleStartedAt <= 30_000 && readCount() < 8) {
      // eslint-disable-next-line no-await-in-loop -- polling must flush and re-check sequentially between act cycles
      await act(async () => {
        await new Promise<void>(resolve => {
          setTimeout(resolve, 20);
        });
      });
    }
    await act(async () => {
      await Promise.resolve();
    });

    // The abandoned load settled onto the sign-out, not onto the error
    // surface: still false, still no token, still on the signed-out route.
    expect(getCtx().restoreFailed).toBe(false);
    expect(getCtx().isLoading).toBe(false);
    expect(getCtx().token).toBeUndefined();

    unmount();
  }, 30_000);

  it('clears the restore failure when signOut is used as the escape hatch', async () => {
    failTokenReads(4);

    const { getCtx, unmount } = await mountAndGetContext();
    expect(getCtx().restoreFailed).toBe(true);

    await act(async () => {
      await getCtx().signOut();
    });

    // The explicit teardown lands on login: the flag is cleared so the error
    // screen gives way to the login route.
    expect(getCtx().restoreFailed).toBe(false);
    expect(getCtx().token).toBeUndefined();

    unmount();
  }, 30_000);
});
