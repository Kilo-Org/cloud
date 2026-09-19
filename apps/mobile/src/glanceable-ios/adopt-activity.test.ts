import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type GlanceableAgentsSnapshot } from '@kilocode/app-shared/glanceable-agents-snapshot';

import { ACTIVE_USER_ID_KEY, ORGANIZATION_STORAGE_KEY } from '@/lib/storage-keys';

const mocks = vi.hoisted(() => ({
  sweepStrayActivities: vi.fn(),
  adoptNativeActivity: vi.fn(),
  getLastGlanceableSnapshot: vi.fn<() => GlanceableAgentsSnapshot | null>(),
  restorePersistedGlanceable: vi.fn().mockResolvedValue(undefined),
  getItemAsync: vi.fn<(key: string) => string | null>(),
}));

// The adoption hands the token to the delivery and reads the keychain; both are
// native graphs this suite never needs to run.
vi.mock('@/lib/glanceable/delivery-registration', () => ({}));
vi.mock('expo-secure-store', () => ({ getItemAsync: mocks.getItemAsync }));
vi.mock('@/lib/glanceable/persist', () => ({
  getLastGlanceableSnapshot: mocks.getLastGlanceableSnapshot,
  restorePersistedGlanceable: mocks.restorePersistedGlanceable,
}));
vi.mock('./ios-sink', () => ({
  adoptNativeActivity: mocks.adoptNativeActivity,
  sweepStrayActivities: mocks.sweepStrayActivities,
}));

const { adoptPushStartedActivity } = await import('./adopt-activity');

const SNAPSHOT = { status: 'happy', scopeKey: 'scope' } as unknown as GlanceableAgentsSnapshot;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getLastGlanceableSnapshot.mockReturnValue(null);
  mocks.getItemAsync.mockReturnValue(null);
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
      key === ACTIVE_USER_ID_KEY ? 'user-1' : 'org-9'
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
});
