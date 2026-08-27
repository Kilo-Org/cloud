/* eslint-disable max-lines -- one cohesive sink + view-props suite sharing the expo-widgets/@expo/ui mock harness */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildGlanceableSnapshot,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { type GlanceableLiveActivityContentState } from '@kilocode/notifications';

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
import { buildGlanceableViewProps, type GlanceableViewProps } from './view-props';

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
  instances: [] as unknown[],
  started: [] as { props: unknown; url?: string }[],
  updated: [] as unknown[],
  snapshots: [] as unknown[],
  timelines: [] as { date: Date; props: unknown }[][],
  ended: [] as { policy: unknown; props?: unknown; contentDate?: unknown }[],
  updatePromise: null as Promise<void> | null,
}));

vi.mock('expo-widgets', () => ({
  after: (date: Date) => ({ after: date }),
  createLiveActivity: () => ({
    start: (props: unknown, url?: string) => {
      if (mockState.startError !== null) {
        const error = new Error(mockState.startError.message) as Error & { code: string };
        error.code = mockState.startError.code;
        throw error;
      }
      mockState.started.push({ props, url });
      return {
        update: async (next: unknown) => {
          mockState.updated.push(next);
          if (mockState.updatePromise !== null) {
            await mockState.updatePromise;
          }
        },
        end: (policy: unknown, finalProps?: unknown, contentDate?: unknown) => {
          mockState.ended.push({ policy, props: finalProps, contentDate });
        },
      };
    },
    getInstances: () => {
      if (mockState.instancesError !== null) {
        const error = new Error(mockState.instancesError.message) as Error & { code: string };
        error.code = mockState.instancesError.code;
        throw error;
      }
      return mockState.instances;
    },
  }),
  createWidget: () => ({
    updateSnapshot: (props: unknown) => {
      mockState.snapshots.push(props);
    },
    updateTimeline: (entries: { date: Date; props: unknown }[]) => {
      mockState.timelines.push(entries);
    },
    reload: () => undefined,
    getTimeline: () => [],
  }),
}));

const NOW = 1_750_000_000_000;
const CTX = { userId: 'u1', organizationId: null };

const delivery = {
  registerTokens: vi.fn(),
  unregisterTokens: vi.fn().mockResolvedValue({ ok: true, tokens: [] }),
};

function snapshotFor(
  sessions: { status: string }[],
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
  _resetIosSinkForTests();
  mockState.startError = null;
  mockState.instancesError = null;
  mockState.instances = [];
  mockState.started = [];
  mockState.updated = [];
  mockState.snapshots = [];
  mockState.timelines = [];
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
  it('starts once and updates the same activity on a newer revision', () => {
    iosSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 0), CTX);
    iosSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 1), CTX);

    expect(mockState.started.length).toBe(1);
    expect(mockState.updated.length).toBe(1);
    expect(delivery.registerTokens).toHaveBeenCalledTimes(1);
    expect(delivery.unregisterTokens).not.toHaveBeenCalled();
  });

  it('discards an older revision without overwriting the newest props', () => {
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
    expect(mockState.ended.length).toBe(1);
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
  it('ends with a contentDate not older than the last native write', () => {
    const writeTime = NOW + 120_000;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(writeTime));
    iosSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 0), CTX);

    iosSink.endImmediate();

    const contentDate = mockState.ended[0]?.contentDate as Date | undefined;
    expect(contentDate).toBeInstanceOf(Date);
    // The snapshot's updatedAt (NOW) is older than the write wall-clock; an end
    // carrying NOW instead would be discarded by ActivityKit.
    expect(contentDate?.getTime()).toBe(writeTime);
  });

  it('unregisters tokens even when no activity handle exists', () => {
    mockState.instances = [];

    iosSink.endImmediate();

    expect(mockState.ended.length).toBe(0);
    expect(delivery.unregisterTokens).toHaveBeenCalledTimes(1);
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
    expect(delivery.unregisterTokens).toHaveBeenCalledTimes(1);
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
    let resolveUpdate: () => void = undefined as unknown as () => void;
    mockState.updatePromise = new Promise<void>(resolve => {
      resolveUpdate = resolve;
    });
    iosSink.publish(snapshotFor([], 1, 'empty'));

    const nativeWriteTime = NOW + 50;
    vi.setSystemTime(new Date(nativeWriteTime));
    resolveUpdate();

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

  it('adopts and ends a leftover activity when the handle is null after restart', () => {
    mockState.instances = [
      {
        update: (next: unknown) => {
          mockState.updated.push(next);
        },
        end: (policy: unknown, props?: unknown, contentDate?: unknown) =>
          mockState.ended.push({ policy, props, contentDate }),
      },
    ];

    iosSink.endImmediate();

    expect(mockState.ended.length).toBe(1);
    expect(mockState.ended[0]?.policy).toBe('immediate');
    expect(delivery.unregisterTokens).toHaveBeenCalledTimes(1);
  });

  it('ends after the 8s terminal window when work becomes empty', async () => {
    vi.useFakeTimers();
    const publisher = new GlanceablePublisher({ sinks: [iosSink], now: () => NOW });

    publisher.handleSessions([{ status: 'busy' }], CTX);
    expect(mockState.started.length).toBe(1);
    expect(mockState.ended.length).toBe(0);

    publisher.handleSessions([{ status: 'idle' }], CTX);
    expect(mockState.ended.length).toBe(0);

    vi.advanceTimersByTime(8000);
    await vi.waitFor(() => {
      expect(mockState.ended.length).toBe(1);
    });
    expect(mockState.ended[0]?.policy).toBe('immediate');
    publisher.dispose();
  });
});

describe('iosSink widget publish', () => {
  it('writes a live snapshot plus one expired frame at expiresAt with zero counts', () => {
    const happy = snapshotFor([{ status: 'busy' }], 0);

    iosSink.publish(happy);

    expect(mockState.snapshots.length).toBe(1);
    const entries = mockState.timelines[0];
    expect(entries).toHaveLength(2);
    const expired = entries?.[1];
    expect(expired?.date.getTime()).toBe(Date.parse(happy.expiresAt));

    const expiredProps = expired?.props as GlanceableViewProps;
    expect(expiredProps.countLines).toEqual([]);
    expect(expiredProps.primaryCount).toBe(0);
    expect(expiredProps.statusLine).toBe('Status expired');
    expect(expiredProps.showOpenAgents).toBe(false);
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
      ['stale', [{ status: 'busy' }], "Can't update now", 1, true],
      ['expired', [], 'Status expired', 0, false],
      ['signed_out', [], 'Sign in to see agents', 0, false],
      ['privacy', [], 'Agents hidden', 0, false],
    ];
    for (const [status, sessions, statusLine, counts, showOpenAgents] of cases) {
      iosSink.publish(snapshotFor(sessions, 0, status));
      const props = mockState.snapshots.at(-1) as GlanceableViewProps;
      expect(props.statusLine).toBe(statusLine);
      expect(props.countLines).toHaveLength(counts);
      expect(props.showOpenAgents).toBe(showOpenAgents);
    }
  });
});

describe('iosSink Live Activity content-state', () => {
  it('mirrors the empty content-state without starting a second activity', () => {
    iosSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 0), CTX);
    iosSink.publish(snapshotFor([], 1));

    expect(mockState.started.length).toBe(1);
    const updated = mockState.updated.at(-1) as GlanceableLiveActivityContentState | undefined;
    expect(updated?.status).toBe('empty');
    expect(updated?.running).toBe(0);
    expect(updated?.needsInput).toBe(0);
    expect(updated?.reconnecting).toBe(0);
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

  it('ends an adopted leftover activity when publish receives ineligible work', () => {
    mockState.instances = [
      {
        update: (next: unknown) => mockState.updated.push(next),
        end: (policy: unknown, props?: unknown, contentDate?: unknown) =>
          mockState.ended.push({ policy, props, contentDate }),
      },
    ];

    iosSink.publish(snapshotFor([], 1, 'empty'));

    expect(mockState.ended.length).toBe(1);
    expect(mockState.ended[0]?.policy).toBe('immediate');
    expect(mockState.updated.length).toBe(0);
    expect(delivery.unregisterTokens).toHaveBeenCalledTimes(1);
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
  it('ranks the compact primary count as needs-input, then reconnecting, then running', () => {
    const props = buildGlanceableViewProps(
      snapshotFor(
        [{ status: 'busy' }, { status: 'busy' }, { status: 'retry' }, { status: 'question' }],
        0
      ),
      {},
      key => key
    );
    expect(props.primaryLabel).toBe('glanceable.needsInput');
    expect(props.primaryCount).toBe(1);
    expect(props.countLines.map(line => line.label)).toEqual([
      'glanceable.needsInput',
      'glanceable.reconnecting',
      'glanceable.running',
    ]);
  });

  it('carries no title, organization name, or raw id into the widget JSON', () => {
    // Decouple the eligible-start anchor from `updatedAt` so the assertion below
    // proves the builder copies `eligibleStartedAt` (not `updatedAt`) into
    // `elapsedAnchor`; on a fresh snapshot the two timestamps are equal.
    const snapshot = buildGlanceableSnapshot({
      sessions: [{ status: 'busy' }],
      userId: 'user-9f3a-leak',
      organizationId: 'org-acme-7-leak',
      now: NOW,
      previousEligibleStartedAt: new Date(NOW - 60_000).toISOString(),
    });

    const props = buildGlanceableViewProps(snapshot, {}, key => key);
    const json = JSON.stringify(props);

    expect(Object.keys(props).toSorted()).toEqual([
      'accessibilityLabel',
      'countLines',
      'elapsedAnchor',
      'openAgentsLabel',
      'primaryCount',
      'primaryLabel',
      'showOpenAgents',
      'statusLine',
    ]);
    expect(json).not.toContain('user-9f3a-leak');
    expect(json).not.toContain('org-acme-7-leak');
    expect(json).not.toContain(snapshot.scopeKey);
    expect(json).not.toContain(snapshot.updatedAt);
    expect(json).not.toContain('revision');
    expect(json).not.toContain('title');
  });

  it('shows the elapsed anchor for stale with eligible counts', () => {
    const stale = snapshotFor([{ status: 'busy' }], 1, 'stale');
    const props = buildGlanceableViewProps(stale, {}, key => key);

    expect(props.elapsedAnchor).toBe(stale.eligibleStartedAt);
  });

  it('hides the elapsed anchor when no eligible counts exist', () => {
    const props = buildGlanceableViewProps(snapshotFor([], 1, 'empty'), {}, key => key);

    expect(props.elapsedAnchor).toBeNull();
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
