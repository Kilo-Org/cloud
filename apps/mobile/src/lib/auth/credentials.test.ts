/* eslint-disable max-lines -- one cohesive credential suite: the bearer writes, the refresh rotation, and the unreadable-credential cases share the SecureStore mock and the serialized-write seam */
/* oxlint-disable @typescript-eslint/no-unsafe-call @typescript-eslint/no-unsafe-member-access */
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();

/* eslint-disable import/first */
// vi.mock is hoisted by Vitest before the real import resolves.
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  getItem: vi.fn((key: string) => store.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => {
    store.set(key, value);
  }),
  getItemAsync: vi.fn(async (key: string) => {
    await Promise.resolve();
    return store.get(key) ?? null;
  }),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    await Promise.resolve();
    store.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    await Promise.resolve();
    store.delete(key);
  }),
}));

// The sign-out deletes live in auth-context.tsx; mounting it pulls in the full
// teardown graph, so stub every side-effecting collaborator.
vi.mock('@sentry/react-native', () => ({
  setUser: vi.fn(),
  setTag: vi.fn(),
  captureException: vi.fn(),
}));
vi.mock('@/lib/analytics/posthog', () => ({
  captureEvent: vi.fn(),
  CONSENT_OUTCOME_EVENT: 'consent_outcome',
  discardPostHog: vi.fn().mockResolvedValue(undefined),
  flushLastPostHogEvent: vi.fn().mockResolvedValue(undefined),
  isPostHogReady: vi.fn(() => false),
  LOGOUT_EVENT: 'logout',
  subscribeToPostHogReady: vi.fn(),
}));
vi.mock('@/lib/appsflyer', () => ({ resetAppsFlyerState: vi.fn(), trackEvent: vi.fn() }));
vi.mock('@/lib/auth/account-metadata-write', () => ({
  deleteAccountMetadata: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/auth/logout-cleanup', () => ({
  runLogoutCleanup: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/query-client', () => ({
  queryClient: { clear: vi.fn(), invalidateQueries: vi.fn() },
}));
vi.mock('@/lib/auth/trpc-unauthorized', () => ({ setTrpcUnauthorizedHandler: vi.fn() }));
vi.mock('@/lib/hooks/use-persisted-agent-model', () => ({ clearAgentModelPreference: vi.fn() }));
vi.mock('@/lib/hooks/use-persisted-run-on-destination', () => ({
  clearRunOnDestinationPreference: vi.fn(),
}));
vi.mock('@/lib/hooks/use-keep-screen-on-preference', () => ({
  clearKeepScreenOnPreference: vi.fn(),
}));
vi.mock('@/lib/hooks/use-live-activity-preference', () => ({
  clearLiveActivityPreference: vi.fn(),
}));
vi.mock('@/lib/hooks/use-pr-review-footer-preference', () => ({
  clearPrReviewFooterPreference: vi.fn(),
}));
vi.mock('@/lib/hooks/use-condense-tool-calls-preference', () => ({
  clearCondenseToolCallsPreference: vi.fn(),
}));
vi.mock('@/lib/hooks/use-collapsed-connect-ctas-preference', () => ({
  clearCollapsedConnectCtasPreference: vi.fn(),
}));
vi.mock('@/lib/hooks/use-reasoning-preference', () => ({ clearReasoningPreference: vi.fn() }));
vi.mock('@/lib/hooks/use-hide-thinking-preference', () => ({
  clearHideThinkingPreference: vi.fn(),
}));
vi.mock('@/lib/kiloclaw-tab-ownership', () => ({
  gateKiloClawOwned: vi.fn(),
  clearKiloClawOwned: vi.fn(),
}));
vi.mock('@/lib/last-active-instance', () => ({
  clearLastActiveInstance: vi.fn().mockResolvedValue(undefined),
}));
// The sign-out block clears the launcher surfaces and the last-opened record.
// Stub them like the rest of the teardown graph: the native wrapper imports
// `expo`, which needs `__DEV__` and cannot load in the node test environment.
vi.mock('@/lib/last-opened-session', () => ({ clearLastOpenedSession: vi.fn() }));
vi.mock('@/lib/native-launcher-surfaces', () => ({ clearLauncherSurfaces: vi.fn() }));
vi.mock('@/lib/kilo-pass/use-store-kilo-pass-purchase', () => ({
  resetPurchaseErrorToastDedup: vi.fn(),
}));
vi.mock('@/lib/persist/read-cache', () => ({
  clearCacheScopeForSignOut: vi.fn().mockResolvedValue(undefined),
  readCachedUserId: vi.fn().mockReturnValue(null),
}));
// The offline tool-summary translation scope: `clearToolSummaryTranslationsForSignOut`
// imports the encrypted KV store, whose expo-crypto binding crashes the node
// environment, so the sign-out graph must not load the real module here.
vi.mock('@/lib/persist/tool-summary-translation-cache', () => ({
  clearToolSummaryTranslationsForSignOut: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/pr-review/recent-prs', () => ({
  clearRecentPrs: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/pr-review/viewed-files', () => ({
  clearViewedFiles: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/telemetry/controller', () => ({ clearTelemetryDecision: vi.fn() }));
vi.mock('@/lib/telemetry/posthog-storage', () => ({
  purgePostHogPersistence: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('react-native', () => ({
  AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
}));

// These imported session-clear modules pull in native bindings that crash the
// node test environment: use-trusted-hosts -> secure-store-preference ->
// sonner-native -> react-native (Flow `import typeof`), and the cache/file
// modules -> expo-file-system / expo-clipboard / expo-crypto. Mock them the
// same way use-persisted-agent-model is, since this suite only asserts the
// credential deletes.
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
// the native provider bridge. This suite asserts the credential deletes, and
// the mirror's own suite covers the wipe and its provider signal.
vi.mock('@/lib/artifacts/artifact-mirror', () => ({
  clearArtifactMirror: vi.fn(),
}));

vi.mock('@/lib/artifacts/artifact-mirror-sync', () => ({
  resetArtifactMirrorSyncState: vi.fn(),
}));

vi.mock('@/lib/artifacts/artifact-provider-native', () => ({
  notifyArtifactsChanged: vi.fn(),
}));

// The sign-out teardown's OS search clear reaches the root `expo` entry, which
// reads `__DEV__` at import time and does not parse under the node test
// environment. The clear is a no-op here.
vi.mock('@/lib/native-system-search', () => ({
  clearSystemSearchIndex: vi.fn().mockResolvedValue(undefined),
}));

import * as SecureStore from 'expo-secure-store';
import { performRefresh, persistSignInCredentialsAtEpoch } from '@/lib/auth/credentials';
import { bumpAuthEpoch, currentAuthEpoch } from '@/lib/auth/auth-epoch';
import { clearActiveToken, setSignOutTeardownActive } from '@/lib/auth/token-owner';
import {
  AUTH_TOKEN_KEY,
  LEGACY_EXCHANGE_DONE_KEY,
  REFRESH_TOKEN_KEY,
  TOKEN_EXPIRES_AT_KEY,
} from '@/lib/storage-keys';
/* eslint-enable import/first */

// Apple `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` is not in iCloud or
// iTunes backup and does not migrate to a new device. The assertions below
// prove every bearer write and delete pins the keychain to that class.
const expectedOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

describe('bearer credential writes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
    clearActiveToken();
    setSignOutTeardownActive(false);
  });

  it('writes every bearer key with WHEN_UNLOCKED_THIS_DEVICE_ONLY', async () => {
    const published = await persistSignInCredentialsAtEpoch('token', 'refresh', {
      expiresIn: 3600,
    });

    expect(published).toBe(true);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(AUTH_TOKEN_KEY, 'token', expectedOptions);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      REFRESH_TOKEN_KEY,
      'refresh',
      expectedOptions
    );
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      TOKEN_EXPIRES_AT_KEY,
      expect.any(String),
      expectedOptions
    );
  });

  it('deletes the prior refresh pair with the option on a token-only sign-in', async () => {
    store.set(REFRESH_TOKEN_KEY, 'old-refresh');
    store.set(TOKEN_EXPIRES_AT_KEY, '999');

    await persistSignInCredentialsAtEpoch('token-only', undefined, {});

    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(REFRESH_TOKEN_KEY, expectedOptions);
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(TOKEN_EXPIRES_AT_KEY, expectedOptions);
  });

  it('clears a partial pair with the option when the epoch moves mid-write', async () => {
    vi.mocked(SecureStore.setItemAsync).mockImplementationOnce(async (key, value) => {
      store.set(key, value);
      bumpAuthEpoch();
      await Promise.resolve();
    });

    const published = await persistSignInCredentialsAtEpoch('token', 'refresh', {
      expiresIn: 3600,
    });

    expect(published).toBe(false);
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(AUTH_TOKEN_KEY, expectedOptions);
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(REFRESH_TOKEN_KEY, expectedOptions);
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(TOKEN_EXPIRES_AT_KEY, expectedOptions);
  });

  it('clears the keys committed before a later write rejection and rethrows the failure', async () => {
    store.set(AUTH_TOKEN_KEY, 'old-token');
    store.set(REFRESH_TOKEN_KEY, 'old-refresh');
    store.set(TOKEN_EXPIRES_AT_KEY, '999');

    // The auth-token write commits; the refresh-token write then rejects.
    vi.mocked(SecureStore.setItemAsync)
      .mockImplementationOnce(async (key: string, value: string) => {
        store.set(key, value);
        await Promise.resolve();
      })
      .mockImplementationOnce(async () => {
        await Promise.resolve();
        throw new Error('keychain write failed');
      });

    await expect(
      persistSignInCredentialsAtEpoch('new-token', 'new-refresh', { expiresIn: 3600 })
    ).rejects.toThrow('keychain write failed');

    // The partial set is gone: no half-written session survives the failure.
    expect(store.has(AUTH_TOKEN_KEY)).toBe(false);
    expect(store.has(REFRESH_TOKEN_KEY)).toBe(false);
    expect(store.has(TOKEN_EXPIRES_AT_KEY)).toBe(false);
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(AUTH_TOKEN_KEY, expectedOptions);
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(REFRESH_TOKEN_KEY, expectedOptions);
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(TOKEN_EXPIRES_AT_KEY, expectedOptions);
  });

  it('rethrows the write failure when the partial-set cleanup also fails', async () => {
    vi.mocked(SecureStore.setItemAsync)
      .mockImplementationOnce(async (key: string, value: string) => {
        store.set(key, value);
        await Promise.resolve();
      })
      .mockImplementationOnce(async () => {
        await Promise.resolve();
        throw new Error('keychain write failed');
      });
    // The first cleanup delete rejects too: the original failure must still
    // surface. A one-shot rejection keeps the shared mock clean for the rest
    // of the suite (the sequential cleanup stops at the first rejection).
    vi.mocked(SecureStore.deleteItemAsync).mockRejectedValueOnce(
      new Error('cleanup delete failed')
    );

    await expect(
      persistSignInCredentialsAtEpoch('new-token', 'new-refresh', { expiresIn: 3600 })
    ).rejects.toThrow('keychain write failed');
  });

  it('leaves the previous session intact when the first write of an attempt rejects', async () => {
    store.set(AUTH_TOKEN_KEY, 'old-token');
    store.set(REFRESH_TOKEN_KEY, 'old-refresh');
    store.set(TOKEN_EXPIRES_AT_KEY, '999');

    // The very first operation rejects, so nothing of this attempt committed.
    vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error('keychain unavailable'));

    await expect(
      persistSignInCredentialsAtEpoch('new-token', 'new-refresh', { expiresIn: 3600 })
    ).rejects.toThrow('keychain unavailable');

    // No partial set exists, so nothing is cleared: a transient keychain
    // failure stays retryable instead of destroying the stored session.
    expect(store.get(AUTH_TOKEN_KEY)).toBe('old-token');
    expect(store.get(REFRESH_TOKEN_KEY)).toBe('old-refresh');
    expect(store.get(TOKEN_EXPIRES_AT_KEY)).toBe('999');
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
  });
});

describe('refresh rotation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
    clearActiveToken();
    setSignOutTeardownActive(false);
  });

  it('retries a rejected refresh-token read and still rotates the token', async () => {
    store.set(REFRESH_TOKEN_KEY, 'r1');
    // The keychain rejects the first read — the transient class on a device
    // that just foregrounded — and resolves the stored value on the retry.
    let reads = 0;
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key: string) => {
      await Promise.resolve();
      reads += 1;
      if (reads === 1) {
        throw new Error('keychain temporarily unavailable');
      }
      return store.get(key) ?? null;
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ token: 't2', refreshToken: 'r2', expiresIn: 3600 }, { status: 200 })
      );
    vi.stubGlobal('fetch', fetchMock);

    try {
      const outcome = await performRefresh();

      expect(outcome.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(SecureStore.setItemAsync).toHaveBeenCalledWith(AUTH_TOKEN_KEY, 't2', expectedOptions);
      expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
        REFRESH_TOKEN_KEY,
        'r2',
        expectedOptions
      );
      expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
        TOKEN_EXPIRES_AT_KEY,
        expect.any(String),
        expectedOptions
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // The defect this slice removes: a null refresh-token read used to be read
  // as "no session" and refused, which signed a healthy person out. It is a
  // failed read of one member, not an absent credential set.
  it('returns unreadable, not refused, when the refresh token is absent but the token is present', async () => {
    store.set(AUTH_TOKEN_KEY, 'stored-token');
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key: string) => {
      await Promise.resolve();
      return store.get(key) ?? null;
    });
    const fetchMock = vi.fn().mockRejectedValue(new Error('fetch must not be called'));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const outcome = await performRefresh();

      expect(outcome).toEqual({
        ok: false,
        refused: false,
        unreadable: true,
        presentKeys: [AUTH_TOKEN_KEY],
      });
      expect(fetchMock).not.toHaveBeenCalled();
      // The stored token is untouched: nothing was deleted or published.
      expect(store.get(AUTH_TOKEN_KEY)).toBe('stored-token');
      expect(store.has(REFRESH_TOKEN_KEY)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns unreadable with no present keys for an empty credential set', async () => {
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key: string) => {
      await Promise.resolve();
      return store.get(key) ?? null;
    });
    const fetchMock = vi.fn().mockRejectedValue(new Error('fetch must not be called'));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const outcome = await performRefresh();

      // A null member never refuses: even an empty set is an unreadable read,
      // not a signed-out session.
      expect(outcome).toEqual({
        ok: false,
        refused: false,
        unreadable: true,
        presentKeys: [],
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rotates when a null refresh-token read is followed by a stored value', async () => {
    let refreshReads = 0;
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key: string) => {
      await Promise.resolve();
      if (key === REFRESH_TOKEN_KEY) {
        refreshReads += 1;
        return refreshReads === 1 ? null : 'stored-refresh';
      }
      return store.get(key) ?? null;
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ token: 't2', refreshToken: 'r2', expiresIn: 3600 }, { status: 200 })
      );
    vi.stubGlobal('fetch', fetchMock);

    try {
      const outcome = await performRefresh();

      expect(outcome.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(SecureStore.setItemAsync).toHaveBeenCalledWith(AUTH_TOKEN_KEY, 't2', expectedOptions);
      expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
        REFRESH_TOKEN_KEY,
        'r2',
        expectedOptions
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('still refuses when the server answers 401 for a stored refresh token', async () => {
    store.set(REFRESH_TOKEN_KEY, 'old-refresh');
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ error: 'invalid' }, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const outcome = await performRefresh();

      // A refusal is scoped to the session that owned the refresh: it carries
      // that session's epoch so a handler can drop it once the epoch has moved.
      expect(outcome).toEqual({
        ok: false,
        refused: true,
        sessionVersion: currentAuthEpoch(),
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('sign-out deletes', () => {
  // mountAndSignOut resets modules and imports the whole auth graph; under the
  // full related-suite running concurrently with the device stack that exceeds
  // the 5 s default (b911 gate flake, 2026-09-08).
  const mountSignOutTimeoutMs = 30_000;

  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
  });

  it(
    'deletes the three bearer keys with WHEN_UNLOCKED_THIS_DEVICE_ONLY',
    async () => {
      await mountAndSignOut();

      expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(AUTH_TOKEN_KEY, expectedOptions);
      expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(REFRESH_TOKEN_KEY, expectedOptions);
      expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(
        TOKEN_EXPIRES_AT_KEY,
        expectedOptions
      );
      // The legacy-exchange marker is not a bearer key: it keeps the default class.
      expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(LEGACY_EXCHANGE_DONE_KEY);
    },
    mountSignOutTimeoutMs
  );
});

/** Mount the AuthProvider and run sign-out so the credential deletes execute. */
async function mountAndSignOut(): Promise<void> {
  vi.resetModules();
  const mod = await import('./auth-context');

  const holder: {
    captured?: { signOut: (ended?: boolean) => Promise<void> };
    renderer?: TestRenderer.ReactTestRenderer;
  } = {};

  function Consumer(): null {
    holder.captured = mod.useAuth();
    return null;
  }

  await act(async () => {
    holder.renderer = TestRenderer.create(
      createElement(mod.AuthProvider, null, createElement(Consumer))
    );
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise<void>(resolve => {
      void setTimeout(resolve, 0);
    });
  });

  // oxlint-disable-next-line @typescript-eslint/no-unnecessary-condition -- safety net for test failures
  if (!holder.captured) {
    throw new Error('auth context not captured');
  }
  const signOut = holder.captured.signOut;

  await act(async () => {
    await signOut();
  });

  holder.renderer?.unmount();
}
