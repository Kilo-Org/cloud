import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildGlanceableSnapshot,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';

import { bumpAuthEpoch } from '@/lib/auth/auth-epoch';
import { writePrivacySnapshotAndEnd, writeSignedOutSnapshotAndEnd } from '@/lib/glanceable/cleanup';
import {
  _resetGlanceablePersistForTests,
  _setLastGlanceableSnapshotForTests,
} from '@/lib/glanceable/persist';
import {
  type GlanceableSink,
  type GlanceableSinkContext,
  registerGlanceableSink,
  unregisterGlanceableSink,
} from '@/lib/glanceable/sink-registry';
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

function eligibleSnapshot(organizationId: string | null = null): GlanceableAgentsSnapshot {
  return buildGlanceableSnapshot({
    sessions: [{ status: 'busy' }],
    userId: 'u1',
    organizationId,
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

const surface: {
  widget: GlanceableAgentsSnapshot | null;
  activity: GlanceableAgentsSnapshot | null;
  context: GlanceableSinkContext | null;
} = { widget: null, activity: null, context: null };

const sink: GlanceableSink = {
  publish(snapshot) {
    surface.widget = snapshot;
  },
  endImmediate() {
    surface.activity = null;
  },
  startOrUpdate(snapshot, context) {
    surface.activity = snapshot;
    surface.context = context;
  },
};

function deferred() {
  let release: (() => void) | undefined = undefined;
  const promise = new Promise<void>(resolve => {
    release = resolve;
  });
  return { promise, resolve: () => release?.() };
}

function delayIdentityRead(delayedKey: string) {
  const started = deferred();
  const gate = deferred();
  mocks.getItemAsync.mockImplementation(async (key: string) => {
    const value = key === ACTIVE_USER_ID_KEY ? 'u1' : null;
    if (key === delayedKey) {
      started.resolve();
      await gate.promise;
    }
    return value;
  });
  return { started: started.promise, resolve: gate.resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetGlanceablePersistForTests();
  _setLastGlanceableSnapshotForTests(eligibleSnapshot());
  surface.widget = null;
  surface.activity = null;
  surface.context = null;
  registerGlanceableSink(sink);
  mocks.platform.OS = 'ios';
  mocks.getItemAsync.mockImplementation((key: string) =>
    key === ACTIVE_USER_ID_KEY ? 'u1' : null
  );
  mocks.getActivityKitDenied.mockReturnValue(true);
  mocks.clearActivityKitDeniedIfAvailable.mockReturnValue(true);
});

afterEach(() => {
  unregisterGlanceableSink(sink);
});

describe('recoverGlanceableActivityKit', () => {
  it('does nothing when the denied latch was not cleared', async () => {
    mocks.clearActivityKitDeniedIfAvailable.mockReturnValue(false);

    await recoverGlanceableActivityKit();

    expect(surface.activity).toBeNull();
  });

  it.each([null, emptySnapshot()])(
    'does not start absent or ineligible work: %s',
    async snapshot => {
      _setLastGlanceableSnapshotForTests(snapshot);

      await recoverGlanceableActivityKit();

      expect(surface.activity).toBeNull();
    }
  );

  it.each([null, 'org-9'])('recovers authorized work in scope %s', async organizationId => {
    const snapshot = eligibleSnapshot(organizationId);
    _setLastGlanceableSnapshotForTests(snapshot);
    mocks.getItemAsync.mockImplementation((key: string) =>
      key === ACTIVE_USER_ID_KEY ? 'u1' : organizationId
    );

    await recoverGlanceableActivityKit();

    expect(surface.activity).toEqual(snapshot);
    expect(surface.context).toEqual({ userId: 'u1', organizationId });
  });

  it.each([null, 'u2'])('rejects the unavailable or mismatched user hint %s', async userId => {
    mocks.getItemAsync.mockImplementation((key: string) =>
      key === ACTIVE_USER_ID_KEY ? userId : null
    );

    await recoverGlanceableActivityKit();

    expect(surface.activity).toBeNull();
  });

  it.each([null, 'org-10'])('rejects the mismatched organization hint %s', async organizationId => {
    _setLastGlanceableSnapshotForTests(eligibleSnapshot('org-9'));
    mocks.getItemAsync.mockImplementation((key: string) =>
      key === ACTIVE_USER_ID_KEY ? 'u1' : organizationId
    );

    await recoverGlanceableActivityKit();

    expect(surface.activity).toBeNull();
  });

  it.each([ACTIVE_USER_ID_KEY, ORGANIZATION_STORAGE_KEY])('rejects a failed %s read', async key => {
    _setLastGlanceableSnapshotForTests(eligibleSnapshot('org-9'));
    mocks.getItemAsync.mockImplementation((requestedKey: string) => {
      if (requestedKey === key) {
        throw new Error('storage unavailable');
      }
      return requestedKey === ACTIVE_USER_ID_KEY ? 'u1' : 'org-9';
    });

    await recoverGlanceableActivityKit();

    expect(surface.activity).toBeNull();
  });

  it('does not recover on a non-iOS platform', async () => {
    mocks.platform.OS = 'android';

    await recoverGlanceableActivityKit();

    expect(surface.activity).toBeNull();
  });
});

describe.each([ACTIVE_USER_ID_KEY, ORGANIZATION_STORAGE_KEY])(
  'ActivityKit recovery while %s is pending',
  delayedKey => {
    it.each([
      ['logout', writeSignedOutSnapshotAndEnd],
      ['account switch', bumpAuthEpoch],
      ['organization switch', writePrivacySnapshotAndEnd],
    ] as const)('does not restore counts after %s', async (_label, invalidate) => {
      const read = delayIdentityRead(delayedKey);
      const recovering = recoverGlanceableActivityKit();
      await read.started;

      invalidate();
      read.resolve();
      await recovering;

      expect(surface.activity).toBeNull();
      expect(surface.context).toBeNull();
    });

    it('does not recover a captured snapshot after the scope changes', async () => {
      const read = delayIdentityRead(delayedKey);
      const recovering = recoverGlanceableActivityKit();
      await read.started;

      _setLastGlanceableSnapshotForTests(eligibleSnapshot('org-10'));
      read.resolve();
      await recovering;

      expect(surface.activity).toBeNull();
    });

    it.each([0, 7])(
      'preserves newer counts (%s) instead of recovering captured work',
      async running => {
        const read = delayIdentityRead(delayedKey);
        const recovering = recoverGlanceableActivityKit();
        await read.started;

        const latest = { ...eligibleSnapshot(), running, revision: 2 };
        _setLastGlanceableSnapshotForTests(latest);
        sink.publish(latest);
        if (running > 0) {
          sink.startOrUpdate(latest, { userId: 'u1', organizationId: null });
        }
        read.resolve();
        await recovering;

        expect(surface.widget).toEqual(latest);
        expect(surface.activity).toEqual(running > 0 ? latest : null);
      }
    );

    it('still recovers a current authorized snapshot after a delayed read', async () => {
      const read = delayIdentityRead(delayedKey);
      const recovering = recoverGlanceableActivityKit();
      await read.started;
      read.resolve();
      await recovering;

      expect(surface.activity).toEqual(eligibleSnapshot());
      expect(surface.context).toEqual({ userId: 'u1', organizationId: null });
    });
  }
);
