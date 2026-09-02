import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildGlanceableSnapshot,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { type GlanceableLiveActivityContentState } from '@kilocode/notifications';

type NativeRecord = {
  id: string;
  state: 'active' | 'stale' | 'ended' | 'dismissed';
  props: Partial<GlanceableLiveActivityContentState>;
  dismissAt: number | null;
  updateGate: Promise<void> | null;
  endGate: Promise<void> | null;
  endSubmitted: (() => void) | null;
  policies: string[];
};

// Model only the native boundary. The sink and expo-widgets adapter remain real.
// These records survive JS module recreation, not a native process restart.
const native = vi.hoisted(() => {
  const records: NativeRecord[] = [];
  const ignoredUpdates: string[] = [];
  const snapshots: unknown[] = [];
  const failures = { info: false };
  function add(props: string): NativeRecord {
    const record: NativeRecord = {
      id: `activity-${records.length}`,
      state: 'active',
      props: JSON.parse(props) as Partial<GlanceableLiveActivityContentState>,
      dismissAt: null,
      updateGate: null,
      endGate: null,
      endSubmitted: null,
      policies: [],
    };
    records.push(record);
    return record;
  }
  function wrap(record: NativeRecord) {
    return {
      getInfo: () => {
        if (failures.info) {
          throw new Error('Native state temporarily unavailable');
        }
        return { id: record.id, state: record.state };
      },
      getPushToken: async () => {
        await Promise.resolve();
        return `token-${record.id}`;
      },
      addListener: () => ({ remove: () => undefined }),
      update: async (props: string) => {
        await record.updateGate;
        if (record.state === 'active' || record.state === 'stale') {
          record.props = JSON.parse(props) as Partial<GlanceableLiveActivityContentState>;
        } else {
          ignoredUpdates.push(record.id);
        }
      },
      // eslint-disable-next-line max-params -- match the expo-widgets native bridge
      end: async (policy: string, afterDate?: number, props?: string, _contentDate?: number) => {
        record.policies.push(policy);
        record.endSubmitted?.();
        await record.endGate;
        // Ended content cannot update again; immediate dismissal can remove it.
        if (record.state === 'active' || record.state === 'stale') {
          record.props = JSON.parse(props ?? '{}') as Partial<GlanceableLiveActivityContentState>;
        }
        record.state = policy === 'immediate' ? 'dismissed' : 'ended';
        record.dismissAt = policy === 'immediate' ? Date.now() : (afterDate ?? null);
      },
    };
  }
  return { records, ignoredUpdates, snapshots, failures, add, wrap };
});

vi.mock('expo-widgets', async () => {
  const { after } = await import('expo-widgets/src/Widgets');
  return { after, widgetsDirectory: 'file:///app-group/ExpoWidgets/' };
});
vi.mock('expo-widgets/src/ExpoWidgets', () => ({
  default: {
    LiveActivityFactory: function LiveActivityFactory() {
      return {
        start: (props: string) => native.wrap(native.add(props)),
        getInstances: (includeEnded = false) =>
          native.records
            .filter(record =>
              includeEnded
                ? record.state !== 'dismissed'
                : record.state === 'active' || record.state === 'stale'
            )
            .toReversed()
            .map(record => native.wrap(record)),
      };
    },
  },
}));
vi.mock('./active-agents-live-activity', async () => {
  const { LiveActivityFactory } = await import('expo-widgets/src/Widgets');
  return {
    ActiveAgentsLiveActivity: new LiveActivityFactory('ActiveAgentsLiveActivity', () => ({
      banner: null,
    })),
  };
});
vi.mock('./active-agents-widget', () => ({
  ActiveAgentsWidget: {
    updateSnapshot: (props: unknown) => native.snapshots.push(props),
    updateTimeline: () => undefined,
  },
}));

const NOW = Date.parse('2026-01-02T00:00:00Z');
const CTX = { userId: 'u1', organizationId: null };

function snapshot(sessions: { status: string }[], revision = 0): GlanceableAgentsSnapshot {
  return buildGlanceableSnapshot({
    ...CTX,
    sessions,
    now: NOW + revision,
    previousRevision: revision,
    previousEligibleStartedAt: new Date(NOW - 60_000).toISOString(),
  });
}

async function loadSink() {
  const { iosSink } = await import('./ios-sink');
  const { registerGlanceableSink } = await import('@/lib/glanceable/sink-registry');
  registerGlanceableSink(iosSink);
  return iosSink;
}

function firstActivity(): NativeRecord {
  const record = native.records[0];
  if (!record) {
    throw new Error('The native activity was not created');
  }
  return record;
}

function remoteEnd(record: NativeRecord): void {
  record.state = 'ended';
  record.props = { status: 'empty', running: 0, needsInput: 0, idle: 0 };
  record.dismissAt = Date.now() + 8000;
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  native.records.length = 0;
  native.ignoredUpdates.length = 0;
  native.snapshots.length = 0;
  native.failures.info = false;
});
afterEach(() => vi.useRealTimers());

describe('native adapter recovery', () => {
  it.each(['publish then start', 'start only'])(
    'recovers a remotely ended cached handle through %s without an empty Expo publication',
    async path => {
      const sink = await loadSink();
      sink.startOrUpdate(snapshot([{ status: 'busy' }]), CTX);
      remoteEnd(firstActivity());
      const fresh = snapshot([{ status: 'busy' }, { status: 'idle' }], 2);
      if (path === 'publish then start') {
        sink.publish(fresh);
      }
      sink.startOrUpdate(fresh, CTX);
      await Promise.resolve();

      expect(native.records.filter(record => record.state === 'active')).toMatchObject([
        {
          props: {
            running: 1,
            idle: 1,
            eligibleStartedAt: new Date(NOW - 60_000).toISOString(),
          },
        },
      ]);
      expect(native.records).toHaveLength(2);
      expect(native.ignoredUpdates).toEqual([]);
      expect(firstActivity().props.running).toBe(0);
    }
  );

  it('adopts fresh native work instead of updating the remotely ended cached handle', async () => {
    const sink = await loadSink();
    sink.startOrUpdate(snapshot([{ status: 'busy' }]), CTX);
    remoteEnd(firstActivity());
    const adopted = native.add(JSON.stringify({ running: 9 }));
    const fresh = snapshot([{ status: 'question' }], 2);
    sink.publish(fresh);
    sink.startOrUpdate(fresh, CTX);
    await Promise.resolve();

    expect(native.records).toHaveLength(2);
    expect(adopted).toMatchObject({ state: 'active', props: { needsInput: 1, running: 0 } });
    expect(native.ignoredUpdates).toEqual([]);
  });

  it('excludes only the pending native ID when discovery recreates wrappers', async () => {
    const sink = await loadSink();
    sink.startOrUpdate(snapshot([{ status: 'busy' }]), CTX);
    const update = Promise.withResolvers<undefined>();
    firstActivity().updateGate = update.promise;
    sink.publish(snapshot([{ status: 'busy' }], 1));
    sink.publish(snapshot([], 2));
    const adopted = native.add(JSON.stringify({ running: 9 }));
    const fresh = snapshot([{ status: 'question' }], 3);
    sink.publish(fresh);
    sink.startOrUpdate(fresh, CTX);
    update.resolve(undefined);
    await sink.waitForNativeTerminal?.();

    expect(native.records).toHaveLength(2);
    expect(firstActivity()).toMatchObject({ state: 'ended', dismissAt: NOW + 8000 });
    expect(adopted).toMatchObject({ state: 'active', props: { needsInput: 1, running: 0 } });
  });

  it('retries a failed native state read without duplicating or updating an unverified handle', async () => {
    const sink = await loadSink();
    sink.startOrUpdate(snapshot([{ status: 'busy' }]), CTX);
    native.failures.info = true;
    sink.startOrUpdate(snapshot([{ status: 'question' }], 1), CTX);
    expect(firstActivity().props).toMatchObject({ running: 1, needsInput: 0 });
    native.failures.info = false;
    sink.startOrUpdate(snapshot([{ status: 'question' }], 2), CTX);
    await Promise.resolve();

    expect(native.records).toHaveLength(1);
    expect(firstActivity().props).toMatchObject({ running: 0, needsInput: 1 });
  });
});

describe('native adapter terminal privacy', () => {
  it.each([
    ['local', 'privacy'],
    ['local', 'signed_out'],
    ['remote', 'privacy'],
    ['remote', 'signed_out'],
  ] as const)('dismisses %s terminal content after JS restart for %s', async (source, status) => {
    const sink = await loadSink();
    sink.startOrUpdate(snapshot([{ status: 'busy' }]), CTX);
    if (source === 'local') {
      sink.publish(snapshot([], 1));
      await sink.waitForNativeTerminal?.();
    } else {
      remoteEnd(firstActivity());
    }
    expect(firstActivity().dismissAt).toBe(NOW + 8000);

    vi.resetModules();
    const restarted = await loadSink();
    const cleanup = await import('@/lib/glanceable/cleanup');
    if (status === 'privacy') {
      cleanup.writePrivacySnapshotAndEnd();
    } else {
      cleanup.writeSignedOutSnapshotAndEnd();
    }
    await restarted.waitForNativeTerminal?.();

    expect(firstActivity()).toMatchObject({ state: 'dismissed', dismissAt: NOW });
    expect(native.snapshots.at(-1)).toMatchObject({ primaryCount: 0 });
    // Omitted, not null: UserDefaults rejects a null value. See toWidgetProps.
    expect(Object.values(native.snapshots.at(-1) ?? {})).not.toContain(null);
    expect(native.ignoredUpdates).toEqual([]);
  });

  it('orders privacy after an older submitted end without dismissing new-scope work', async () => {
    const sink = await loadSink();
    sink.startOrUpdate(snapshot([{ status: 'busy' }]), CTX);
    const end = Promise.withResolvers<undefined>();
    const submitted = Promise.withResolvers<undefined>();
    firstActivity().endGate = end.promise;
    firstActivity().endSubmitted = () => {
      submitted.resolve(undefined);
    };
    sink.publish(snapshot([], 1));
    await submitted.promise;
    const cleanup = await import('@/lib/glanceable/cleanup');
    cleanup.writePrivacySnapshotAndEnd();
    const ctx = { userId: 'u2', organizationId: 'new-org' };
    const fresh = buildGlanceableSnapshot({ ...ctx, sessions: [{ status: 'question' }], now: NOW });
    sink.publish(fresh);
    sink.startOrUpdate(fresh, ctx);
    end.resolve(undefined);
    await sink.waitForNativeTerminal?.();

    expect(firstActivity()).toMatchObject({
      state: 'dismissed',
      dismissAt: NOW,
      policies: ['after', 'immediate'],
    });
    expect(native.records.filter(record => record.state === 'active')).toMatchObject([
      { props: { needsInput: 1, running: 0 } },
    ]);
    expect(native.records).toHaveLength(2);
  });
});
