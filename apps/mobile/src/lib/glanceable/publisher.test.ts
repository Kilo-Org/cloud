import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildGlanceableSnapshot,
  GLANCEABLE_SNAPSHOT_EXPIRY_MS,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';

import { getTerminalBlankEpoch, writeSignedOutSnapshotAndEnd } from './cleanup';
import { GlanceablePublisher } from './publisher';
import {
  type GlanceableSink,
  type GlanceableSinkContext,
  registerGlanceableSink,
  unregisterGlanceableSink,
} from './sink-registry';

const NOW = 1_750_000_000_000;
const PUB_CTX = { userId: 'u1', organizationId: null };

type SinkCall =
  | { type: 'publish'; snapshot: GlanceableAgentsSnapshot }
  | { type: 'startOrUpdate'; snapshot: GlanceableAgentsSnapshot; ctx: GlanceableSinkContext }
  | { type: 'endImmediate' };

function makeSink() {
  const calls: SinkCall[] = [];
  const sink: GlanceableSink = {
    publish(snapshot) {
      calls.push({ type: 'publish', snapshot });
    },
    startOrUpdate(snapshot, ctx) {
      calls.push({ type: 'startOrUpdate', snapshot, ctx });
    },
    endImmediate() {
      calls.push({ type: 'endImmediate' });
    },
  };
  return { sink, calls };
}

function count(calls: SinkCall[], type: SinkCall['type']): number {
  return calls.filter(call => call.type === type).length;
}

function lastSnapshot(
  calls: SinkCall[],
  type: 'publish' | 'startOrUpdate'
): GlanceableAgentsSnapshot {
  const found = [...calls].toReversed().find(call => call.type === type);
  if (found === undefined) {
    throw new Error(`no ${type} call`);
  }
  return (found as { snapshot: GlanceableAgentsSnapshot }).snapshot;
}

function snapshotFor(sessions: { status: string }[], now: number, revision = 0) {
  return buildGlanceableSnapshot({
    sessions,
    userId: 'u1',
    organizationId: null,
    now,
    previousRevision: revision,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('GlanceablePublisher', () => {
  it('derives the count map from the session rows', () => {
    const { sink, calls } = makeSink();
    const publisher = new GlanceablePublisher({ sinks: [sink], now: () => NOW });
    publisher.handleSessions(
      [
        { status: 'busy' },
        { status: 'busy' },
        { status: 'question' },
        { status: 'retry' },
        { status: 'idle' },
      ],
      PUB_CTX
    );
    const snapshot = lastSnapshot(calls, 'startOrUpdate');
    expect(snapshot.running).toBe(2);
    expect(snapshot.needsInput).toBe(1);
    expect(snapshot.reconnecting).toBe(1);
    expect(snapshot.status).toBe('happy');
  });

  it('starts the activity immediately on the first eligible emit', () => {
    vi.useFakeTimers();
    const { sink, calls } = makeSink();
    const publisher = new GlanceablePublisher({ sinks: [sink], now: () => NOW });
    publisher.handleSessions([{ status: 'busy' }], PUB_CTX);
    expect(count(calls, 'startOrUpdate')).toBe(1);
    publisher.dispose();
  });

  it('coalesces later happy updates and emits only the latest', () => {
    vi.useFakeTimers();
    const { sink, calls } = makeSink();
    const publisher = new GlanceablePublisher({ sinks: [sink], now: () => NOW, coalesceMs: 1000 });
    publisher.handleSessions([{ status: 'busy' }], PUB_CTX);
    publisher.handleSessions([{ status: 'busy' }, { status: 'busy' }], PUB_CTX);
    publisher.handleSessions([{ status: 'busy' }, { status: 'busy' }, { status: 'busy' }], PUB_CTX);
    expect(count(calls, 'startOrUpdate')).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(count(calls, 'startOrUpdate')).toBe(2);
    expect(lastSnapshot(calls, 'startOrUpdate').running).toBe(3);
    publisher.dispose();
  });

  it('discards an incoming older revision', () => {
    const { sink, calls } = makeSink();
    const publisher = new GlanceablePublisher({ sinks: [sink], now: () => NOW });
    publisher.applySnapshot(snapshotFor([{ status: 'busy' }], NOW, 4), PUB_CTX);
    const started = count(calls, 'startOrUpdate');
    publisher.applySnapshot(snapshotFor([{ status: 'busy' }], NOW, 2), PUB_CTX);
    expect(count(calls, 'startOrUpdate')).toBe(started);
  });

  it('publishes empty for idle-only sessions without starting or ending', () => {
    vi.useFakeTimers();
    const { sink, calls } = makeSink();
    const publisher = new GlanceablePublisher({ sinks: [sink], now: () => NOW });
    publisher.handleSessions([{ status: 'idle' }, { status: 'idle' }], PUB_CTX);
    expect(count(calls, 'startOrUpdate')).toBe(0);
    expect(lastSnapshot(calls, 'publish').status).toBe('empty');
    vi.advanceTimersByTime(8000);
    expect(count(calls, 'endImmediate')).toBe(0);
    publisher.dispose();
  });

  it('distinguishes waiting (first fetch) from empty (fetch settled)', () => {
    const { sink, calls } = makeSink();
    const publisher = new GlanceablePublisher({ sinks: [sink], now: () => NOW });
    publisher.handleFetchStarted(PUB_CTX);
    expect(lastSnapshot(calls, 'publish').status).toBe('waiting');
    expect(count(calls, 'startOrUpdate')).toBe(0);
    publisher.handleSessions([{ status: 'idle' }], PUB_CTX);
    expect(lastSnapshot(calls, 'publish').status).toBe('empty');
  });

  it('keeps counts on stale and hides counts on expired', () => {
    const { sink, calls } = makeSink();
    const publisher = new GlanceablePublisher({ sinks: [sink], now: () => NOW });
    publisher.handleSessions([{ status: 'busy' }], PUB_CTX);
    publisher.handleFetchError(PUB_CTX);
    expect(lastSnapshot(calls, 'publish').status).toBe('stale');
    expect(lastSnapshot(calls, 'publish').running).toBe(1);

    let now = NOW;
    const { sink: sink2, calls: calls2 } = makeSink();
    const publisher2 = new GlanceablePublisher({ sinks: [sink2], now: () => now });
    publisher2.handleSessions([{ status: 'busy' }], PUB_CTX);
    now = NOW + GLANCEABLE_SNAPSHOT_EXPIRY_MS;
    publisher2.handleSessions([{ status: 'busy' }], PUB_CTX);
    const expired = calls2.filter(
      (call): call is { type: 'publish'; snapshot: GlanceableAgentsSnapshot } =>
        call.type === 'publish' && call.snapshot.status === 'expired'
    );
    expect(expired.length).toBe(1);
    expect(expired[0]?.snapshot.running).toBe(0);
  });

  it('does not schedule the 8s terminal for a signed-out snapshot', () => {
    vi.useFakeTimers();
    const { sink, calls } = makeSink();
    const publisher = new GlanceablePublisher({ sinks: [sink], now: () => NOW });
    publisher.applySnapshot(
      buildGlanceableSnapshot({
        sessions: [],
        userId: 'u1',
        organizationId: null,
        now: NOW,
        status: 'signed_out',
      }),
      PUB_CTX
    );
    vi.advanceTimersByTime(8000);
    expect(count(calls, 'endImmediate')).toBe(0);
    publisher.dispose();
  });

  it('does not publish or restart after a terminal blank', () => {
    const { sink, calls } = makeSink();
    registerGlanceableSink(sink);
    const publisher = new GlanceablePublisher({
      sinks: [sink],
      now: () => NOW,
      terminalBlankEpoch: getTerminalBlankEpoch,
    });
    try {
      publisher.handleSessions([{ status: 'busy' }], PUB_CTX);
      expect(count(calls, 'startOrUpdate')).toBe(1);
      expect(count(calls, 'publish')).toBe(1);

      writeSignedOutSnapshotAndEnd();
      expect(lastSnapshot(calls, 'publish').status).toBe('signed_out');
      expect(count(calls, 'endImmediate')).toBe(1);

      // A live cache success after the blank must not publish or restart.
      publisher.handleSessions([{ status: 'busy' }, { status: 'busy' }], PUB_CTX);
      expect(count(calls, 'startOrUpdate')).toBe(1);
      expect(count(calls, 'publish')).toBe(2);
      expect(lastSnapshot(calls, 'publish').status).toBe('signed_out');
    } finally {
      unregisterGlanceableSink(sink);
      publisher.dispose();
    }
  });

  it('drops a pending coalesced emit after a terminal blank', () => {
    vi.useFakeTimers();
    const { sink, calls } = makeSink();
    const publisher = new GlanceablePublisher({
      sinks: [sink],
      now: () => NOW,
      coalesceMs: 1000,
      terminalBlankEpoch: getTerminalBlankEpoch,
    });
    publisher.handleSessions([{ status: 'busy' }], PUB_CTX);
    publisher.handleSessions([{ status: 'busy' }, { status: 'busy' }], PUB_CTX);
    expect(count(calls, 'startOrUpdate')).toBe(1);

    writeSignedOutSnapshotAndEnd();
    vi.advanceTimersByTime(1000);
    expect(count(calls, 'startOrUpdate')).toBe(1);
    publisher.dispose();
  });

  it('cancels a pending coalesced emit on a fetch error', () => {
    vi.useFakeTimers();
    const { sink, calls } = makeSink();
    const publisher = new GlanceablePublisher({ sinks: [sink], now: () => NOW, coalesceMs: 1000 });
    publisher.handleSessions([{ status: 'busy' }], PUB_CTX);
    publisher.handleSessions([{ status: 'busy' }, { status: 'busy' }], PUB_CTX);
    publisher.handleFetchError(PUB_CTX);
    vi.advanceTimersByTime(1000);
    // The pre-error happy emit must not fire after the stale republish.
    expect(count(calls, 'startOrUpdate')).toBe(1);
    expect(lastSnapshot(calls, 'publish').status).toBe('stale');
    publisher.dispose();
  });

  it('does not apply a snapshot after a terminal blank', () => {
    const { sink, calls } = makeSink();
    const publisher = new GlanceablePublisher({
      sinks: [sink],
      now: () => NOW,
      terminalBlankEpoch: getTerminalBlankEpoch,
    });
    writeSignedOutSnapshotAndEnd();
    publisher.applySnapshot(snapshotFor([{ status: 'busy' }], NOW), PUB_CTX);
    expect(count(calls, 'startOrUpdate')).toBe(0);
    expect(count(calls, 'publish')).toBe(0);
    publisher.dispose();
  });

  it('cancels a pending coalesced emit when a newer snapshot applies', () => {
    vi.useFakeTimers();
    const { sink, calls } = makeSink();
    const publisher = new GlanceablePublisher({ sinks: [sink], now: () => NOW, coalesceMs: 1000 });
    publisher.handleSessions([{ status: 'busy' }], PUB_CTX);
    publisher.handleSessions([{ status: 'busy' }, { status: 'busy' }], PUB_CTX);
    publisher.applySnapshot(snapshotFor([{ status: 'busy' }], NOW + 1, 2), PUB_CTX);
    vi.advanceTimersByTime(1000);
    // Only the applied snapshot emits; the older coalesced happy update must not.
    expect(count(calls, 'startOrUpdate')).toBe(2);
    expect(lastSnapshot(calls, 'startOrUpdate').running).toBe(1);
    publisher.dispose();
  });

  it('cancels a pending terminal when a newer snapshot applies', () => {
    vi.useFakeTimers();
    const { sink, calls } = makeSink();
    const publisher = new GlanceablePublisher({ sinks: [sink], now: () => NOW });
    publisher.handleSessions([{ status: 'busy' }], PUB_CTX);
    publisher.handleSessions([{ status: 'idle' }], PUB_CTX);
    publisher.applySnapshot(snapshotFor([{ status: 'busy' }], NOW + 1, 1), PUB_CTX);
    vi.advanceTimersByTime(8000);
    expect(count(calls, 'endImmediate')).toBe(0);
    publisher.dispose();
  });

  it('keeps the revision monotonic when seeded from an initial snapshot', () => {
    const { sink, calls } = makeSink();
    // Seeded with revision 42; the next snapshot must be 43.
    const initial = snapshotFor([{ status: 'busy' }], NOW - 60_000, 41);
    const publisher = new GlanceablePublisher({ sinks: [sink], now: () => NOW, initial });
    publisher.handleSessions([{ status: 'busy' }], PUB_CTX);
    expect(lastSnapshot(calls, 'startOrUpdate').revision).toBe(43);
    publisher.dispose();
  });
});
