import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type GlanceableAgentsSnapshot } from '@kilocode/app-shared/glanceable-agents-snapshot';

import {
  ACTIVE_USER_ID_KEY,
  AUTH_TOKEN_KEY,
  ORGANIZATION_STORAGE_KEY,
  REFRESH_TOKEN_KEY,
} from '@/lib/storage-keys';

const mocks = vi.hoisted(() => ({
  sweepStrayActivities: vi.fn(),
  adoptNativeActivity: vi.fn(),
  getLastGlanceableSnapshot: vi.fn<() => GlanceableAgentsSnapshot | null>(),
  restorePersistedGlanceable: vi.fn().mockResolvedValue(undefined),
  getItemAsync: vi.fn<(key: string) => Promise<string | null>>(),
  restoreFollowedSessionCards: vi.fn(),
  reportSecureStoreFailure: vi.fn(),
}));

const KEYCHAIN_LOCKED = new Error('keychain unavailable');

// The adoption hands the token to the delivery and reads the keychain; both are
// native graphs this suite never needs to run.
vi.mock('@/lib/glanceable/delivery-registration', () => ({}));
vi.mock('expo-secure-store', () => ({ getItemAsync: mocks.getItemAsync }));
vi.mock('@/lib/glanceable/persist', () => ({
  getLastGlanceableSnapshot: mocks.getLastGlanceableSnapshot,
  getGlanceableSnapshotForSignedInScope: mocks.getLastGlanceableSnapshot,
  restorePersistedGlanceable: mocks.restorePersistedGlanceable,
}));
vi.mock('./ios-sink', () => ({
  adoptNativeActivity: mocks.adoptNativeActivity,
  sweepStrayActivities: mocks.sweepStrayActivities,
}));
vi.mock('./session-follow', () => ({
  restoreFollowedSessionCards: mocks.restoreFollowedSessionCards,
}));
vi.mock('@/lib/telemetry/secure-store-events', () => ({
  reportSecureStoreFailure: mocks.reportSecureStoreFailure,
}));

const { adoptPushStartedActivity, restoreStoredSessionCards } = await import('./adopt-activity');

const SNAPSHOT = { status: 'happy', scopeKey: 'scope' } as unknown as GlanceableAgentsSnapshot;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getLastGlanceableSnapshot.mockReturnValue(null);
  mocks.getItemAsync.mockResolvedValue(null);
  mocks.restorePersistedGlanceable.mockResolvedValue(undefined);
});

describe('adoptPushStartedActivity', () => {
  it('sweeps the surface at launch even when nothing can be adopted', async () => {
    await adoptPushStartedActivity();

    expect(mocks.restorePersistedGlanceable).toHaveBeenCalledTimes(1);
    expect(mocks.sweepStrayActivities).toHaveBeenCalledTimes(1);
    expect(mocks.adoptNativeActivity).not.toHaveBeenCalled();
  });

  it('sweeps before handing a card to the server', async () => {
    mocks.getLastGlanceableSnapshot.mockReturnValue(SNAPSHOT);
    mocks.getItemAsync.mockImplementation((key: string) =>
      Promise.resolve(key === ACTIVE_USER_ID_KEY ? 'user-1' : 'org-9')
    );

    await adoptPushStartedActivity();

    expect(mocks.sweepStrayActivities).toHaveBeenCalledTimes(1);
    expect(mocks.adoptNativeActivity).toHaveBeenCalledWith(SNAPSHOT, {
      userId: 'user-1',
      organizationId: 'org-9',
    });
    expect(mocks.getItemAsync).toHaveBeenCalledWith(ORGANIZATION_STORAGE_KEY);
    expect(mocks.sweepStrayActivities.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.adoptNativeActivity.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
  });

  it('rebuilds the followed session cards with the stored scope', async () => {
    mocks.getItemAsync.mockImplementation((key: string) =>
      Promise.resolve(key === ACTIVE_USER_ID_KEY ? 'user-1' : null)
    );

    await adoptPushStartedActivity();

    expect(mocks.restoreFollowedSessionCards).toHaveBeenLastCalledWith({
      kind: 'account',
      ctx: { userId: 'user-1', organizationId: null },
    });
  });

  it('reports a keychain with no account and no credential as signed out', async () => {
    await adoptPushStartedActivity();
    expect(mocks.restoreFollowedSessionCards).toHaveBeenLastCalledWith({ kind: 'signedOut' });
    expect(mocks.adoptNativeActivity).not.toHaveBeenCalled();

    await restoreStoredSessionCards();
    expect(mocks.restoreFollowedSessionCards).toHaveBeenLastCalledWith({ kind: 'signedOut' });
  });

  it('keeps the cards when a credential is stored but the account hint is not', async () => {
    // The hint is written best effort, so a signed-in device can hold its
    // tokens without the hint.
    mocks.getItemAsync.mockImplementation((key: string) =>
      Promise.resolve(key === AUTH_TOKEN_KEY ? 'access-token' : null)
    );

    await adoptPushStartedActivity();

    expect(mocks.restoreFollowedSessionCards).toHaveBeenLastCalledWith({ kind: 'unreadable' });
    expect(mocks.adoptNativeActivity).not.toHaveBeenCalled();
  });

  it('counts a refresh token alone as a stored credential', async () => {
    mocks.getItemAsync.mockImplementation((key: string) =>
      Promise.resolve(key === REFRESH_TOKEN_KEY ? 'refresh-token' : null)
    );

    await adoptPushStartedActivity();

    expect(mocks.restoreFollowedSessionCards).toHaveBeenLastCalledWith({ kind: 'unreadable' });
  });

  it('keeps the cards when the credential read cannot answer', async () => {
    mocks.getItemAsync.mockImplementation((key: string) =>
      key === AUTH_TOKEN_KEY ? Promise.reject(KEYCHAIN_LOCKED) : Promise.resolve(null)
    );

    await adoptPushStartedActivity();

    expect(mocks.restoreFollowedSessionCards).toHaveBeenLastCalledWith({ kind: 'unreadable' });
  });

  it('retries a null credential read before reporting a sign-out', async () => {
    let authReads = 0;
    mocks.getItemAsync.mockImplementation((key: string) => {
      if (key !== AUTH_TOKEN_KEY) {
        return Promise.resolve(null);
      }
      authReads += 1;
      // A credential key can answer null before the device finishes unlocking.
      return Promise.resolve(authReads === 1 ? null : 'access-token');
    });

    await adoptPushStartedActivity();

    expect(mocks.restoreFollowedSessionCards).toHaveBeenLastCalledWith({ kind: 'unreadable' });
  });

  it('reports a keychain that cannot answer as unreadable', async () => {
    mocks.getItemAsync.mockRejectedValue(KEYCHAIN_LOCKED);

    await adoptPushStartedActivity();
    expect(mocks.restoreFollowedSessionCards).toHaveBeenLastCalledWith({ kind: 'unreadable' });
    expect(mocks.adoptNativeActivity).not.toHaveBeenCalled();
  });

  it('files one report for a keychain read that failed', async () => {
    mocks.getItemAsync.mockRejectedValue(KEYCHAIN_LOCKED);

    await adoptPushStartedActivity();

    // The guarded keychain module files the report for a read failure. Filing a
    // second one here would surface one failure as two issues, on every launch
    // and foreground.
    expect(mocks.reportSecureStoreFailure).toHaveBeenCalledTimes(1);
    expect(mocks.reportSecureStoreFailure.mock.calls[0]?.[0]).toBe('read');
  });

  it('reads no account and no organization selection as unreadable', async () => {
    mocks.getLastGlanceableSnapshot.mockReturnValue(SNAPSHOT);
    // The user id reads, then the keychain stops answering before the scope.
    mocks.getItemAsync.mockResolvedValueOnce('user-1').mockRejectedValueOnce(KEYCHAIN_LOCKED);

    await adoptPushStartedActivity();

    // A read that failed proves nothing about the organization, so nothing is
    // adopted and no card is treated as out of scope.
    expect(mocks.restoreFollowedSessionCards).toHaveBeenLastCalledWith({ kind: 'unreadable' });
    expect(mocks.adoptNativeActivity).not.toHaveBeenCalled();
  });
});
