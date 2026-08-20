/* oxlint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer for RN trees under vitest (node env, no jsdom) */
/* oxlint-disable @typescript-eslint/no-unsafe-call @typescript-eslint/no-unsafe-member-access */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
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

vi.mock('@/lib/config', () => ({ API_BASE_URL: 'https://api.example.com' }));

// The sign-out deletes live in auth-context.tsx; mounting it pulls in the full
// teardown graph, so stub every side-effecting collaborator.
vi.mock('@sentry/react-native', () => ({ setUser: vi.fn(), captureException: vi.fn() }));
vi.mock('@/lib/analytics/posthog', () => ({
  discardPostHog: vi.fn().mockResolvedValue(undefined),
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
vi.mock('@/lib/hooks/use-keep-screen-on-preference', () => ({
  clearKeepScreenOnPreference: vi.fn(),
}));
vi.mock('@/lib/hooks/use-reasoning-preference', () => ({ clearReasoningPreference: vi.fn() }));
vi.mock('@/lib/kiloclaw-tab-ownership', () => ({
  gateKiloClawOwned: vi.fn(),
  clearKiloClawOwned: vi.fn(),
}));
vi.mock('@/lib/last-active-instance', () => ({
  clearLastActiveInstance: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/kilo-pass/use-store-kilo-pass-purchase', () => ({
  resetPurchaseErrorToastDedup: vi.fn(),
}));
vi.mock('@/lib/persist/read-cache', () => ({
  clearCacheScopeForSignOut: vi.fn().mockResolvedValue(undefined),
  readCachedUserId: vi.fn().mockReturnValue(null),
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

import * as SecureStore from 'expo-secure-store';
import { persistSignInCredentialsAtEpoch } from '@/lib/auth/credentials';
import { bumpAuthEpoch } from '@/lib/auth/auth-epoch';
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
});

describe('sign-out deletes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
  });

  it('deletes the three bearer keys with WHEN_UNLOCKED_THIS_DEVICE_ONLY', async () => {
    await mountAndSignOut();

    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(AUTH_TOKEN_KEY, expectedOptions);
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(REFRESH_TOKEN_KEY, expectedOptions);
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(TOKEN_EXPIRES_AT_KEY, expectedOptions);
    // The legacy-exchange marker is not a bearer key: it keeps the default class.
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(LEGACY_EXCHANGE_DONE_KEY);
  });
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
