/* eslint-disable max-lines -- recovery and privacy regressions share the native ActivityKit harness */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildGlanceableSnapshot,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { type GlanceableLiveActivityContentState } from '@kilocode/notifications';

import { _resetIosSinkForTests, getActivityKitDenied, iosSink } from '@/glanceable-ios/ios-sink';
import { bumpAuthEpoch } from '@/lib/auth/auth-epoch';
import { writePrivacySnapshotAndEnd, writeSignedOutSnapshotAndEnd } from '@/lib/glanceable/cleanup';
import {
  _resetGlanceablePersistForTests,
  _setLastGlanceableSnapshotForTests,
} from '@/lib/glanceable/persist';
import { GlanceablePublisher } from '@/lib/glanceable/publisher';
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
  instancesError: null as Error | null,
  nativeActivity: null as Partial<GlanceableLiveActivityContentState> | null,
}));

vi.mock('react-native', () => ({
  Platform: mocks.platform,
  Alert: { alert: mocks.alert },
  Linking: { openSettings: mocks.openSettings },
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: mocks.getItemAsync,
}));

vi.mock('@/glanceable-ios/active-agents-live-activity', () => ({
  ActiveAgentsLiveActivity: {
    getInstances() {
      if (mocks.instancesError !== null) {
        throw mocks.instancesError;
      }
      return [];
    },
    start(props: Partial<GlanceableLiveActivityContentState>) {
      mocks.nativeActivity = props;
      return {
        async update(next: Partial<GlanceableLiveActivityContentState>) {
          mocks.nativeActivity = next;
          await Promise.resolve();
        },
        async end() {
          mocks.nativeActivity = null;
          await Promise.resolve();
        },
      };
    },
  },
}));

vi.mock('@/glanceable-ios/active-agents-widget', () => ({
  ActiveAgentsWidget: { updateSnapshot: vi.fn(), updateTimeline: vi.fn() },
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

function emptySnapshot(organizationId: string | null = null): GlanceableAgentsSnapshot {
  return buildGlanceableSnapshot({
    sessions: [],
    userId: 'u1',
    organizationId,
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
  _resetIosSinkForTests();
  _setLastGlanceableSnapshotForTests(eligibleSnapshot());
  surface.widget = null;
  surface.activity = null;
  surface.context = null;
  mocks.nativeActivity = null;
  registerGlanceableSink(sink);
  registerGlanceableSink(iosSink);
  mocks.platform.OS = 'ios';
  mocks.getItemAsync.mockImplementation((key: string) =>
    key === ACTIVE_USER_ID_KEY ? 'u1' : null
  );
  mocks.instancesError = Object.assign(new Error('ActivityKit unavailable'), {
    code: 'ERR_LIVE_ACTIVITIES_NOT_SUPPORTED',
  });
  iosSink.startOrUpdate(eligibleSnapshot(), { userId: 'u1', organizationId: null });
  mocks.instancesError = null;
});

afterEach(() => {
  unregisterGlanceableSink(sink);
  unregisterGlanceableSink(iosSink);
});

describe('recoverGlanceableActivityKit', () => {
  it('keeps recovery available after a failed capability probe', async () => {
    mocks.instancesError = new Error('ActivityKit unavailable');

    await recoverGlanceableActivityKit();

    expect(surface.activity).toBeNull();
    expect(getActivityKitDenied()).toBe(true);

    mocks.instancesError = null;
    await recoverGlanceableActivityKit();

    expect(surface.activity).toEqual(eligibleSnapshot());
  });

  it.each([null, emptySnapshot()])(
    'does not start absent or ineligible work: %s',
    async snapshot => {
      _setLastGlanceableSnapshotForTests(snapshot);

      await recoverGlanceableActivityKit();

      expect(surface.activity).toBeNull();
      expect(surface.widget).toBeNull();
      expect(mocks.nativeActivity).toBeNull();
    }
  );

  it.each([null, 'org-9'])(
    'starts new work after idle recovery in scope %s',
    async organizationId => {
      const snapshot = emptySnapshot(organizationId);
      _setLastGlanceableSnapshotForTests(snapshot);
      mocks.getItemAsync.mockImplementation((key: string) =>
        key === ACTIVE_USER_ID_KEY ? 'u1' : organizationId
      );

      await recoverGlanceableActivityKit();

      expect(surface).toEqual({ widget: null, activity: null, context: null });
      expect(mocks.nativeActivity).toBeNull();

      const publisher = new GlanceablePublisher({
        sinks: [iosSink],
        initial: snapshot,
        now: () => NOW,
      });
      publisher.handleSessions([{ status: 'question' }], { userId: 'u1', organizationId });

      expect(mocks.nativeActivity).toMatchObject({
        status: 'happy',
        running: 0,
        needsInput: 1,
        reconnecting: 0,
      });
      publisher.dispose();
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
    expect(getActivityKitDenied()).toBe(true);
  });

  it.each([null, 'org-10'])('rejects the mismatched organization hint %s', async organizationId => {
    _setLastGlanceableSnapshotForTests(eligibleSnapshot('org-9'));
    mocks.getItemAsync.mockImplementation((key: string) =>
      key === ACTIVE_USER_ID_KEY ? 'u1' : organizationId
    );

    await recoverGlanceableActivityKit();

    expect(surface.activity).toBeNull();
    expect(getActivityKitDenied()).toBe(true);
  });

  describe.each([
    ['eligible', eligibleSnapshot],
    ['idle', emptySnapshot],
  ] as const)('%s recovery after storage failures', (_label, snapshotFor) => {
    it.each([
      [null, ACTIVE_USER_ID_KEY],
      [null, ORGANIZATION_STORAGE_KEY],
      ['org-9', ACTIVE_USER_ID_KEY],
      ['org-9', ORGANIZATION_STORAGE_KEY],
    ] as const)(
      'keeps recovery in scope %s after a failed %s read',
      async (organizationId, key) => {
        _setLastGlanceableSnapshotForTests(snapshotFor(organizationId));
        mocks.getItemAsync.mockImplementation(async (requestedKey: string) => {
          await Promise.resolve();
          if (requestedKey === key) {
            throw new Error('storage unavailable');
          }
          return requestedKey === ACTIVE_USER_ID_KEY ? 'u1' : organizationId;
        });

        await recoverGlanceableActivityKit();

        expect(surface.activity).toBeNull();
        expect(getActivityKitDenied()).toBe(true);

        const latest = eligibleSnapshot(organizationId);
        _setLastGlanceableSnapshotForTests(latest);
        mocks.getItemAsync.mockImplementation((requestedKey: string) =>
          requestedKey === ACTIVE_USER_ID_KEY ? 'u1' : organizationId
        );
        await recoverGlanceableActivityKit();

        expect(surface.activity).toEqual(latest);
        expect(surface.context).toEqual({ userId: 'u1', organizationId });
      }
    );
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
      ['logout', writeSignedOutSnapshotAndEnd, eligibleSnapshot],
      ['account switch', bumpAuthEpoch, eligibleSnapshot],
      ['organization switch', writePrivacySnapshotAndEnd, eligibleSnapshot],
      ['idle logout', writeSignedOutSnapshotAndEnd, emptySnapshot],
      ['idle account switch', bumpAuthEpoch, emptySnapshot],
      ['idle organization switch', writePrivacySnapshotAndEnd, emptySnapshot],
    ] as const)('does not restore counts after %s', async (_label, invalidate, snapshotFor) => {
      _setLastGlanceableSnapshotForTests(snapshotFor());
      const read = delayIdentityRead(delayedKey);
      const recovering = recoverGlanceableActivityKit();
      await read.started;

      invalidate();
      read.resolve();
      await recovering;

      expect(surface.activity).toBeNull();
      expect(surface.context).toBeNull();
      expect(getActivityKitDenied()).toBe(true);
    });

    it('keeps recovery available for the new scope after a delayed read', async () => {
      const read = delayIdentityRead(delayedKey);
      const recovering = recoverGlanceableActivityKit();
      await read.started;

      const latest = eligibleSnapshot('org-10');
      _setLastGlanceableSnapshotForTests(latest);
      read.resolve();
      await recovering;

      expect(surface.activity).toBeNull();
      expect(getActivityKitDenied()).toBe(true);

      mocks.getItemAsync.mockImplementation((key: string) =>
        key === ACTIVE_USER_ID_KEY ? 'u1' : 'org-10'
      );
      await recoverGlanceableActivityKit();

      expect(surface.activity).toEqual(latest);
      expect(surface.context).toEqual({ userId: 'u1', organizationId: 'org-10' });
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
        expect(getActivityKitDenied()).toBe(true);

        await recoverGlanceableActivityKit();

        expect(getActivityKitDenied()).toBe(false);
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
