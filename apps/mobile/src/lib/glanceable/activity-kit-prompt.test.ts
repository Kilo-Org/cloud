import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildGlanceableSnapshot,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';

import {
  _resetGlanceablePersistForTests,
  _setLastGlanceableSnapshotForTests,
} from '@/lib/glanceable/persist';
import { registerGlanceableSink, unregisterGlanceableSink } from '@/lib/glanceable/sink-registry';
import { ACTIVE_USER_ID_KEY, ORGANIZATION_STORAGE_KEY } from '@/lib/storage-keys';

import { recoverGlanceableActivityKit } from './activity-kit-prompt';

const mocks = vi.hoisted(() => ({
  platform: { OS: 'ios' },
  alert: vi.fn(),
  openSettings: vi.fn(),
  getItemAsync: vi.fn(),
  clearActivityKitDeniedIfAvailable: vi.fn(),
  getActivityKitDenied: vi.fn(),
}));

vi.mock('react-native', () => ({
  Platform: mocks.platform,
  Alert: { alert: mocks.alert },
  Linking: { openSettings: mocks.openSettings },
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: mocks.getItemAsync,
}));

vi.mock('@/glanceable-ios/ios-sink', () => ({
  clearActivityKitDeniedIfAvailable: mocks.clearActivityKitDeniedIfAvailable,
  getActivityKitDenied: mocks.getActivityKitDenied,
}));

vi.mock('@/i18n', () => ({
  i18n: { t: (key: string) => key },
}));

const NOW = 1_750_000_000_000;

function eligibleSnapshot(): GlanceableAgentsSnapshot {
  return buildGlanceableSnapshot({
    sessions: [{ status: 'busy' }],
    userId: 'u1',
    organizationId: null,
    now: NOW,
  });
}

function emptySnapshot(): GlanceableAgentsSnapshot {
  return buildGlanceableSnapshot({
    sessions: [],
    userId: 'u1',
    organizationId: null,
    now: NOW,
  });
}

function makeFakeSink() {
  return {
    publish: vi.fn(),
    endImmediate: vi.fn(),
    startOrUpdate: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetGlanceablePersistForTests();
  mocks.platform.OS = 'ios';
  mocks.getItemAsync.mockResolvedValue(null);
  mocks.clearActivityKitDeniedIfAvailable.mockReturnValue(false);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('recoverGlanceableActivityKit', () => {
  it('does nothing when the denied latch was not cleared', async () => {
    mocks.clearActivityKitDeniedIfAvailable.mockReturnValue(false);
    _setLastGlanceableSnapshotForTests(eligibleSnapshot());
    const sink = makeFakeSink();
    registerGlanceableSink(sink);

    await recoverGlanceableActivityKit();

    expect(sink.startOrUpdate).not.toHaveBeenCalled();
    unregisterGlanceableSink(sink);
  });

  it('does not re-emit when the persisted snapshot has no eligible work', async () => {
    mocks.clearActivityKitDeniedIfAvailable.mockReturnValue(true);
    _setLastGlanceableSnapshotForTests(emptySnapshot());
    const sink = makeFakeSink();
    registerGlanceableSink(sink);

    await recoverGlanceableActivityKit();

    expect(sink.startOrUpdate).not.toHaveBeenCalled();
    unregisterGlanceableSink(sink);
  });

  it('re-emits the persisted eligible snapshot with the SecureStore identity', async () => {
    mocks.clearActivityKitDeniedIfAvailable.mockReturnValue(true);
    const snapshot = eligibleSnapshot();
    _setLastGlanceableSnapshotForTests(snapshot);
    mocks.getItemAsync.mockImplementation(async (key: string) => {
      await Promise.resolve();
      if (key === ACTIVE_USER_ID_KEY) {
        return 'u1';
      }
      if (key === ORGANIZATION_STORAGE_KEY) {
        return 'org-9';
      }
      return null;
    });
    const sink = makeFakeSink();
    registerGlanceableSink(sink);

    await recoverGlanceableActivityKit();

    expect(sink.startOrUpdate).toHaveBeenCalledWith(snapshot, {
      userId: 'u1',
      organizationId: 'org-9',
    });
    unregisterGlanceableSink(sink);
  });

  it('does not re-emit on a non-iOS platform', async () => {
    mocks.platform.OS = 'android';
    mocks.clearActivityKitDeniedIfAvailable.mockReturnValue(true);
    _setLastGlanceableSnapshotForTests(eligibleSnapshot());
    const sink = makeFakeSink();
    registerGlanceableSink(sink);

    await recoverGlanceableActivityKit();

    expect(mocks.clearActivityKitDeniedIfAvailable).not.toHaveBeenCalled();
    expect(sink.startOrUpdate).not.toHaveBeenCalled();
    unregisterGlanceableSink(sink);
  });
});
