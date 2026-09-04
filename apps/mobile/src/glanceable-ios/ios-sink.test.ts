/* eslint-disable max-lines -- one cohesive sink + view-props suite sharing the expo-widgets/@expo/ui mock harness */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildGlanceableSnapshot,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { type GlanceableLiveActivityContentState } from '@kilocode/notifications';

import {
  _resetLiveActivitySwitchForTests,
  setLiveActivityEnabledValue,
} from '@/lib/glanceable/live-activity-switch';
import { writeSignedOutSnapshotAndEnd } from '@/lib/glanceable/cleanup';
import { GlanceablePublisher } from '@/lib/glanceable/publisher';
import {
  registerGlanceableSink,
  setGlanceableDelivery,
  unregisterGlanceableSink,
} from '@/lib/glanceable/sink-registry';

import {
  _resetIosSinkForTests,
  clearActivityKitDeniedIfAvailable,
  getActivityKitDenied,
  iosSink,
} from './ios-sink';
import {
  buildGlanceableLiveActivityContentState,
  buildGlanceableViewProps,
  type GlanceableViewProps,
  toWidgetProps,
} from './view-props';

// Native surfaces are unreachable under vitest: expo-widgets factories, the
// swift-ui component tree, and react-native are stubbed so the sink is the real
// logic under test.
vi.mock('@expo/ui/swift-ui', () => ({
  Text: () => null,
  VStack: () => null,
  HStack: () => null,
  Spacer: () => null,
}));
vi.mock('@expo/ui/swift-ui/modifiers', () => ({
  accessibilityElement: () => ({}),
  accessibilityLabel: () => ({}),
  containerBackground: () => ({}),
  font: () => ({}),
  foregroundStyle: () => ({}),
  frame: () => ({}),
  widgetURL: () => ({}),
}));
vi.mock('react-native', () => ({ PlatformColor: (name: string) => name }));

const mockState = vi.hoisted(() => ({
  startError: null as { code: string; message: string } | null,
  instancesError: null as { code: string; message: string } | null,
  instances: [] as object[],
  started: [] as { props: unknown; url?: string; ended: boolean; dismissAt: number | null }[],
  updated: [] as unknown[],
  snapshots: [] as unknown[],
  timeline: [] as { date: Date; props: unknown }[],
  ended: [] as { policy: unknown; props?: unknown; contentDate?: unknown }[],
  updatePromise: null as Promise<void> | null,
}));

vi.mock('expo-widgets', () => ({
  after: (date: Date) => ({ after: date }),
  widgetsDirectory: 'file:///app-group/ExpoWidgets/',
  createLiveActivity: () => ({
    start: (props: unknown, url?: string) => {
      if (mockState.startError !== null) {
        const error = new Error(mockState.startError.message) as Error & { code: string };
        error.code = mockState.startError.code;
        throw error;
      }
      const state = { props, url, ended: false, dismissAt: null as number | null };
      const id = `local-${mockState.started.length}`;
      mockState.started.push(state);
      const instance = {
        getInfo: () => ({ id, state: state.ended ? 'ended' : 'active' }),
        getPushToken: vi.fn().mockResolvedValue(null),
        update: async (next: unknown) => {
          mockState.updated.push(next);
          if (mockState.updatePromise !== null) {
            await mockState.updatePromise;
          }
          state.props = next;
        },
        end: (
          policy: 'immediate' | { after: Date },
          finalProps?: unknown,
          contentDate?: unknown
        ) => {
          state.ended = true;
          state.dismissAt = policy === 'immediate' ? Date.now() : policy.after.getTime();
          state.props = finalProps;
          if (policy === 'immediate') {
            mockState.instances = mockState.instances.filter(current => current !== instance);
          }
          mockState.ended.push({ policy, props: finalProps, contentDate });
        },
      };
      mockState.instances.push(instance);
      return instance;
    },
    getInstances: (includeEnded = false) => {
      if (mockState.instancesError !== null) {
        const error = new Error(mockState.instancesError.message) as Error & { code: string };
        error.code = mockState.instancesError.code;
        throw error;
      }
      return mockState.instances
        .map((instance, index) => ({
          getInfo: () => ({ id: `adopted-${index}`, state: 'active' }),
          ...instance,
        }))
        .filter(instance => includeEnded || instance.getInfo().state === 'active');
    },
  }),
  createWidget: () => ({
    updateSnapshot: (props: unknown) => {
      mockState.snapshots.push(props);
      mockState.timeline = [{ date: new Date(), props }];
    },
    updateTimeline: (entries: { date: Date; props: unknown }[]) => {
      mockState.timeline = entries;
    },
    reload: () => undefined,
    getTimeline: () => [],
  }),
}));

const NOW = 1_750_000_000_000;
const CTX = { userId: 'u1', organizationId: null };

const subscriptions = new Set<string>();
const delivery = {
  registerScopeTokens: vi.fn(() => subscriptions.add('scope')),
  registerTokens: vi.fn(() => {
    subscriptions.add('scope');
    subscriptions.add('activity');
  }),
  cleanupTokens: vi.fn((lifetime: 'scope' | 'activity') => {
    subscriptions.delete('activity');
    if (lifetime === 'scope') {
      subscriptions.delete('scope');
    }
  }),
  unregisterTokens: vi.fn().mockImplementation(async () => {
    await Promise.resolve();
    subscriptions.clear();
    return { ok: true, tokens: [] };
  }),
};

function snapshotFor(
  sessions: { status: string; statusUpdatedAt?: string }[],
  revision = 0,
  status?: GlanceableAgentsSnapshot['status']
): GlanceableAgentsSnapshot {
  return buildGlanceableSnapshot({
    sessions,
    userId: 'u1',
    organizationId: null,
    now: NOW,
    previousRevision: revision,
    ...(status === undefined ? {} : { status }),
  });
}

beforeEach(() => {
  _resetLiveActivitySwitchForTests();
  _resetIosSinkForTests();
  subscriptions.clear();
  mockState.startError = null;
  mockState.instancesError = null;
  mockState.instances = [];
  mockState.started = [];
  mockState.updated = [];
  mockState.snapshots = [];
  mockState.timeline = [];
  mockState.ended = [];
  mockState.updatePromise = null;
  setGlanceableDelivery(delivery);
  registerGlanceableSink(iosSink);
  vi.clearAllMocks();
});

afterEach(() => {
  unregisterGlanceableSink(iosSink);
  vi.useRealTimers();
});

describe('iosSink start and update', () => {
  it('registers a session-less scope without a Live Activity and accepts later background work', () => {
    const publisher = new GlanceablePublisher({ sinks: [iosSink], now: () => NOW });
    publisher.handleSessions([], CTX);

    expect(mockState.started).toEqual([]);
    expect(mockState.snapshots.at(-1)).toMatchObject({ statusLine: 'No work in progress' });
    expect(subscriptions).toEqual(new Set(['scope']));

    publisher.applySnapshot(snapshotFor([{ status: 'busy' }], 1), CTX);
    expect(mockState.started).toMatchObject([{ ended: false, props: { running: 1 } }]);
    expect(subscriptions).toEqual(new Set(['scope', 'activity']));
    publisher.dispose();
  });

  it('starts nothing while the in-app switch is off, and starts once it is on', () => {
    setLiveActivityEnabledValue(false);
    iosSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 0), CTX);
    expect(mockState.started).toEqual([]);
    // The widget families are not covered by this switch: they are opt-in by
    // placement, so publish still writes their timeline.
    iosSink.publish(snapshotFor([{ status: 'busy' }], 0));
    expect(mockState.snapshots.at(-1)).toMatchObject({ primaryCount: 1 });

    setLiveActivityEnabledValue(true);
    iosSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 1), CTX);
    expect(mockState.started.length).toBe(1);
  });

  it('starts once and updates the same activity on a newer revision', () => {
    iosSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 0), CTX);
    iosSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 1), CTX);

    expect(mockState.started.length).toBe(1);
    expect(mockState.updated.length).toBe(1);
    expect(subscriptions).toEqual(new Set(['scope', 'activity']));
    expect(delivery.unregisterTokens).not.toHaveBeenCalled();
  });

  it('discards an older revision without overwriting the newest props', async () => {
    const newer = snapshotFor([{ status: 'busy' }], 1);
    const older = {
      ...snapshotFor([{ status: 'busy' }, { status: 'busy' }], 0),
      updatedAt: new Date(NOW - 60_000).toISOString(),
    };
    iosSink.startOrUpdate(newer, CTX);
    iosSink.startOrUpdate(older, CTX);

    expect(mockState.started.length).toBe(1);
    expect(mockState.updated.length).toBe(0);

    iosSink.endImmediate();
    await vi.waitFor(() => {
      expect(mockState.ended.length).toBe(1);
    });
    expect(mockState.ended[0]?.contentDate).toBeInstanceOf(Date);
    expect(
      (mockState.ended[0]?.props as GlanceableLiveActivityContentState | undefined)?.running
    ).toBe(1);
  });

  it('never starts for a waiting snapshot', () => {
    iosSink.startOrUpdate(snapshotFor([], 0, 'waiting'), CTX);

    expect(mockState.started.length).toBe(0);
    expect(delivery.registerTokens).not.toHaveBeenCalled();
  });

  it('sets activityKitDenied and skips the start when ActivityKit is denied', () => {
    mockState.startError = {
      code: 'ERR_LIVE_ACTIVITIES_NOT_SUPPORTED',
      message: 'Live Activities are not supported on this device',
    };

    iosSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 0), CTX);

    expect(mockState.started.length).toBe(0);
    expect(getActivityKitDenied()).toBe(true);
    expect(delivery.registerTokens).not.toHaveBeenCalled();
  });

  it('does not mark ActivityKit denied on a transient start failure and retries later', () => {
    mockState.startError = {
      code: 'ERR_START_LIVE_ACTIVITY',
      message: 'Failed to start live activity: transient',
    };

    iosSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 0), CTX);

    expect(mockState.started.length).toBe(0);
    expect(getActivityKitDenied()).toBe(false);
    expect(delivery.registerTokens).not.toHaveBeenCalled();

    mockState.startError = null;
    iosSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 1), CTX);
    expect(mockState.started.length).toBe(1);
    expect(getActivityKitDenied()).toBe(false);
  });

  it('adopts the newest existing instance instead of starting a second activity', () => {
    mockState.instances = [
      {
        update: (next: unknown) => {
          mockState.updated.push(next);
        },
      },
    ];

    iosSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 0), CTX);

    expect(mockState.started.length).toBe(0);
    expect(mockState.updated.length).toBe(1);
    expect(delivery.registerTokens).toHaveBeenCalledTimes(1);
  });
});

describe('iosSink end', () => {
  it('ends with a contentDate not older than the last native write', async () => {
    const writeTime = NOW + 120_000;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(writeTime));
    iosSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 0), CTX);

    iosSink.endImmediate();
    await vi.waitFor(() => {
      expect(mockState.ended.length).toBe(1);
    });

    const contentDate = mockState.ended[0]?.contentDate as Date | undefined;
    expect(contentDate).toBeInstanceOf(Date);
    // The snapshot's updatedAt (NOW) is older than the write wall-clock; an end
    // carrying NOW instead would be discarded by ActivityKit.
    expect(contentDate?.getTime()).toBeGreaterThanOrEqual(writeTime);
  });

  it('preserves scope delivery when no activity handle exists', async () => {
    mockState.instances = [];
    delivery.registerScopeTokens();

    iosSink.endImmediate();
    await Promise.resolve();

    expect(mockState.ended.length).toBe(0);
    expect(subscriptions).toEqual(new Set(['scope']));
  });

  it('ends immediately on signed-out with a wall-clock contentDate', async () => {
    // The eligible snapshot's updatedAt is the fixed NOW; the native writes run
    // at the faked later wall-clock, so `end` must carry that write time, not
    // the snapshot's logical updatedAt.
    const terminalTime = NOW + 120_000;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(terminalTime));
    iosSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 0), CTX);

    writeSignedOutSnapshotAndEnd();
    await vi.waitFor(() => {
      expect(mockState.ended.length).toBe(1);
    });

    expect(mockState.ended[0]?.policy).toBe('immediate');
    expect(mockState.ended[0]?.contentDate).toBeInstanceOf(Date);
    expect((mockState.ended[0]?.contentDate as Date | undefined)?.getTime()).toBeGreaterThanOrEqual(
      terminalTime
    );
    expect(subscriptions.size).toBe(0);
  });

  it('ends with the wall-clock of the last publish, not the eligible start', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    iosSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 0), CTX);

    const publishTime = NOW + 60_000;
    vi.setSystemTime(new Date(publishTime));
    iosSink.publish(snapshotFor([], 1, 'empty'));
    iosSink.endImmediate();
    await vi.waitFor(() => {
      expect(mockState.ended.length).toBe(1);
    });

    expect(mockState.ended[0]?.policy).toBe('immediate');
    expect((mockState.ended[0]?.contentDate as Date | undefined)?.getTime()).toBeGreaterThanOrEqual(
      publishTime
    );
  });

  it('awaits the in-flight publish update so the end contentDate is not older than the native write', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    iosSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 0), CTX);

    // The native update does not settle at the JS publish stamp: ActivityKit
    // stamps its own later wall-clock at native execution. Simulate that gap.
    const update = Promise.withResolvers<undefined>();
    mockState.updatePromise = update.promise;
    iosSink.publish(snapshotFor([{ status: 'busy' }], 1));
    iosSink.publish(snapshotFor([], 2, 'empty'));

    const nativeWriteTime = NOW + 50;
    vi.setSystemTime(new Date(nativeWriteTime));
    update.resolve(undefined);

    iosSink.endImmediate();
    await vi.waitFor(() => {
      expect(mockState.ended.length).toBe(1);
    });

    const contentDate = mockState.ended[0]?.contentDate as Date | undefined;
    expect(contentDate).toBeInstanceOf(Date);
    // The end must not carry the earlier JS publish stamp (NOW), which ActivityKit
    // discards as older than the native write.
    expect(contentDate?.getTime()).toBeGreaterThanOrEqual(nativeWriteTime);
  });

  it('ends once after the pending update when concurrent ends target the same activity', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    iosSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 0), CTX);

    const update = Promise.withResolvers<undefined>();
    mockState.updatePromise = update.promise;
    iosSink.publish(snapshotFor([{ status: 'busy' }], 1));
    iosSink.publish(snapshotFor([], 2, 'empty'));
    iosSink.endImmediate();
    iosSink.endImmediate();

    await Promise.resolve();
    expect(mockState.started[0]?.ended).toBe(false);
    expect(mockState.ended).toEqual([]);

    const nativeWriteTime = NOW + 50;
    vi.setSystemTime(new Date(nativeWriteTime));
    update.resolve(undefined);
    await vi.waitFor(() => {
      expect(mockState.started[0]?.ended).toBe(true);
    });

    expect(mockState.ended).toEqual([
      {
        policy: 'immediate',
        props: expect.objectContaining({ status: 'empty', running: 0 }),
        contentDate: expect.any(Date),
      },
    ]);
    expect((mockState.ended[0]?.contentDate as Date | undefined)?.getTime()).toBeGreaterThanOrEqual(
      nativeWriteTime
    );
  });

  it('keeps a new activity and its pending update when an older end finishes', async () => {
    iosSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 4), CTX);
    const oldUpdate = Promise.withResolvers<undefined>();
    mockState.updatePromise = oldUpdate.promise;
    iosSink.publish(snapshotFor([{ status: 'busy' }], 5));
    iosSink.publish(snapshotFor([], 6, 'empty'));
    iosSink.endImmediate();

    const newSnapshot = snapshotFor([{ status: 'question' }], 0);
    iosSink.publish(newSnapshot);
    iosSink.startOrUpdate(newSnapshot, CTX);
    const newUpdate = Promise.withResolvers<undefined>();
    mockState.updatePromise = newUpdate.promise;
    iosSink.startOrUpdate(snapshotFor([{ status: 'question' }, { status: 'question' }], 1), CTX);

    oldUpdate.resolve(undefined);
    await vi.waitFor(() => {
      expect(mockState.started[0]?.ended).toBe(true);
    });

    expect(mockState.started).toMatchObject([
      { ended: true, props: { status: 'empty', running: 0, needsInput: 0 } },
      { ended: false, props: { status: 'happy', running: 0, needsInput: 1 } },
    ]);

    // The older end must not reset the new revision or forget its pending update.
    mockState.updatePromise = null;
    iosSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 0), CTX);
    iosSink.endImmediate();
    await Promise.resolve();
    expect(mockState.started[1]?.ended).toBe(false);

    newUpdate.resolve(undefined);
    await vi.waitFor(() => {
      expect(mockState.started[1]?.ended).toBe(true);
    });
    expect(mockState.started).toMatchObject([
      { ended: true, props: { status: 'empty', running: 0, needsInput: 0 } },
      { ended: true, props: { status: 'happy', running: 0, needsInput: 2 } },
    ]);
  });

  it('ends with the terminal props and a fresh date after a pending update rejects', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    iosSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 0), CTX);

    const update = Promise.withResolvers<undefined>();
    mockState.updatePromise = update.promise;
    iosSink.publish(snapshotFor([{ status: 'busy' }], 1));
    iosSink.publish(snapshotFor([], 2, 'empty'));
    iosSink.endImmediate();

    const failureTime = NOW + 50;
    vi.setSystemTime(new Date(failureTime));
    update.reject(new Error('Native update failed'));
    await vi.waitFor(() => {
      expect(mockState.started[0]?.ended).toBe(true);
    });

    expect(mockState.started[0]?.props).toMatchObject({ status: 'empty', running: 0 });
    expect((mockState.ended[0]?.contentDate as Date | undefined)?.getTime()).toBeGreaterThanOrEqual(
      failureTime
    );
  });

  it('adopts and ends a leftover activity when the handle is null after restart', async () => {
    mockState.instances = [
      {
        getPushToken: vi.fn().mockResolvedValue(null),
        update: (next: unknown) => {
          mockState.updated.push(next);
        },
        end: (policy: unknown, props?: unknown, contentDate?: unknown) =>
          mockState.ended.push({ policy, props, contentDate }),
      },
    ];

    iosSink.endImmediate();

    await vi.waitFor(() => {
      expect(mockState.ended.length).toBe(1);
    });
    expect(mockState.ended[0]?.policy).toBe('immediate');
    expect(subscriptions.has('activity')).toBe(false);
  });

  it('ends the native activity even when its token lookup rejects', async () => {
    mockState.instances = [
      {
        getPushToken: vi.fn().mockRejectedValue(new Error('native token unavailable')),
        end: (policy: unknown, props?: unknown, contentDate?: unknown) =>
          mockState.ended.push({ policy, props, contentDate }),
      },
    ];
    delivery.registerScopeTokens();

    iosSink.endImmediate();
    await vi.waitFor(() => {
      expect(mockState.ended.length).toBe(1);
    });

    expect(mockState.ended[0]?.policy).toBe('immediate');
    expect(subscriptions).toEqual(new Set(['scope']));
  });

  it('submits terminal content and native dismissal without running the publisher timer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const publisher = new GlanceablePublisher({ sinks: [iosSink], now: () => NOW });
    publisher.handleSessions([{ status: 'busy' }], CTX);
    publisher.handleSessions([], CTX);
    await iosSink.waitForNativeTerminal?.();

    expect(mockState.started).toMatchObject([
      {
        ended: true,
        dismissAt: NOW + 8000,
        props: { status: 'empty', running: 0, needsInput: 0, idle: 0 },
      },
    ]);
    expect(subscriptions).toEqual(new Set(['scope']));
    publisher.dispose();
  });

  it('keeps the full native terminal window after a delayed update', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    iosSink.startOrUpdate(snapshotFor([{ status: 'busy' }]), CTX);
    const update = Promise.withResolvers<undefined>();
    mockState.updatePromise = update.promise;
    iosSink.publish(snapshotFor([{ status: 'busy' }], 1));
    iosSink.publish(snapshotFor([], 2));
    vi.setSystemTime(NOW + 60_000);
    update.resolve(undefined);
    await iosSink.waitForNativeTerminal?.();

    expect(mockState.started[0]).toMatchObject({
      ended: true,
      dismissAt: NOW + 68_000,
      props: { status: 'empty', running: 0 },
    });
    expect(mockState.ended[0]?.contentDate).toEqual(new Date(NOW + 60_000));
  });

  it('keeps fresh work after an older native dismissal and an older publisher timer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const older = new GlanceablePublisher({ sinks: [iosSink], now: () => NOW });
    older.handleSessions([{ status: 'busy' }], CTX);
    older.handleSessions([], CTX);
    await iosSink.waitForNativeTerminal?.();
    const newer = new GlanceablePublisher({ sinks: [iosSink], now: () => NOW + 1 });
    newer.handleSessions([{ status: 'question' }], CTX);
    await vi.advanceTimersByTimeAsync(8000);

    expect(
      mockState.started.filter(state => state.dismissAt === null || state.dismissAt > Date.now())
    ).toMatchObject([{ ended: false, props: { status: 'happy', needsInput: 1, running: 0 } }]);
    expect(subscriptions).toEqual(new Set(['scope', 'activity']));
    older.dispose();
    newer.dispose();
  });

  it.each(['privacy', 'signed_out'] as const)(
    'dismisses retained terminal handles immediately for %s',
    async status => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      iosSink.startOrUpdate(snapshotFor([{ status: 'busy' }]), CTX);
      iosSink.publish(snapshotFor([], 1));
      await iosSink.waitForNativeTerminal?.();
      expect(mockState.started[0]?.dismissAt).toBe(NOW + 8000);

      iosSink.publish(snapshotFor([], 2, status));
      iosSink.endImmediate();
      await iosSink.waitForNativeTerminal?.();
      expect(mockState.started[0]).toMatchObject({
        dismissAt: NOW,
        props: { status, running: 0, needsInput: 0, idle: 0 },
      });
    }
  );

  it.each(['privacy', 'signed_out'] as const)(
    'removes adopted work as well as a retained terminal handle for %s',
    async status => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      iosSink.startOrUpdate(snapshotFor([{ status: 'busy' }]), CTX);
      iosSink.publish(snapshotFor([], 1));
      await iosSink.waitForNativeTerminal?.();

      let visible = true;
      let content: Partial<GlanceableLiveActivityContentState> = { status: 'happy', running: 4 };
      mockState.instances.push({
        getPushToken: vi.fn().mockResolvedValue('adopted-token'),
        end: (
          policy: 'immediate' | { after: Date },
          props?: Partial<GlanceableLiveActivityContentState>
        ) => {
          visible = policy !== 'immediate';
          content = props ?? {};
        },
      });
      iosSink.publish(snapshotFor([], 2, status));
      await iosSink.waitForNativeTerminal?.();

      expect(visible).toBe(false);
      expect(content).toMatchObject({ status, running: 0, needsInput: 0, idle: 0 });
      expect(mockState.started[0]?.dismissAt).toBe(NOW);
    }
  );

  it('supersedes a pending terminal intent without ending new-scope work', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    iosSink.startOrUpdate(snapshotFor([{ status: 'busy' }]), CTX);
    const update = Promise.withResolvers<undefined>();
    mockState.updatePromise = update.promise;
    iosSink.publish(snapshotFor([{ status: 'busy' }], 1));
    iosSink.publish(snapshotFor([], 2));
    iosSink.publish(snapshotFor([], 3, 'privacy'));
    iosSink.endImmediate();

    mockState.updatePromise = null;
    const ctx = { userId: 'u2', organizationId: 'new-org' };
    const fresh = buildGlanceableSnapshot({
      ...ctx,
      sessions: [{ status: 'question' }],
      now: NOW + 1,
    });
    iosSink.publish(fresh);
    iosSink.startOrUpdate(fresh, ctx);
    update.resolve(undefined);
    await iosSink.waitForNativeTerminal?.();

    expect(mockState.ended).toMatchObject([
      {
        policy: 'immediate',
        props: { status: 'privacy', running: 0, needsInput: 0 },
      },
    ]);
    expect(mockState.started).toMatchObject([
      { ended: true, dismissAt: NOW, props: { status: 'privacy' } },
      { ended: false, dismissAt: null, props: { status: 'happy', needsInput: 1 } },
    ]);
    expect(subscriptions).toEqual(new Set(['scope', 'activity']));
  });

  it('carries the wait only while a row needs input', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const waited = new Date(NOW - 600_000).toISOString();
    const publisher = new GlanceablePublisher({ sinks: [iosSink], now: () => Date.now() });
    publisher.handleSessions([{ status: 'question', statusUpdatedAt: waited }], CTX);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockState.started).toMatchObject([
      { ended: false, props: { needsInput: 1, needsInputSince: waited } },
    ]);

    // The wait clears with the state it described; it is read from the rows, so
    // no stale anchor survives the transition to work that needs nothing.
    vi.setSystemTime(NOW + 60_000);
    publisher.handleSessions([{ status: 'busy' }], CTX);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockState.started).toMatchObject([
      { ended: false, props: { running: 1, needsInput: 0, needsInputSince: null } },
    ]);
    publisher.dispose();
  });
});

describe('iosSink widget publish', () => {
  it.each(['happy', 'stale'] as const)(
    'writes a %s snapshot plus one expired frame at expiresAt with zero counts',
    status => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const snapshot = snapshotFor([{ status: 'busy' }], 0, status);

      iosSink.publish(snapshot);

      expect(mockState.snapshots.length).toBe(1);
      expect(mockState.timeline).toHaveLength(2);
      expect(mockState.timeline[0]?.props).toMatchObject({
        primaryCount: 1,
        primaryKind: 'running',
      });
      const expired = mockState.timeline[1];
      expect(expired?.date.getTime()).toBe(Date.parse(snapshot.expiresAt));

      const expiredProps = expired?.props as GlanceableViewProps;
      expect(expiredProps.countLines).toEqual([]);
      expect(expiredProps.primaryCount).toBe(0);
      expect(expiredProps.statusLine).toBe('Status expired');
      // Omitted, not null: UserDefaults rejects a null value. See toWidgetProps.
      expect(expiredProps.primaryKind).toBeUndefined();
    }
  );

  it.each([
    ['signed_out', 'Sign in to see agents'],
    ['privacy', 'Open Kilo to see agents'],
  ] as const)('keeps %s copy after a previous active timeline expires', (status, statusLine) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const active = snapshotFor([{ status: 'busy' }]);
    iosSink.publish(active);
    expect(mockState.timeline[0]?.props).toMatchObject({ primaryCount: 1 });

    const terminalTime = NOW + 60_000;
    vi.setSystemTime(terminalTime);
    const terminal = buildGlanceableSnapshot({
      ...CTX,
      sessions: [],
      now: terminalTime,
      previousRevision: active.revision,
      status,
    });
    iosSink.publish(terminal);

    for (const time of [
      terminalTime,
      Date.parse(active.expiresAt),
      Date.parse(terminal.expiresAt),
      Date.parse(terminal.expiresAt) + 1,
    ]) {
      vi.setSystemTime(time);
      const visible = mockState.timeline.findLast(entry => entry.date.getTime() <= Date.now());
      expect(visible?.props).toMatchObject({
        statusLine,
        countLines: [],
        primaryCount: 0,
      });
      expect(Object.values(visible?.props ?? {})).not.toContain(null);
    }
    expect(mockState.timeline).toHaveLength(1);
  });

  it('publishes the four-state widget props', () => {
    const cases: [
      GlanceableAgentsSnapshot['status'],
      { status: string }[],
      string,
      number,
      boolean,
    ][] = [
      ['empty', [], 'No work in progress', 0, false],
      // Stale draws rows, and all three draw whenever rows draw, so the
      // surface never reflows as work moves between states.
      ['stale', [{ status: 'busy' }], "Can't update now", 3, true],
      ['expired', [], 'Status expired', 0, false],
      ['signed_out', [], 'Sign in to see agents', 0, false],
      ['privacy', [], 'Open Kilo to see agents', 0, false],
    ];
    for (const [status, sessions, statusLine, counts, hasPrimary] of cases) {
      iosSink.publish(snapshotFor(sessions, 0, status));
      const props = mockState.snapshots.at(-1) as Partial<GlanceableViewProps>;
      expect(props.statusLine).toBe(statusLine);
      expect(props.countLines).toHaveLength(counts);
      expect(props.primaryKind === undefined).toBe(!hasPrimary);
    }
  });
});

describe('iosSink Live Activity content-state', () => {
  it('ends with empty content-state without starting a second activity', async () => {
    iosSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 0), CTX);
    iosSink.publish(snapshotFor([], 1));
    await iosSink.waitForNativeTerminal?.();

    expect(mockState.started).toMatchObject([
      {
        ended: true,
        props: { status: 'empty', running: 0, needsInput: 0, idle: 0 },
      },
    ]);
  });

  it('mirrors the stale content-state with counts onto the Live Activity', () => {
    iosSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 0), CTX);
    iosSink.publish(snapshotFor([{ status: 'busy' }], 1, 'stale'));

    expect(mockState.started.length).toBe(1);
    const updated = mockState.updated.at(-1) as GlanceableLiveActivityContentState | undefined;
    expect(updated?.status).toBe('stale');
    expect(updated?.running).toBe(1);
  });

  it('adopts and updates a leftover activity from publish when the handle is null', () => {
    mockState.instances = [
      {
        update: (next: unknown) => {
          mockState.updated.push(next);
        },
      },
    ];

    iosSink.publish(snapshotFor([{ status: 'busy' }], 1));

    expect(mockState.started.length).toBe(0);
    expect(mockState.ended.length).toBe(0);
    const updated = mockState.updated.at(-1) as GlanceableLiveActivityContentState | undefined;
    expect(updated?.status).toBe('happy');
    expect(updated?.running).toBe(1);
    expect(delivery.registerTokens).not.toHaveBeenCalled();
  });

  it('gives adopted empty work the native terminal window without a publisher timer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockState.instances = [
      {
        getPushToken: vi.fn().mockResolvedValue(null),
        update: (next: unknown) => mockState.updated.push(next),
        end: (policy: unknown, props?: unknown, contentDate?: unknown) =>
          mockState.ended.push({ policy, props, contentDate }),
      },
    ];

    iosSink.publish(snapshotFor([], 1, 'empty'));
    await iosSink.waitForNativeTerminal?.();

    expect(mockState.ended).toMatchObject([
      {
        policy: { after: new Date(NOW + 8000) },
        props: { status: 'empty', running: 0, needsInput: 0, idle: 0 },
        contentDate: new Date(NOW),
      },
    ]);
    expect(mockState.updated.length).toBe(0);
    expect(subscriptions.has('activity')).toBe(false);
  });
});

describe('clearActivityKitDeniedIfAvailable', () => {
  it('returns false when the surface was never denied', () => {
    expect(clearActivityKitDeniedIfAvailable()).toBe(false);
    expect(getActivityKitDenied()).toBe(false);
  });

  it('clears the denied latch and returns true when ActivityKit is available again', () => {
    mockState.startError = {
      code: 'ERR_LIVE_ACTIVITIES_NOT_SUPPORTED',
      message: 'Live Activities are not supported on this device',
    };
    iosSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 0), CTX);
    expect(getActivityKitDenied()).toBe(true);

    expect(clearActivityKitDeniedIfAvailable()).toBe(true);
    expect(getActivityKitDenied()).toBe(false);
  });

  it('keeps the denied latch when the probe still reports unavailability', () => {
    mockState.startError = {
      code: 'ERR_LIVE_ACTIVITIES_NOT_SUPPORTED',
      message: 'Live Activities are not supported on this device',
    };
    iosSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 0), CTX);
    expect(getActivityKitDenied()).toBe(true);

    mockState.startError = null;
    mockState.instancesError = {
      code: 'ERR_LIVE_ACTIVITIES_NOT_SUPPORTED',
      message: 'still unavailable',
    };
    expect(clearActivityKitDeniedIfAvailable()).toBe(false);
    expect(getActivityKitDenied()).toBe(true);
  });
});

describe('buildGlanceableViewProps', () => {
  it('ranks the compact primary count as needs-input, then running, then idle', () => {
    const props = buildGlanceableViewProps(
      snapshotFor(
        [{ status: 'busy' }, { status: 'busy' }, { status: 'idle' }, { status: 'question' }],
        0
      ),
      {},
      key => key
    );
    expect(props.primaryLabel).toBe('glanceable.needsInput');
    expect(props.primaryCount).toBe(1);
    expect(props.countLines.map(line => line.label)).toEqual([
      'glanceable.needsInput',
      'glanceable.running',
      'common.idle',
    ]);
  });

  it('carries no title, organization name, or raw id into the widget JSON', () => {
    // A waiting row with its own status timestamp, so the assertion below
    // covers the one field that carries a time into the widget payload.
    const snapshot = buildGlanceableSnapshot({
      sessions: [{ status: 'question', statusUpdatedAt: new Date(NOW - 60_000).toISOString() }],
      userId: 'user-9f3a-leak',
      organizationId: 'org-acme-7-leak',
      now: NOW,
    });

    const props = buildGlanceableViewProps(snapshot, {}, key => key);
    const json = JSON.stringify(props);

    expect(Object.keys(props).toSorted()).toEqual([
      'accessibilityLabel',
      'countLines',
      'needsInputSince',
      'primaryCount',
      'primaryKind',
      'primaryLabel',
      'statusLine',
    ]);
    expect(json).not.toContain('user-9f3a-leak');
    expect(json).not.toContain('org-acme-7-leak');
    expect(json).not.toContain(snapshot.scopeKey);
    expect(json).not.toContain(snapshot.updatedAt);
    expect(json).not.toContain('revision');
    expect(json).not.toContain('title');
  });

  it('carries the oldest wait through the stale status', () => {
    const waited = new Date(NOW - 600_000).toISOString();
    const stale = snapshotFor([{ status: 'question', statusUpdatedAt: waited }], 1, 'stale');

    // Stale means updates stopped, not that the wait ended, so the Live
    // Activity keeps reporting how long the agent has been blocked. Only that
    // surface carries the wait — no widget family is wide enough for it.
    expect(buildGlanceableLiveActivityContentState(stale).needsInputSince).toBe(waited);
  });

  it('reports no wait unless a row needs input', () => {
    const working = snapshotFor(
      [{ status: 'busy', statusUpdatedAt: new Date(NOW - 600_000).toISOString() }],
      1
    );
    expect(buildGlanceableLiveActivityContentState(working).needsInputSince).toBeNull();

    const empty = snapshotFor([], 1, 'empty');
    expect(buildGlanceableLiveActivityContentState(empty).needsInputSince).toBeNull();
  });

  it('speaks the status word, numeric counts, then Open agents', () => {
    const stale = buildGlanceableViewProps(
      snapshotFor([{ status: 'busy' }, { status: 'busy' }, { status: 'question' }], 1, 'stale'),
      {},
      key => key
    );
    expect(stale.accessibilityLabel).toBe(
      'glanceable.stale, 1 glanceable.needsInput, 2 glanceable.running, glanceable.openAgents'
    );

    const happy = buildGlanceableViewProps(snapshotFor([{ status: 'busy' }], 0), {}, key => key);
    expect(happy.accessibilityLabel).toBe('1 glanceable.running, glanceable.openAgents');

    const empty = buildGlanceableViewProps(snapshotFor([], 1, 'empty'), {}, key => key);
    expect(empty.accessibilityLabel).toBe('glanceable.empty, glanceable.openAgents');
  });
});

describe('toWidgetProps', () => {
  it('omits every null field so the UserDefaults write cannot throw', () => {
    const props = toWidgetProps(
      buildGlanceableViewProps(snapshotFor([], 1, 'empty'), {}, key => key)
    );

    expect(Object.values(props)).not.toContain(null);
    expect('primaryLabel' in props).toBe(false);
    expect('primaryKind' in props).toBe(false);
    expect('needsInputSince' in props).toBe(false);
    expect(props.statusLine).toBe('glanceable.empty');
  });

  it('keeps every non-null field', () => {
    const source = buildGlanceableViewProps(
      snapshotFor([{ status: 'question' }], 0),
      {},
      key => key
    );

    expect(toWidgetProps(source)).toMatchObject({
      primaryLabel: 'glanceable.needsInput',
      primaryKind: 'needsInput',
      primaryCount: 1,
      countLines: [
        { kind: 'needsInput', count: 1 },
        { kind: 'running', count: 0 },
        { kind: 'idle', count: 0 },
      ],
    });
  });
});
