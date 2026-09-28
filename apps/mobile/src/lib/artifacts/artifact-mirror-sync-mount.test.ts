/* eslint-disable require-await -- the expo-secure-store mocks are the engine's async defaults, replaced only so this node suite can load the module */
import { describe, expect, it, vi } from 'vitest';

import { MIRROR_SYNC_MIN_INTERVAL_MS } from '@/lib/artifacts/artifact-mirror-sync';
import { shouldSyncOnForeground } from '@/lib/artifacts/artifact-mirror-sync-mount';

// The mount's own dependencies are replaced so this node suite loads the
// module at all: it is the pure foreground policy that is under test here, and
// `MIRROR_SYNC_MIN_INTERVAL_MS` is imported above as the real engine value so
// the policy's boundary cannot drift from the engine's gate.
vi.mock('react-native', () => ({
  AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
  Platform: { OS: 'android' },
}));
vi.mock('expo-file-system', () => ({ Directory: vi.fn(), File: vi.fn(), Paths: {} }));
vi.mock('expo', () => ({ requireOptionalNativeModule: () => null }));
vi.mock('expo-secure-store', () => ({
  deleteItemAsync: vi.fn(async () => undefined),
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
}));
vi.mock('expo-sharing', () => ({ isAvailableAsync: vi.fn(), shareAsync: vi.fn() }));
vi.mock('expo/fetch', () => ({ fetch: vi.fn() }));
vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    cliSessionsV2: { getSessionMessagesPage: { query: vi.fn() }, list: { query: vi.fn() } },
    cloudAgentNext: { getAttachmentDownloadUrl: { mutate: vi.fn() } },
  },
}));
vi.mock('@/lib/persist/encrypted-kv', () => ({
  clearScope: vi.fn(),
  clearScopePrefix: vi.fn(),
  getItem: vi.fn(),
  listEntries: vi.fn(),
  removeItem: vi.fn(),
  setItem: vi.fn(),
}));
vi.mock('@/lib/auth/auth-context', () => ({ useAuth: vi.fn() }));

const LAST_RUN = 1_700_000_000_000;

describe('shouldSyncOnForeground', () => {
  it('syncs a signed-in user who has not run yet', () => {
    expect(
      shouldSyncOnForeground({ lastRunAt: null, now: LAST_RUN, signedIn: true, signingOut: false })
    ).toBe(true);
  });

  it('syncs once the engine interval has elapsed', () => {
    expect(
      shouldSyncOnForeground({
        lastRunAt: LAST_RUN,
        now: LAST_RUN + MIRROR_SYNC_MIN_INTERVAL_MS,
        signedIn: true,
        signingOut: false,
      })
    ).toBe(true);
  });

  it('does not sync while the last run is still fresh', () => {
    expect(
      shouldSyncOnForeground({
        lastRunAt: LAST_RUN,
        now: LAST_RUN + MIRROR_SYNC_MIN_INTERVAL_MS - 1,
        signedIn: true,
        signingOut: false,
      })
    ).toBe(false);
    expect(
      shouldSyncOnForeground({
        lastRunAt: LAST_RUN,
        now: LAST_RUN,
        signedIn: true,
        signingOut: false,
      })
    ).toBe(false);
  });

  it('does not sync while sign-out is in progress', () => {
    expect(
      shouldSyncOnForeground({ lastRunAt: null, now: LAST_RUN, signedIn: true, signingOut: true })
    ).toBe(false);
  });

  it('does not sync a signed-out user, however stale the last run is', () => {
    expect(
      shouldSyncOnForeground({
        lastRunAt: LAST_RUN,
        now: LAST_RUN + MIRROR_SYNC_MIN_INTERVAL_MS * 2,
        signedIn: false,
        signingOut: false,
      })
    ).toBe(false);
  });

  it('treats a backwards clock as elapsed rather than locking the mirror out', () => {
    expect(
      shouldSyncOnForeground({
        lastRunAt: LAST_RUN,
        now: LAST_RUN - 1,
        signedIn: true,
        signingOut: false,
      })
    ).toBe(true);
  });
});
