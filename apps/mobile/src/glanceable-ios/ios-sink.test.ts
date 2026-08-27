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

import { _resetIosSinkForTests, getActivityKitDenied, iosSink } from './ios-sink';
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
  instances: [] as unknown[],
  started: [] as { props: unknown; url?: string }[],
  updated: [] as unknown[],
  snapshots: [] as unknown[],
  timelines: [] as { date: Date; props: unknown }[][],
  ended: [] as { policy: unknown; props?: unknown; contentDate?: unknown }[],
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
        update: (next: unknown) => {
          mockState.updated.push(next);
        },
        end: (policy: unknown, finalProps?: unknown, contentDate?: unknown) => {
          mockState.ended.push({ policy, props: finalProps, contentDate });
        },
      };
    },
    getInstances: () => mockState.instances,
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
  mockState.instances = [];
  mockState.started = [];
  mockState.updated = [];
  mockState.snapshots = [];
  mockState.timelines = [];
  mockState.ended = [];
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

  it('discards an older revision without overwriting the newest updatedAt and props', () => {
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
    expect((mockState.ended[0]?.contentDate as Date | undefined)?.getTime()).toBe(
      Date.parse(newer.updatedAt)
    );
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
    mockState.instances = [{ update: (next: unknown) => mockState.updated.push(next) }];

    iosSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 0), CTX);

    expect(mockState.started.length).toBe(0);
    expect(mockState.updated.length).toBe(1);
    expect(delivery.registerTokens).toHaveBeenCalledTimes(1);
  });
});

describe('iosSink end', () => {
  it('ends immediately with contentDate from the last updatedAt on signed-out', () => {
    // The eligible snapshot's updatedAt is the fixed NOW; the signed-out publish
    // must advance `lastUpdatedAt`, so fake a later clock and prove `end` uses
    // the terminal snapshot's timestamp, not the eligible one.
    const terminalTime = NOW + 120_000;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(terminalTime));
    iosSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 0), CTX);

    writeSignedOutSnapshotAndEnd();

    expect(mockState.ended.length).toBe(1);
    expect(mockState.ended[0]?.policy).toBe('immediate');
    expect(mockState.ended[0]?.contentDate).toBeInstanceOf(Date);
    expect((mockState.ended[0]?.contentDate as Date | undefined)?.getTime()).toBe(terminalTime);
    expect(delivery.unregisterTokens).toHaveBeenCalledTimes(1);
  });

  it('ends with the published empty snapshot contentDate, not the eligible one', () => {
    iosSink.startOrUpdate(snapshotFor([{ status: 'busy' }], 0), CTX);

    const later = new Date(NOW + 60_000).toISOString();
    iosSink.publish({ ...snapshotFor([], 1, 'empty'), updatedAt: later });
    iosSink.endImmediate();

    expect(mockState.ended.length).toBe(1);
    expect(mockState.ended[0]?.policy).toBe('immediate');
    expect((mockState.ended[0]?.contentDate as Date | undefined)?.getTime()).toBe(NOW + 60_000);
  });

  it('adopts and ends a leftover activity when the handle is null after restart', () => {
    mockState.instances = [
      {
        update: (next: unknown) => mockState.updated.push(next),
        end: (policy: unknown, props?: unknown, contentDate?: unknown) =>
          mockState.ended.push({ policy, props, contentDate }),
      },
    ];

    iosSink.endImmediate();

    expect(mockState.ended.length).toBe(1);
    expect(mockState.ended[0]?.policy).toBe('immediate');
    expect(delivery.unregisterTokens).toHaveBeenCalledTimes(1);
  });

  it('ends after the 8s terminal window when work becomes empty', () => {
    vi.useFakeTimers();
    const publisher = new GlanceablePublisher({ sinks: [iosSink], now: () => NOW });

    publisher.handleSessions([{ status: 'busy' }], CTX);
    expect(mockState.started.length).toBe(1);
    expect(mockState.ended.length).toBe(0);

    publisher.handleSessions([{ status: 'idle' }], CTX);
    expect(mockState.ended.length).toBe(0);

    vi.advanceTimersByTime(8000);
    expect(mockState.ended.length).toBe(1);
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
    mockState.instances = [{ update: (next: unknown) => mockState.updated.push(next) }];

    iosSink.publish(snapshotFor([], 1, 'empty'));

    expect(mockState.started.length).toBe(0);
    const updated = mockState.updated.at(-1) as GlanceableLiveActivityContentState | undefined;
    expect(updated?.status).toBe('empty');
    expect(delivery.registerTokens).not.toHaveBeenCalled();
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
});
