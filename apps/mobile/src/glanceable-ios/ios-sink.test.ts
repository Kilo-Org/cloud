/* eslint-disable max-lines -- one cohesive sink + view-props suite sharing the expo-widgets/@expo/ui mock harness */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildGlanceableSnapshot,
  GLANCEABLE_STALE_MS,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { type GlanceableLiveActivityContentState } from '@kilocode/notifications';

import {
  _resetLiveActivitySwitchForTests,
  setLiveActivityEnabledValue,
} from '@/lib/glanceable/live-activity-switch';
import {
  _resetGlanceablePersistForTests,
  _setGlanceableRestoreUnavailableForTests,
  _setLastGlanceableSnapshotForTests,
  _setSecureStoreForTests,
  restorePersistedGlanceable,
} from '@/lib/glanceable/persist';
import { setSurfaceExtras } from '@/lib/glanceable/surface-extras';
import { writeSignedOutSnapshotAndEnd } from '@/lib/glanceable/cleanup';
import { GlanceablePublisher } from '@/lib/glanceable/publisher';
import {
  registerGlanceableSink,
  setGlanceableDelivery,
  unregisterGlanceableSink,
} from '@/lib/glanceable/sink-registry';
import {
  _resetWaitingAskForTests,
  recordWaitingAsk,
  type WaitingAsk,
} from '@/lib/glanceable/waiting-ask';

import {
  _resetIosSinkForTests,
  adoptNativeActivity,
  clearActivityKitDeniedIfAvailable,
  getActivityKitDenied,
  iosSink,
  renderStoredSnapshotWithNotice,
  setGlanceableActionNotice,
  sweepStrayActivities,
} from './ios-sink';
import {
  buildExpiredWidgetProps,
  buildGlanceableLiveActivityContentState,
  buildGlanceableViewProps,
  type GlanceableViewProps,
  staleTimelineFrame,
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
// The sink used to watch AppState for idle-end debounce. Keep the mock so
// leftover listeners in this suite still resolve.
const mockAppState = vi.hoisted(() => ({
  currentState: 'active' as string,
  listeners: new Set<(state: string) => void>(),
  leaveActive(next: string) {
    this.currentState = next;
    for (const listener of this.listeners) {
      listener(next);
    }
  },
}));

vi.mock('react-native', () => ({
  PlatformColor: (name: string) => name,
  AppState: {
    get currentState() {
      return mockAppState.currentState;
    },
    addEventListener: (_type: string, listener: (state: string) => void) => {
      mockAppState.listeners.add(listener);
      return { remove: () => mockAppState.listeners.delete(listener) };
    },
  },
}));

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

// Fake SecureStore surface so the persisted-snapshot read never loads the
// native module; the notice path reads the mirror a background press leaves.
const secureStore = new Map<string, string>();
const secureStoreMock = {
  setItemAsync: async (key: string, value: string) => {
    secureStore.set(key, value);
    await Promise.resolve();
  },
  getItemAsync: async (key: string) => {
    await Promise.resolve();
    return secureStore.get(key) ?? null;
  },
};

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

/** How many of the given native cards were asked to end. */
function endedCount(cards: { end: ReturnType<typeof vi.fn> }[]): number {
  return cards.filter(card => card.end.mock.calls.length > 0).length;
}

beforeEach(() => {
  _resetLiveActivitySwitchForTests();
  _resetIosSinkForTests();
  _resetGlanceablePersistForTests();
  _resetWaitingAskForTests();
  _resetGlanceablePersistForTests();
  secureStore.clear();
  _setSecureStoreForTests(secureStoreMock);
  mockAppState.currentState = 'active';
  mockAppState.listeners.clear();
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
    expect(mockState.snapshots.at(-1)).toMatchObject({ statusLine: 'No agents waiting' });
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

    // The replacement waits behind the older card's dismissal, so it opens on
    // the newest counts instead of raising the stale ones and updating after.
    expect(mockState.started).toMatchObject([
      { ended: true, props: { status: 'empty', running: 0, needsInput: 0 } },
      { ended: false, props: { status: 'happy', running: 0, needsInput: 2 } },
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

  it('registers the update token of a card this process did not start', async () => {
    const ended: string[] = [];
    // Two cards a server that could never reach the first one raised by push.
    for (const name of ['first', 'second']) {
      mockState.instances.push({
        getPushToken: vi.fn().mockResolvedValue(`${name}-token`),
        end: () => ended.push(name),
      });
    }

    adoptNativeActivity(snapshotFor([{ status: 'busy' }]), CTX);
    await iosSink.waitForNativeTerminal?.();

    expect(delivery.registerTokens).toHaveBeenCalledTimes(1);
    expect(subscriptions).toContain('activity');
    // Whichever one survives, the Lock Screen is left holding exactly one card.
    expect(ended).toHaveLength(1);
  });

  it('registers nothing when no card is on screen', () => {
    adoptNativeActivity(snapshotFor([{ status: 'busy' }]), CTX);

    expect(delivery.registerTokens).not.toHaveBeenCalled();
    expect(mockState.started).toEqual([]);
  });

  it('leaves a card alone while the in-app switch is off', () => {
    setLiveActivityEnabledValue(false);
    mockState.instances.push({ getPushToken: vi.fn().mockResolvedValue('token'), end: vi.fn() });

    adoptNativeActivity(snapshotFor([{ status: 'busy' }]), CTX);

    expect(delivery.registerTokens).not.toHaveBeenCalled();
  });

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
      expect(mockState.timeline[0]?.props).toMatchObject({
        primaryCount: 1,
        primaryKind: 'running',
      });
      const expired = mockState.timeline.at(-1);
      expect(expired?.date.getTime()).toBe(Date.parse(snapshot.expiresAt));

      const expiredProps = expired?.props as GlanceableViewProps;
      expect(expiredProps.countLines).toEqual([]);
      expect(expiredProps.primaryCount).toBe(0);
      expect(expiredProps.statusLine).toBe('Status expired');
      // Omitted, not null: UserDefaults rejects a null value. See toWidgetProps.
      expect(expiredProps.primaryKind).toBeUndefined();
    }
  );

  it('stops calling happy counts current once a stale window passes with no refresh', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const snapshot = snapshotFor([{ status: 'busy' }]);

    iosSink.publish(snapshot);

    // WidgetKit owns this clock: the app may be force quit, and then no
    // background wake ever arrives to correct the frame it is showing.
    expect(mockState.timeline.map(entry => entry.date.getTime())).toEqual([
      NOW,
      NOW + GLANCEABLE_STALE_MS,
      Date.parse(snapshot.expiresAt),
    ]);
    expect(mockState.timeline[1]?.props).toMatchObject({
      statusLine: "Can't update now",
      primaryCount: 1,
      primaryKind: 'running',
    });
  });

  it('retracts nothing on a surface that asserts no counts', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    iosSink.publish(snapshotFor([]));

    expect(mockState.timeline).toHaveLength(2);
    expect(mockState.timeline[0]?.props).toMatchObject({ statusLine: 'No agents waiting' });
  });

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
      // The empty surface is the one that offers `New agent`, so its copy says
      // that instead of the generic no-work copy.
      ['empty', [], 'No agents waiting', 0, false],
      // Stale draws rows, and all three draw whenever rows draw, so the
      // surface never reflows as work moves between states.
      ['stale', [{ status: 'busy' }], "Can't update now", 4, true],
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

  it('writes the newest-result fields for the large card and drops them on locked frames', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const newestAt = new Date(NOW - 180_000).toISOString();
    iosSink.publish(snapshotFor([{ status: 'question', statusUpdatedAt: newestAt }]));

    // Every publish replaces the snapshot and the timeline, so a state change
    // repaints the card at once; no timer carries the newest result.
    const happy = mockState.snapshots.at(-1) as Partial<GlanceableViewProps>;
    expect(happy).toMatchObject({
      newestResultKind: 'needsInput',
      newestResultLabel: 'Needs input',
      newestResultAt: newestAt,
    });

    // The stale frame keeps the counts and the delayed copy; the layout prefers
    // that copy over a relative time claiming freshness the snapshot lost.
    const stale = mockState.timeline[1]?.props as Partial<GlanceableViewProps>;
    expect(stale).toMatchObject({
      statusLine: "Can't update now",
      newestResultKind: 'needsInput',
      newestResultAt: newestAt,
    });

    iosSink.publish(snapshotFor([], 1, 'empty'));
    const empty = mockState.snapshots.at(-1) as Partial<GlanceableViewProps>;
    expect(empty.newestResultKind).toBeUndefined();
    expect(empty.newestResultLabel).toBeUndefined();
    expect(empty.newestResultAt).toBeUndefined();
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

describe('iosSink Approve gate', () => {
  const recordedAsk = (overrides: Partial<WaitingAsk> = {}): WaitingAsk => ({
    kiloSessionId: 'session-1',
    status: 'permission',
    isCloudAgent: true,
    scopeKey: 'scope',
    organizationId: null,
    userId: 'u1',
    recordedAt: NOW,
    ...overrides,
  });

  it('carries canApprove only while a cloud-agent permission ask waits', () => {
    recordWaitingAsk(recordedAsk());
    iosSink.startOrUpdate(snapshotFor([{ status: 'permission' }], 0), CTX);
    expect(mockState.started.at(-1)?.props).toMatchObject({ canApprove: true });

    // A question ask resolves to `none`, so the layout must not offer Approve.
    recordWaitingAsk(recordedAsk({ status: 'question' }));
    iosSink.startOrUpdate(snapshotFor([{ status: 'question' }], 1), CTX);
    expect(mockState.updated.at(-1)).toMatchObject({ canApprove: false });

    // A legacy wrapper session has no single approval either.
    recordWaitingAsk(recordedAsk({ isCloudAgent: false }));
    iosSink.startOrUpdate(snapshotFor([{ status: 'permission' }], 2), CTX);
    expect(mockState.updated.at(-1)).toMatchObject({ canApprove: false });

    recordWaitingAsk(null);
    iosSink.startOrUpdate(snapshotFor([{ status: 'permission' }], 3), CTX);
    expect(mockState.updated.at(-1)).toMatchObject({ canApprove: false });
  });

  it('carries the flag through a publish update', () => {
    recordWaitingAsk(recordedAsk());
    iosSink.startOrUpdate(snapshotFor([{ status: 'permission' }], 0), CTX);

    recordWaitingAsk(null);
    iosSink.publish(snapshotFor([{ status: 'permission' }], 1));
    expect(mockState.updated.at(-1)).toMatchObject({ canApprove: false });

    recordWaitingAsk(recordedAsk());
    iosSink.publish(snapshotFor([{ status: 'permission' }], 2));
    expect(mockState.updated.at(-1)).toMatchObject({ canApprove: true });
  });
});

describe('iosSink approve-failed notice', () => {
  const recordedAsk = (overrides: Partial<WaitingAsk> = {}): WaitingAsk => ({
    kiloSessionId: 'session-1',
    status: 'permission',
    isCloudAgent: true,
    scopeKey: 'scope',
    organizationId: null,
    userId: 'u1',
    recordedAt: NOW,
    ...overrides,
  });

  const stored = () => snapshotFor([{ status: 'permission' }], 1);

  it('draws the failure line on the stored snapshot when the press cannot reach the backend', async () => {
    // The press runs with the app closed, so the only snapshot it has is the
    // persisted one: the counts already on the card, plus the failure line.
    recordWaitingAsk(recordedAsk());
    _setLastGlanceableSnapshotForTests(stored());
    iosSink.startOrUpdate(snapshotFor([{ status: 'permission' }], 0), CTX);

    setGlanceableActionNotice("Couldn't approve. Tap Approve to try again.");
    await renderStoredSnapshotWithNotice();

    expect(mockState.updated.at(-1)).toMatchObject({
      needsInput: 1,
      canApprove: true,
      notice: "Couldn't approve. Tap Approve to try again.",
    });
  });

  it('renders nothing when no snapshot was ever published', async () => {
    recordWaitingAsk(recordedAsk());
    _setLastGlanceableSnapshotForTests(null);

    setGlanceableActionNotice('failed');
    await renderStoredSnapshotWithNotice();

    expect(mockState.started).toEqual([]);
    expect(mockState.updated).toEqual([]);
  });

  it('does not finish a background notice render before ActivityKit applies it', async () => {
    recordWaitingAsk(recordedAsk());
    _setLastGlanceableSnapshotForTests(stored());
    iosSink.startOrUpdate(snapshotFor([{ status: 'permission' }], 0), CTX);
    const update = Promise.withResolvers<undefined>();
    mockState.updatePromise = update.promise;
    setGlanceableActionNotice('failed');
    let finished = false;
    const render = (async () => {
      await renderStoredSnapshotWithNotice();
      finished = true;
    })();

    try {
      await vi.waitFor(() => {
        expect(mockState.updated).toHaveLength(1);
      });
      expect(finished).toBe(false);
      expect(mockState.started[0]?.props).not.toHaveProperty('notice');
    } finally {
      update.resolve(undefined);
      await render;
    }

    expect(finished).toBe(true);
    expect(mockState.started[0]?.props).toMatchObject({ notice: 'failed', canApprove: true });
  });

  it('drops the notice when a different ask is recorded', () => {
    recordWaitingAsk(recordedAsk());
    setGlanceableActionNotice('failed');
    recordWaitingAsk(recordedAsk({ kiloSessionId: 'session-2' }));

    iosSink.startOrUpdate(stored(), CTX);

    // A failure line must never describe the ask that replaced it.
    expect(mockState.started.at(-1)?.props).not.toHaveProperty('notice');
  });

  it('reports a rejected native notice update to the interaction error handler', async () => {
    recordWaitingAsk(recordedAsk());
    _setLastGlanceableSnapshotForTests(stored());
    iosSink.startOrUpdate(snapshotFor([{ status: 'permission' }], 0), CTX);
    const update = Promise.withResolvers<undefined>();
    mockState.updatePromise = update.promise;
    setGlanceableActionNotice('failed');
    const render = renderStoredSnapshotWithNotice();

    await vi.waitFor(() => {
      expect(mockState.updated).toHaveLength(1);
    });
    const rejected = expect(render).rejects.toThrow('native notice update failed');
    update.reject(new Error('native notice update failed'));
    await rejected;

    mockState.updatePromise = null;
    await renderStoredSnapshotWithNotice();
    expect(mockState.started[0]?.props).toMatchObject({ notice: 'failed', canApprove: true });
  });

  it('does not start a replacement card when the notice has no native activity to update', async () => {
    recordWaitingAsk(recordedAsk());
    _setLastGlanceableSnapshotForTests(stored());
    setGlanceableActionNotice('failed');

    await renderStoredSnapshotWithNotice();

    expect(mockState.started).toEqual([]);
    expect(mockState.updated).toEqual([]);
  });

  it('drops the notice once no work needs input', () => {
    recordWaitingAsk(recordedAsk());
    setGlanceableActionNotice('failed');
    iosSink.publish(snapshotFor([], 1, 'empty'));

    iosSink.startOrUpdate(stored(), CTX);

    expect(mockState.started.at(-1)?.props).not.toHaveProperty('notice');
  });

  it('keeps the notice when an older revision is discarded unrendered', () => {
    recordWaitingAsk(recordedAsk());
    iosSink.startOrUpdate(snapshotFor([{ status: 'permission' }], 0), CTX);
    setGlanceableActionNotice('failed');

    // The revision guard drops this snapshot without rendering it: it must not
    // prune the line the card on screen is still carrying (its zero needs-input
    // count would clear the notice).
    const stale = {
      ...snapshotFor([{ status: 'busy' }], 0),
      updatedAt: new Date(NOW - 60_000).toISOString(),
    };
    iosSink.startOrUpdate(stale, CTX);
    expect(mockState.updated).toEqual([]);

    iosSink.startOrUpdate(snapshotFor([{ status: 'permission' }], 1), CTX);

    expect(mockState.updated.at(-1)).toMatchObject({ canApprove: true, notice: 'failed' });
  });
});

describe('iosSink idle updates', () => {
  it('keeps the same card when every agent goes idle', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    iosSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 0), CTX);
    iosSink.publish(snapshotFor([{ status: 'idle' }], 1));
    await vi.advanceTimersByTimeAsync(0);

    expect(mockState.started).toHaveLength(1);
    expect(mockState.started[0]).toMatchObject({
      ended: false,
      props: { status: 'happy', running: 0, idle: 1 },
    });
    expect(mockState.ended).toEqual([]);
  });

  it('updates the same card when work resumes after idle', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    iosSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 0), CTX);
    iosSink.publish(snapshotFor([{ status: 'idle' }], 1));
    const resumed = snapshotFor([{ status: 'busy' }], 2);
    iosSink.publish(resumed);
    iosSink.startOrUpdate(resumed, CTX);

    expect(mockState.started).toHaveLength(1);
    expect(mockState.started[0]).toMatchObject({ ended: false, props: { running: 1, idle: 0 } });
    expect(mockState.ended).toEqual([]);
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
  afterEach(() => {
    setSurfaceExtras({ newestSessionTitle: null, actionFeedback: null });
  });

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
      'common.working',
      'common.scheduled',
      'common.idle',
    ]);
  });

  it('carries no organization name or raw id into the widget JSON', () => {
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
      'actions',
      'countLines',
      'needsInputSince',
      'newestResultAt',
      'newestResultKind',
      'newestResultLabel',
      'newestTitle',
      'primaryCount',
      'primaryKind',
      'primaryLabel',
      'scheduledAt',
      'statusLine',
    ]);
    expect(json).not.toContain('user-9f3a-leak');
    expect(json).not.toContain('org-acme-7-leak');
    expect(json).not.toContain(snapshot.scopeKey);
    expect(json).not.toContain(snapshot.updatedAt);
    expect(json).not.toContain('revision');
    // The newest session's title is the one exception the owner granted, and
    // it never rides in the snapshot: without the surface extra there is no
    // title payload at all.
    expect(props.newestTitle).toBeNull();
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

  it('carries a notice only when a caller sets one', () => {
    const waiting = snapshotFor([{ status: 'permission' }], 0);

    // A server-written state and a card with nothing to say omit the field, so
    // the layout draws no line rather than an empty one.
    expect(buildGlanceableLiveActivityContentState(waiting).notice).toBeUndefined();

    expect(buildGlanceableLiveActivityContentState(waiting, true, 'Could not approve').notice).toBe(
      'Could not approve'
    );
  });

  it('speaks the status word, numeric counts, then Open agents', () => {
    const stale = buildGlanceableViewProps(
      snapshotFor([{ status: 'busy' }, { status: 'busy' }, { status: 'question' }], 1, 'stale'),
      {},
      key => key
    );
    expect(stale.accessibilityLabel).toBe(
      'glanceable.stale, 1 glanceable.needsInput, 2 common.working, glanceable.openAgents'
    );

    const happy = buildGlanceableViewProps(snapshotFor([{ status: 'busy' }], 0), {}, key => key);
    expect(happy.accessibilityLabel).toBe('1 common.working, glanceable.openAgents');

    const empty = buildGlanceableSnapshot({
      ...CTX,
      sessions: [],
      now: NOW,
      previousRevision: 1,
      status: 'empty',
    });
    expect(buildGlanceableViewProps(empty, {}, key => key).accessibilityLabel).toBe(
      'glanceable.noneWaiting, glanceable.openAgents'
    );
  });

  it('offers Approve for a permission wait and nothing else', () => {
    const props = buildGlanceableViewProps(
      snapshotFor([{ status: 'permission' }], 0),
      {},
      key => key
    );
    expect(props.actions).toEqual({ approve: true, newAgent: false });
    expect(props.statusLine).toBeNull();
  });

  it.each(['question', 'retry'] as const)(
    'offers no Approve for a %s wait the action cannot answer',
    status => {
      const props = buildGlanceableViewProps(snapshotFor([{ status }], 0), {}, key => key);
      expect(props.actions).toEqual({ approve: false, newAgent: false });
    }
  );

  it('offers no action for a tray that is working and needs nothing', () => {
    const props = buildGlanceableViewProps(snapshotFor([{ status: 'busy' }], 0), {}, key => key);
    expect(props.actions).toEqual({ approve: false, newAgent: false });
  });

  it('offers New agent and none of the others for the empty state', () => {
    const props = buildGlanceableViewProps(snapshotFor([], 1, 'empty'), {}, key => key);
    expect(props.actions).toEqual({ approve: false, newAgent: true });
    expect(props.statusLine).toBe('glanceable.noneWaiting');
  });

  it.each(['waiting', 'expired', 'signed_out', 'privacy'] as const)(
    'offers no action and no title for a locked %s surface',
    status => {
      const props = buildGlanceableViewProps(snapshotFor([], 1, status), {}, key => key);
      expect(props.actions).toEqual({ approve: false, newAgent: false });
      expect(props.newestTitle).toBeNull();
      expect(toWidgetProps(props).actions).toEqual({ approve: false, newAgent: false });
    }
  );

  it('keeps Approve available and names the failure in the reserved slot', () => {
    setSurfaceExtras({
      newestSessionTitle: 'Fix the flaky test',
      actionFeedback: 'couldNotApprove',
    });
    const props = buildGlanceableViewProps(
      snapshotFor([{ status: 'permission' }], 0),
      {},
      key => key
    );
    expect(props.newestTitle).toBe('glanceable.couldNotApprove');
    expect(props.actions).toEqual({ approve: true, newAgent: false });
  });

  it('holds the in-flight action in the reserved slot', () => {
    setSurfaceExtras({ newestSessionTitle: null, actionFeedback: 'approving' });
    const props = buildGlanceableViewProps(
      snapshotFor([{ status: 'question' }], 0),
      {},
      key => key
    );
    expect(props.newestTitle).toBe('glanceable.approving');
  });

  it('composes the newest-session line and drops a null one on the widget write', () => {
    setSurfaceExtras({ newestSessionTitle: 'Fix the flaky test', actionFeedback: null });
    const props = buildGlanceableViewProps(snapshotFor([{ status: 'busy' }], 0), {}, translateCopy);
    expect(props.newestTitle).toBe('Newest: Fix the flaky test');
    expect(toWidgetProps(props)).toMatchObject({ newestTitle: 'Newest: Fix the flaky test' });

    setSurfaceExtras({ newestSessionTitle: null, actionFeedback: null });
    const untitled = buildGlanceableViewProps(
      snapshotFor([{ status: 'busy' }], 0),
      {},
      translateCopy
    );
    expect(untitled.newestTitle).toBeNull();
    expect('newestTitle' in toWidgetProps(untitled)).toBe(false);
  });

  it('inserts a title containing replacement patterns literally', () => {
    setSurfaceExtras({ newestSessionTitle: 'A $& and $` title', actionFeedback: null });
    const props = buildGlanceableViewProps(snapshotFor([{ status: 'busy' }], 0), {}, translateCopy);

    expect(props.newestTitle).toBe('Newest: A $& and $` title');
  });

  it('keeps the title on the stale frame and off the expired and terminal frames', () => {
    setSurfaceExtras({ newestSessionTitle: 'Fix the flaky test', actionFeedback: null });
    const happy = snapshotFor([{ status: 'busy' }], 0);
    // Stale still draws rows, so the reserved slot keeps its line; the expired
    // and terminal frames assert no work at all, title included.
    expect(staleTimelineFrame(happy, translateCopy)[0]?.props.newestTitle).toBe(
      'Newest: Fix the flaky test'
    );
    expect(buildExpiredWidgetProps(happy, key => key).newestTitle).toBeUndefined();
  });

  it('carries the newest-result fact and the label of its count row', () => {
    const newestAt = new Date(NOW - 120_000).toISOString();
    const props = buildGlanceableViewProps(
      snapshotFor([
        { status: 'busy', statusUpdatedAt: new Date(NOW - 600_000).toISOString() },
        { status: 'question', statusUpdatedAt: newestAt },
      ]),
      {},
      key => key
    );

    expect(props.newestResultKind).toBe('needsInput');
    expect(props.newestResultAt).toBe(newestAt);
    // The label is the mapped row's own, not a second translation of the word.
    expect(props.newestResultLabel).toBe('glanceable.needsInput');
    expect(props.newestResultLabel).toBe(
      props.countLines.find(line => line.kind === 'needsInput')?.label
    );
  });

  it('keeps the newest-result fact on the stale frame beside the counts', () => {
    const newestAt = new Date(NOW - 120_000).toISOString();
    const props = buildGlanceableViewProps(
      snapshotFor([{ status: 'question', statusUpdatedAt: newestAt }], 1, 'stale'),
      {},
      key => key
    );

    expect(props.countLines).toHaveLength(4);
    expect(props.statusLine).toBe('glanceable.stale');
    // The layout's footer prefers `statusLine`, but the props still carry the
    // fact so a later fresh publish needs no second build.
    expect(props.newestResultKind).toBe('needsInput');
    expect(props.newestResultAt).toBe(newestAt);
  });

  it('reports no newest result while counts show but no row has a timestamp', () => {
    const props = buildGlanceableViewProps(snapshotFor([{ status: 'busy' }], 0), {}, key => key);
    expect(props.countLines).toHaveLength(4);
    expect(props.newestResultKind).toBeNull();
    expect(props.newestResultLabel).toBeNull();
    expect(props.newestResultAt).toBeNull();
  });

  it('reports no newest result on any locked or waiting frame', () => {
    for (const status of ['waiting', 'empty', 'expired', 'signed_out', 'privacy'] as const) {
      const props = buildGlanceableViewProps(snapshotFor([], 0, status), {}, key => key);
      expect(props.newestResultKind).toBeNull();
      expect(props.newestResultLabel).toBeNull();
      expect(props.newestResultAt).toBeNull();
    }
  });
});

const COPY: Record<string, string> = {
  'glanceable.newestSession': 'Newest: {{title}}',
};

function translateCopy(key: string): string {
  return COPY[key] ?? key;
}

describe('toWidgetProps', () => {
  it('omits every null field so the UserDefaults write cannot throw', () => {
    const props = toWidgetProps(
      buildGlanceableViewProps(snapshotFor([], 1, 'empty'), {}, key => key)
    );

    expect(Object.values(props)).not.toContain(null);
    expect('primaryLabel' in props).toBe(false);
    expect('primaryKind' in props).toBe(false);
    expect('needsInputSince' in props).toBe(false);
    expect('scheduledAt' in props).toBe(false);
    expect('newestResultKind' in props).toBe(false);
    expect('newestResultLabel' in props).toBe(false);
    expect('newestResultAt' in props).toBe(false);
    expect('newestTitle' in props).toBe(false);
    expect(props.statusLine).toBe('glanceable.noneWaiting');
  });

  it('keeps the newest-result fields the large card draws', () => {
    const newestAt = new Date(NOW - 60_000).toISOString();
    const props = toWidgetProps(
      buildGlanceableViewProps(
        snapshotFor([{ status: 'question', statusUpdatedAt: newestAt }], 0),
        {},
        key => key
      )
    );

    expect(props).toMatchObject({
      newestResultKind: 'needsInput',
      newestResultLabel: 'glanceable.needsInput',
      newestResultAt: newestAt,
    });
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
        { kind: 'scheduled', count: 0 },
        { kind: 'idle', count: 0 },
      ],
    });
  });
});

describe('iosSink stray sweep', () => {
  /** A card this process never started, as native discovery reports it. */
  function nativeStray(): { end: ReturnType<typeof vi.fn>; updated: unknown[] } {
    const end = vi.fn();
    const updated: unknown[] = [];
    mockState.instances.push({
      getPushToken: vi.fn().mockResolvedValue(null),
      update: (next: unknown) => updated.push(next),
      end,
    });
    return { end, updated };
  }

  /** A persisted snapshot stamped now, so its claim has not expired. */
  function freshSnapshot(
    sessions: { status: string }[] = [{ status: 'busy' }],
    status?: GlanceableAgentsSnapshot['status']
  ): GlanceableAgentsSnapshot {
    return buildGlanceableSnapshot({
      sessions,
      userId: 'u1',
      organizationId: null,
      now: Date.now(),
      ...(status === undefined ? {} : { status }),
    });
  }

  it('keeps one card and ends the rest on launch while the persisted work claims one', async () => {
    const cards = [nativeStray(), nativeStray(), nativeStray()];
    _setLastGlanceableSnapshotForTests(freshSnapshot());

    sweepStrayActivities();

    await vi.waitFor(() => {
      expect(endedCount(cards)).toBe(2);
    });
    // The single survivor is adopted, never replaced by a second start.
    expect(mockState.started).toHaveLength(0);
  });

  it('keeps one card for an empty unexpired snapshot, for a push-to-start it has not adopted', async () => {
    const cards = [nativeStray(), nativeStray()];
    _setLastGlanceableSnapshotForTests(freshSnapshot([], 'empty'));

    sweepStrayActivities();

    await vi.waitFor(() => {
      expect(endedCount(cards)).toBe(1);
    });
    expect(mockState.started).toHaveLength(0);
  });

  it('ends every card on launch when the persisted claim has expired', async () => {
    const cards = [nativeStray(), nativeStray(), nativeStray()];
    _setLastGlanceableSnapshotForTests({
      ...freshSnapshot(),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    sweepStrayActivities();

    await vi.waitFor(() => {
      expect(endedCount(cards)).toBe(3);
    });
  });

  it('ends every card for an expired snapshot whose expiry was renewed', async () => {
    const cards = [nativeStray(), nativeStray()];
    // `applyExpiry` stamps the lapsed snapshot eight hours out, so the timestamp
    // alone reads as unexpired; the status is what says nothing owns a card.
    _setLastGlanceableSnapshotForTests(freshSnapshot([], 'expired'));

    sweepStrayActivities();

    await vi.waitFor(() => {
      expect(endedCount(cards)).toBe(2);
    });
  });

  it('ends every card on launch when no snapshot claims one', async () => {
    const cards = [nativeStray(), nativeStray()];
    _setLastGlanceableSnapshotForTests(null);

    sweepStrayActivities();

    await vi.waitFor(() => {
      expect(endedCount(cards)).toBe(2);
    });
  });

  it('keeps one card when the persisted owner could not be read', async () => {
    const cards = [nativeStray(), nativeStray()];
    // A locked keychain at launch: the record may name an owner, so the card a
    // push-to-start just raised must not be swept away as if none existed.
    _setLastGlanceableSnapshotForTests(null);
    _setGlanceableRestoreUnavailableForTests(true);

    sweepStrayActivities();

    await vi.waitFor(() => {
      expect(endedCount(cards)).toBe(1);
    });
    expect(mockState.started).toHaveLength(0);
  });

  it('keeps one card while the persisted owner is still being restored', async () => {
    const cards = [nativeStray(), nativeStray()];
    // Launch: the AppState listener can reach the sweep before the SecureStore
    // read lands, so a null in-memory snapshot means "not read yet", not
    // "nothing persisted". The cards the mirror may still name must survive.
    const gate = Promise.withResolvers<null>();
    _setSecureStoreForTests({
      setItemAsync: secureStoreMock.setItemAsync,
      getItemAsync: async () => {
        await gate.promise;
        return null;
      },
    });

    const restore = restorePersistedGlanceable();
    sweepStrayActivities();

    await vi.waitFor(() => {
      expect(endedCount(cards)).toBe(1);
    });
    expect(mockState.started).toHaveLength(0);

    gate.resolve(null);
    await restore;
  });

  it('sweeps again once the deferred restore lands, so an unowned card cannot survive it', async () => {
    const cards = [nativeStray(), nativeStray()];
    // Launch: the foreground edge reaches the sweep before the SecureStore read
    // lands, so the sweep defers with the duplicates collapsed. That read is
    // the only thing that will settle it, and it then reports an empty mirror,
    // so no snapshot owns the surface and the card the sweep kept is unowned.
    // The deferred sweep must run again instead of waiting for some later
    // foreground or publisher update.
    const gate = Promise.withResolvers<null>();
    _setSecureStoreForTests({
      setItemAsync: secureStoreMock.setItemAsync,
      getItemAsync: async () => {
        await gate.promise;
        return null;
      },
    });

    const restore = restorePersistedGlanceable();
    sweepStrayActivities();

    await vi.waitFor(() => {
      expect(endedCount(cards)).toBe(1);
    });

    gate.resolve(null);
    await restore;

    await vi.waitFor(() => {
      expect(endedCount(cards)).toBe(2);
    });
  });

  it('keeps one card while a later restore is in flight, not only the first', async () => {
    const cards = [nativeStray(), nativeStray()];
    // The first restore settles against an empty mirror, so the in-memory
    // snapshot stays null and a caller would read it as "nothing persisted".
    await restorePersistedGlanceable();

    // A later restore re-opens the read window. A sweep landing in it must not
    // read the still-null snapshot as "nothing persisted": the record this read
    // is about to consult may name an owner.
    const gate = Promise.withResolvers<null>();
    _setSecureStoreForTests({
      setItemAsync: secureStoreMock.setItemAsync,
      getItemAsync: async () => {
        await gate.promise;
        return null;
      },
    });
    const restore = restorePersistedGlanceable();
    sweepStrayActivities();

    await vi.waitFor(() => {
      expect(endedCount(cards)).toBe(1);
    });
    expect(mockState.started).toHaveLength(0);

    gate.resolve(null);
    await restore;
  });

  it.each(['signed_out', 'privacy'] as const)(
    'ends every card on launch after a %s blank',
    async status => {
      const cards = [nativeStray(), nativeStray()];
      _setLastGlanceableSnapshotForTests({ ...freshSnapshot(), status });

      sweepStrayActivities();

      await vi.waitFor(() => {
        expect(endedCount(cards)).toBe(2);
      });
    }
  );

  it('ends every card on foreground while the in-app switch is off', async () => {
    const cards = [nativeStray(), nativeStray()];
    _setLastGlanceableSnapshotForTests(freshSnapshot());
    setLiveActivityEnabledValue(false);

    sweepStrayActivities();

    await vi.waitFor(() => {
      expect(endedCount(cards)).toBe(2);
    });
  });

  it('gives the surviving card the current counts instead of starting a second one', async () => {
    const cards = [nativeStray(), nativeStray()];
    _setLastGlanceableSnapshotForTests(freshSnapshot());

    sweepStrayActivities();

    // The sweep is what collapses the duplicates before the publish: without it
    // both stale cards would still hold the surface when the counts arrive.
    await vi.waitFor(() => {
      expect(endedCount(cards)).toBe(1);
    });
    const survivors = cards.filter(card => card.end.mock.calls.length === 0);
    expect(survivors).toHaveLength(1);
    const card = survivors[0];

    iosSink.startOrUpdate(snapshotFor([{ status: 'busy' }, { status: 'busy' }], 1), CTX);

    expect(mockState.started).toHaveLength(0);
    expect(card?.updated).toHaveLength(1);
    expect(card?.updated[0]).toMatchObject({ running: 2 });
  });
});
