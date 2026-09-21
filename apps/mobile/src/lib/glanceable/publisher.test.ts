/* eslint-disable max-lines -- one cohesive publisher state-machine suite sharing the fake-sink harness */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildGlanceableSnapshot,
  GLANCEABLE_COALESCE_MS,
  GLANCEABLE_SNAPSHOT_EXPIRY_MS,
  GLANCEABLE_STALE_MS,
  type GlanceableAgentsSnapshot,
  isStartableGlanceableWork,
} from '@kilocode/app-shared/glanceable-agents-snapshot';

import { getTerminalBlankEpoch, writeSignedOutSnapshotAndEnd } from './cleanup';
import {
  GLANCEABLE_RENEW_MARGIN_MS,
  GLANCEABLE_RENEW_RETRY_MAX_MS,
  GlanceablePublisher,
  glanceableRenewRetryDelayMs,
  hasSameGlanceableContent,
} from './publisher';
import {
  type GlanceableSink,
  type GlanceableSinkContext,
  registerGlanceableSink,
  unregisterGlanceableSink,
} from './sink-registry';
import { type WaitingAsk } from './waiting-ask';
import { getSurfaceExtras, setSurfaceExtras } from './surface-extras';

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

function withTitle(snapshot: GlanceableAgentsSnapshot, newestSessionTitle: string | null = null) {
  return { snapshot, newestSessionTitle };
}

afterEach(() => {
  vi.useRealTimers();
  setSurfaceExtras({ newestSessionTitle: null, actionFeedback: null });
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
    // `retry` folds into needs-input: both mean the agent cannot go on alone.
    expect(snapshot.needsInput).toBe(2);
    expect(snapshot.idle).toBe(1);
    expect(snapshot.status).toBe('happy');
  });

  it('stores the newest session title in the surface extras, never in the snapshot', () => {
    const { sink, calls } = makeSink();
    const publisher = new GlanceablePublisher({ sinks: [sink], now: () => NOW });
    publisher.handleSessions(
      [
        { status: 'idle', title: 'Older session', updatedAt: '2026-01-01T00:00:00.000Z' },
        { status: 'question', title: 'Newest session', updatedAt: '2026-01-02T00:00:00.000Z' },
      ],
      PUB_CTX
    );

    expect(getSurfaceExtras().newestSessionTitle).toBe('Newest session');
    // The privacy contract: the title rides beside the snapshot, which stays
    // content-free and is what the widget host persists.
    expect(JSON.stringify(lastSnapshot(calls, 'publish'))).not.toContain('Newest session');
    publisher.dispose();
  });

  it('starts the activity immediately on the first eligible emit', () => {
    vi.useFakeTimers();
    const { sink, calls } = makeSink();
    const publisher = new GlanceablePublisher({ sinks: [sink], now: () => NOW });
    publisher.handleSessions([{ status: 'busy' }], PUB_CTX);
    expect(count(calls, 'startOrUpdate')).toBe(1);
    publisher.dispose();
  });

  it('starts the activity when the first tray write matches the seeded snapshot', () => {
    // A restored revision can equal the tray's content, but nothing has raised
    // the surface yet, so the first eligible emit must not be skipped.
    const { sink, calls } = makeSink();
    const publisher = new GlanceablePublisher({
      sinks: [sink],
      now: () => NOW,
      initial: snapshotFor([{ status: 'busy' }], NOW, 0),
    });
    publisher.handleSessions([{ status: 'busy' }], PUB_CTX);
    expect(count(calls, 'startOrUpdate')).toBe(1);
    publisher.dispose();
  });

  it('counts an unrecognized status as running, matching what the row glyph draws', () => {
    // One session, unknown status: the shared kind map folds every non-idle,
    // non-needs-input status into running, and the list row's glyph draws the
    // same kind (`statusKind === 'idle' ? 'idle' : 'running'`), so the tray
    // and the glanceable sinks can never disagree about this session. A row
    // the list draws as working must also be startable work for the Live
    // Activity, and must never be counted idle while it works.
    const { sink, calls } = makeSink();
    const publisher = new GlanceablePublisher({ sinks: [sink], now: () => NOW });
    publisher.handleSessions([{ status: 'mystery' }], PUB_CTX);
    const snapshot = lastSnapshot(calls, 'startOrUpdate');
    expect(snapshot.running).toBe(1);
    expect(snapshot.idle).toBe(0);
    expect(isStartableGlanceableWork(snapshot)).toBe(true);
    publisher.dispose();
  });

  it('coalesces later happy updates but publishes needs-input changes immediately', () => {
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
    // The badge reads `needsInput`, so a change to it skips the coalesce wait.
    publisher.handleSessions([{ status: 'permission' }], PUB_CTX);
    expect(lastSnapshot(calls, 'startOrUpdate').needsInput).toBe(1);
    publisher.handleSessions([{ status: 'busy' }], PUB_CTX);
    expect(lastSnapshot(calls, 'startOrUpdate').needsInput).toBe(0);
    publisher.dispose();
  });

  it('emits an approval transition immediately instead of on the coalesce window', () => {
    // `question` and `permission` both count as needs-input, so `needsInput`
    // stays constant while `needsApproval` (the Approve control gate) changes.
    // The approval transition must not wait for the coalesce window.
    vi.useFakeTimers();
    const { sink, calls } = makeSink();
    const publisher = new GlanceablePublisher({ sinks: [sink], now: () => NOW, coalesceMs: 1000 });
    publisher.handleSessions([{ status: 'question' }], PUB_CTX);
    publisher.handleSessions([{ status: 'permission' }], PUB_CTX);
    expect(count(calls, 'startOrUpdate')).toBe(2);
    publisher.dispose();
  });

  it('emits a cleared approval immediately too', () => {
    vi.useFakeTimers();
    const { sink, calls } = makeSink();
    const publisher = new GlanceablePublisher({ sinks: [sink], now: () => NOW, coalesceMs: 1000 });
    publisher.handleSessions([{ status: 'permission' }], PUB_CTX);
    publisher.handleSessions([{ status: 'question' }], PUB_CTX);
    expect(count(calls, 'startOrUpdate')).toBe(2);
    publisher.dispose();
  });

  it('does not redraw the native surfaces for a heartbeat that changes no visible content', () => {
    vi.useFakeTimers();
    const { sink, calls } = makeSink();
    const publisher = new GlanceablePublisher({ sinks: [sink], now: () => NOW, coalesceMs: 1000 });
    publisher.handleSessions([{ status: 'busy' }], PUB_CTX);
    for (let heartbeat = 0; heartbeat < 50; heartbeat += 1) {
      publisher.handleSessions([{ status: 'busy' }], PUB_CTX);
    }
    vi.advanceTimersByTime(1000);
    // Every heartbeat writes the tray cache, but only the first one changed the
    // surface, so the 50 identical writes must not re-render it and must not
    // rewrite the widget timeline or Live Activity either.
    expect(count(calls, 'startOrUpdate')).toBe(1);
    expect(count(calls, 'publish')).toBe(1);
    publisher.dispose();
  });

  it('renews the deadline on an unchanged heartbeat only once the stale window approaches', () => {
    // Identical heartbeats must still renew before the published deadline
    // lapses: `updatedAt`/`expiresAt`, the widget stale frame, and the Live
    // Activity stale date all key off the write, so never renewing falsely
    // flags confirmed-current data as stale. Renewing on every heartbeat would
    // rewrite the native surface every few seconds, so it waits for the margin.
    vi.useFakeTimers();
    let now = NOW;
    const { sink, calls } = makeSink();
    const publisher = new GlanceablePublisher({ sinks: [sink], now: () => now, coalesceMs: 1000 });
    publisher.handleSessions([{ status: 'busy' }], PUB_CTX);
    const first = lastSnapshot(calls, 'publish');

    // Inside the margin: no write at all, so the heartbeat cannot amplify.
    now += GLANCEABLE_RENEW_MARGIN_MS - 1;
    publisher.handleSessions([{ status: 'busy' }], PUB_CTX);
    expect(count(calls, 'publish')).toBe(1);

    // At the margin the local write renews the deadline well before it lapses.
    now += 1;
    publisher.handleSessions([{ status: 'busy' }], PUB_CTX);
    const renewed = lastSnapshot(calls, 'publish');
    expect(count(calls, 'publish')).toBe(2);
    expect(renewed.revision).toBeGreaterThan(first.revision);
    expect(renewed.updatedAt).toBe(new Date(now).toISOString());
    expect(renewed.expiresAt).toBe(new Date(now + GLANCEABLE_SNAPSHOT_EXPIRY_MS).toISOString());
    expect(Date.parse(renewed.updatedAt)).toBeLessThan(
      Date.parse(first.updatedAt) + GLANCEABLE_STALE_MS
    );
    // The renewal still carries a start/update so a failed or deferred Live
    // Activity start is retried while the counts stay stable; it happens at the
    // renewal margin, never on every heartbeat.
    expect(count(calls, 'startOrUpdate')).toBe(2);
    expect(lastSnapshot(calls, 'startOrUpdate').running).toBe(1);
    publisher.dispose();
  });

  it('retries the Live Activity start on an unchanged heartbeat past the renewal margin', () => {
    // A start the sink could not raise (transient ActivityKit failure, or a
    // start deferred behind a dismissal) must not be stranded: the renewal
    // re-emits it while the visible counts are unchanged.
    vi.useFakeTimers();
    let now = NOW;
    const { sink, calls } = makeSink();
    const publisher = new GlanceablePublisher({ sinks: [sink], now: () => now, coalesceMs: 1000 });
    publisher.handleSessions([{ status: 'permission' }], PUB_CTX);
    expect(count(calls, 'startOrUpdate')).toBe(1);

    now += GLANCEABLE_RENEW_MARGIN_MS;
    publisher.handleSessions([{ status: 'permission' }], PUB_CTX);
    expect(count(calls, 'startOrUpdate')).toBe(2);
    publisher.dispose();
  });

  it('renews at most once per stale margin across many unchanged heartbeats', () => {
    // A 10 s heartbeat for 15 minutes is exactly one renewal, not one native
    // rewrite per heartbeat (the in-app amplification the heat fix removed).
    vi.useFakeTimers();
    let now = NOW;
    const { sink, calls } = makeSink();
    const publisher = new GlanceablePublisher({ sinks: [sink], now: () => now, coalesceMs: 1000 });
    publisher.handleSessions([{ status: 'busy' }], PUB_CTX);
    for (let heartbeat = 0; heartbeat < 90; heartbeat += 1) {
      now += 10_000;
      publisher.handleSessions([{ status: 'busy' }], PUB_CTX);
    }
    expect(count(calls, 'publish')).toBe(2);
    // The single renewal re-emits the start so a failed start is retried; the
    // other 89 heartbeats write nothing.
    expect(count(calls, 'startOrUpdate')).toBe(2);
    publisher.dispose();
  });

  it('spaces a rejected renewal retry with a doubling backoff instead of every heartbeat', () => {
    // The wait doubles from one coalesce window to the five-minute ceiling, so a
    // transient failure is retried promptly and a permanently broken surface is
    // attempted at a bounded rate.
    expect(glanceableRenewRetryDelayMs(0)).toBe(GLANCEABLE_COALESCE_MS);
    expect(glanceableRenewRetryDelayMs(1)).toBe(GLANCEABLE_COALESCE_MS);
    expect(glanceableRenewRetryDelayMs(2)).toBe(2 * GLANCEABLE_COALESCE_MS);
    expect(glanceableRenewRetryDelayMs(20)).toBe(GLANCEABLE_RENEW_RETRY_MAX_MS);

    // A sink that rejects every write never advances the published deadline, so
    // without a bound the unchanged-content renewal would re-emit on every
    // heartbeat.
    vi.useFakeTimers();
    let now = NOW;
    let attempts = 0;
    const sink: GlanceableSink = {
      publish() {
        // This case observes only the start/update attempts.
      },
      startOrUpdate() {
        attempts += 1;
        if (attempts > 1) {
          throw new Error('ActivityKit start failed');
        }
      },
      endImmediate() {
        // The counts never go empty here.
      },
    };
    const publisher = new GlanceablePublisher({ sinks: [sink], now: () => now, coalesceMs: 1000 });
    publisher.handleSessions([{ status: 'busy' }], PUB_CTX);
    expect(attempts).toBe(1);

    // The renewal at the margin is rejected and spends the first backoff: the
    // next attempt waits one coalesce window, not a full renewal margin.
    now += GLANCEABLE_RENEW_MARGIN_MS;
    publisher.handleSessions([{ status: 'busy' }], PUB_CTX);
    expect(attempts).toBe(2);

    // 179 more 10 s heartbeats span another 30 minutes. The retries space out
    // 10 s, 20 s, 40 s ... to the five-minute ceiling, so the whole span takes
    // eleven attempts rather than one per heartbeat.
    for (let heartbeat = 0; heartbeat < 179; heartbeat += 1) {
      now += 10_000;
      publisher.handleSessions([{ status: 'busy' }], PUB_CTX);
    }
    expect(attempts).toBe(11);
    publisher.dispose();
  });

  it('backs off a rejected first write instead of letting every heartbeat through', () => {
    // The restart reconciliation lets the first heartbeat write through even
    // when nothing was published yet. If that first write is rejected, the
    // latch must not keep letting every heartbeat through: the renewal backoff
    // spaces the retries, exactly as it does once a frame has landed.
    vi.useFakeTimers();
    let now = NOW;
    let attempts = 0;
    const sink: GlanceableSink = {
      publish() {
        // This case observes only the start/update attempts.
      },
      startOrUpdate() {
        attempts += 1;
        throw new Error('ActivityKit start failed');
      },
      endImmediate() {
        // The counts never go empty here.
      },
    };
    const publisher = new GlanceablePublisher({ sinks: [sink], now: () => now, coalesceMs: 1000 });
    publisher.handleSessions([{ status: 'busy' }], PUB_CTX);
    expect(attempts).toBe(1);

    // Inside the first backoff a heartbeat must not re-emit.
    now += 1000;
    publisher.handleSessions([{ status: 'busy' }], PUB_CTX);
    expect(attempts).toBe(1);

    // Once the backoff elapses the renewal retries.
    now += GLANCEABLE_COALESCE_MS - 1000;
    publisher.handleSessions([{ status: 'busy' }], PUB_CTX);
    expect(attempts).toBe(2);
    publisher.dispose();
  });

  it('renders the first heartbeat after a restart even when the persisted snapshot matches', () => {
    // The native surfaces outlive the JS process. A death inside the 8 s
    // terminal window leaves the ongoing card in the shade while the persisted
    // snapshot is already empty, so an unchanged empty heartbeat must still
    // reach the sinks: that is where the Android sink dismisses the orphan
    // (`!notificationActive -> endNotification`). Suppressing it strands the
    // card until the counts next change.
    const { sink, calls } = makeSink();
    const restored = snapshotFor([], NOW - 60_000, 7);
    const publisher = new GlanceablePublisher({ sinks: [sink], now: () => NOW, initial: restored });

    publisher.handleSessions([], PUB_CTX);

    expect(count(calls, 'publish')).toBe(1);
    expect(lastSnapshot(calls, 'publish').running).toBe(0);
    publisher.dispose();
  });

  it('does not republish a pending coalesced frame after an unchanged renewal', () => {
    // A content change inside the coalesce window stores a snapshot dated at
    // that change. A renewal heartbeat before the timer fires publishes a newer
    // frame for the same visible content; if the timer then fired, it would
    // republish the older revision/updatedAt and mark the surface stale right
    // after the renewal.
    vi.useFakeTimers();
    let now = NOW;
    const { sink, calls } = makeSink();
    const publisher = new GlanceablePublisher({ sinks: [sink], now: () => now, coalesceMs: 1000 });
    publisher.handleSessions([{ status: 'busy' }], PUB_CTX);

    // A counts-only change at t+1 s is inside the window: coalesced, not emitted.
    now += 1;
    publisher.handleSessions([{ status: 'busy' }, { status: 'busy' }], PUB_CTX);
    expect(count(calls, 'startOrUpdate')).toBe(1);

    // A renewal heartbeat at the margin emits the newer frame for the same content.
    now += GLANCEABLE_RENEW_MARGIN_MS;
    publisher.handleSessions([{ status: 'busy' }, { status: 'busy' }], PUB_CTX);
    const renewed = lastSnapshot(calls, 'startOrUpdate');
    expect(count(calls, 'startOrUpdate')).toBe(2);
    expect(renewed.updatedAt).toBe(new Date(now).toISOString());

    // The pending coalesced frame must not fire after the renewal.
    vi.advanceTimersByTime(1000);
    expect(count(calls, 'startOrUpdate')).toBe(2);
    expect(lastSnapshot(calls, 'startOrUpdate').updatedAt).toBe(renewed.updatedAt);
    expect(lastSnapshot(calls, 'startOrUpdate').running).toBe(2);
    publisher.dispose();
  });

  it('bounds count churn to one native update per window', () => {
    vi.useFakeTimers();
    let now = NOW;
    const { sink, calls } = makeSink();
    const publisher = new GlanceablePublisher({
      sinks: [sink],
      now: () => now,
      coalesceMs: GLANCEABLE_COALESCE_MS,
    });
    publisher.handleSessions([{ status: 'busy' }], PUB_CTX);
    expect(count(calls, 'startOrUpdate')).toBe(1);
    for (let second = 1; second <= 5; second += 1) {
      vi.advanceTimersByTime(1000);
      now += 1000;
      publisher.handleSessions(
        Array.from({ length: second + 1 }, () => ({ status: 'busy' })),
        PUB_CTX
      );
    }
    // Five once-a-second count changes coalesce into the one window's update,
    // not one native re-render per heartbeat.
    expect(count(calls, 'startOrUpdate')).toBe(1);
    publisher.dispose();
  });

  it('still redraws when only the newest session title changes', () => {
    vi.useFakeTimers();
    const { sink, calls } = makeSink();
    const publisher = new GlanceablePublisher({ sinks: [sink], now: () => NOW, coalesceMs: 1000 });
    publisher.handleSessions(
      [{ status: 'busy', title: 'First session', updatedAt: '2026-01-01T00:00:00.000Z' }],
      PUB_CTX
    );
    publisher.handleSessions(
      [{ status: 'busy', title: 'Renamed session', updatedAt: '2026-01-01T00:00:00.000Z' }],
      PUB_CTX
    );
    vi.advanceTimersByTime(1000);
    // The counts are identical, but the widget draws the title, so the rename
    // must still reach the native surface.
    expect(count(calls, 'startOrUpdate')).toBe(2);
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

  it('starts for idle-only sessions but not when no session is connected', () => {
    vi.useFakeTimers();
    const { sink, calls } = makeSink();
    const publisher = new GlanceablePublisher({ sinks: [sink], now: () => NOW });
    publisher.handleSessions([], PUB_CTX);
    expect(count(calls, 'startOrUpdate')).toBe(0);
    expect(lastSnapshot(calls, 'publish').status).toBe('empty');
    vi.advanceTimersByTime(8000);
    expect(count(calls, 'endImmediate')).toBe(0);
    // An idle agent is still connected, so the notch shows it ranked last.
    publisher.handleSessions([{ status: 'idle' }, { status: 'idle' }], PUB_CTX);
    expect(lastSnapshot(calls, 'startOrUpdate')).toMatchObject({ status: 'happy', idle: 2 });
    publisher.dispose();
  });

  it('distinguishes waiting (first fetch) from empty (fetch settled)', () => {
    const { sink, calls } = makeSink();
    const publisher = new GlanceablePublisher({ sinks: [sink], now: () => NOW });
    publisher.handleFetchStarted(PUB_CTX);
    expect(lastSnapshot(calls, 'publish').status).toBe('waiting');
    expect(count(calls, 'startOrUpdate')).toBe(0);
    publisher.handleSessions([], PUB_CTX);
    expect(lastSnapshot(calls, 'publish').status).toBe('empty');
  });

  it('keeps the original deadline through repeated failures and stays expired after it', () => {
    let now = NOW;
    const { sink, calls } = makeSink();
    const publisher = new GlanceablePublisher({ sinks: [sink], now: () => now });
    publisher.handleSessions(
      [{ status: 'busy' }, { status: 'question' }, { status: 'idle' }],
      PUB_CTX
    );
    const successful = lastSnapshot(calls, 'publish');
    const failures = [
      [60_000, 'stale', 1],
      [GLANCEABLE_SNAPSHOT_EXPIRY_MS - 1, 'stale', 1],
      [GLANCEABLE_SNAPSHOT_EXPIRY_MS, 'expired', 0],
      [GLANCEABLE_SNAPSHOT_EXPIRY_MS + 60_000, 'expired', 0],
    ] as const;
    for (const [index, [elapsed, status, expectedCount]] of failures.entries()) {
      now = NOW + elapsed;
      publisher.handleFetchError(PUB_CTX);
      expect(lastSnapshot(calls, 'publish')).toMatchObject({
        revision: index + 2,
        updatedAt: successful.updatedAt,
        expiresAt: successful.expiresAt,
        scopeKey: successful.scopeKey,
        status,
        running: expectedCount,
        needsInput: expectedCount,
        idle: expectedCount,
      });
    }
    expect(lastSnapshot(calls, 'publish').needsInputSince).toBeNull();
    publisher.dispose();
  });

  it.each(['signed_out', 'privacy'] as const)(
    'preserves %s through failures and expiry',
    status => {
      vi.useFakeTimers();
      let now = NOW;
      const { sink, calls } = makeSink();
      const publisher = new GlanceablePublisher({ sinks: [sink], now: () => now });
      const blank = buildGlanceableSnapshot({
        sessions: [],
        userId: 'u1',
        organizationId: null,
        now: NOW,
        status,
      });
      publisher.applySnapshot(blank, PUB_CTX);
      for (const elapsed of [60_000, GLANCEABLE_SNAPSHOT_EXPIRY_MS + 1]) {
        now = NOW + elapsed;
        publisher.handleFetchError(PUB_CTX);
        expect(lastSnapshot(calls, 'publish')).toEqual(blank);
      }
      vi.advanceTimersByTime(8000);
      expect(count(calls, 'endImmediate')).toBe(0);
      publisher.dispose();
    }
  );

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

      // A cache error or success after the blank must not publish or restart.
      publisher.handleFetchError(PUB_CTX);
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
    // The error reposts the last known work itself, so the pending coalesced
    // happy emit must not fire on top of it.
    expect(lastSnapshot(calls, 'startOrUpdate').status).toBe('stale');
    const afterError = count(calls, 'startOrUpdate');
    vi.advanceTimersByTime(1000);
    expect(count(calls, 'startOrUpdate')).toBe(afterError);
    expect(lastSnapshot(calls, 'publish').status).toBe('stale');
    publisher.dispose();
  });

  it('re-posts the durable snapshot when the first refresh fails after a restart', () => {
    // A cold start restores the persisted snapshot but has no cache data; the
    // post itself died with the previous process. The failed refresh must put
    // the card back from the restored counts, not leave the shade empty.
    const { sink, calls } = makeSink();
    const restored = snapshotFor([{ status: 'question' }], NOW - 60_000, 7);
    const publisher = new GlanceablePublisher({ sinks: [sink], now: () => NOW, initial: restored });

    publisher.handleFetchError(PUB_CTX);

    expect(lastSnapshot(calls, 'startOrUpdate')).toMatchObject({
      status: 'stale',
      running: 0,
      needsInput: 1,
    });
    expect(count(calls, 'endImmediate')).toBe(0);
    publisher.dispose();
  });

  it('does not re-post a restored snapshot with no startable work', () => {
    const { sink, calls } = makeSink();
    const restored = snapshotFor([{ status: 'idle' }], NOW - 60_000, 7);
    const publisher = new GlanceablePublisher({ sinks: [sink], now: () => NOW, initial: restored });

    publisher.handleFetchError(PUB_CTX);

    expect(count(calls, 'startOrUpdate')).toBe(0);
    publisher.dispose();
  });

  it('does not resurrect a card the terminal end already retired', () => {
    vi.useFakeTimers();
    const { sink, calls } = makeSink();
    const publisher = new GlanceablePublisher({ sinks: [sink], now: () => NOW });
    publisher.handleSessions([{ status: 'busy' }], PUB_CTX);
    publisher.handleSessions([], PUB_CTX);
    vi.advanceTimersByTime(8000);
    expect(count(calls, 'endImmediate')).toBe(1);

    publisher.handleFetchError(PUB_CTX);

    expect(count(calls, 'startOrUpdate')).toBe(1);
    expect(count(calls, 'endImmediate')).toBe(1);
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

  it('renews the deadline on successful data while keeping seeded revisions monotonic', () => {
    let now = NOW;
    const { sink, calls } = makeSink();
    const initial = snapshotFor([{ status: 'busy' }], NOW - 60_000, 41);
    const publisher = new GlanceablePublisher({ sinks: [sink], now: () => now, initial });
    publisher.handleFetchError(PUB_CTX);
    publisher.handleSessions([{ status: 'question' }], PUB_CTX);
    const fresh = lastSnapshot(calls, 'startOrUpdate');
    expect(fresh).toMatchObject({
      revision: 44,
      status: 'happy',
      running: 0,
      needsInput: 1,
      updatedAt: new Date(NOW).toISOString(),
      expiresAt: new Date(NOW + GLANCEABLE_SNAPSHOT_EXPIRY_MS).toISOString(),
    });
    now = Date.parse(initial.expiresAt);
    publisher.handleFetchError(PUB_CTX);
    expect(lastSnapshot(calls, 'publish')).toEqual({ ...fresh, revision: 45, status: 'stale' });
    publisher.dispose();
  });
});

describe('hasSameGlanceableContent', () => {
  const busy = (previousRevision: number, now = NOW) =>
    buildGlanceableSnapshot({
      sessions: [{ status: 'busy' }],
      userId: 'u1',
      organizationId: null,
      now,
      previousRevision,
    });

  it('ignores revision and timestamps but compares every visible field', () => {
    const first = busy(0);
    const nextRevision = busy(1, NOW + 5000);
    expect(nextRevision.revision).toBe(2);
    expect(hasSameGlanceableContent(withTitle(first), withTitle(nextRevision))).toBe(true);
    // The widget draws the newest title, so a title-only change still differs.
    expect(
      hasSameGlanceableContent(withTitle(first, 'First'), withTitle(nextRevision, 'Renamed'))
    ).toBe(false);

    const moreRunning = buildGlanceableSnapshot({
      sessions: [{ status: 'busy' }, { status: 'busy' }],
      userId: 'u1',
      organizationId: null,
      now: NOW + 5000,
      previousRevision: 1,
    });
    expect(hasSameGlanceableContent(withTitle(first), withTitle(moreRunning))).toBe(false);
  });

  it('compares the approval count, the wait anchor, and the status', () => {
    const question = buildGlanceableSnapshot({
      sessions: [{ status: 'question' }],
      userId: 'u1',
      organizationId: null,
      now: NOW,
    });
    const permission = buildGlanceableSnapshot({
      sessions: [{ status: 'permission' }],
      userId: 'u1',
      organizationId: null,
      now: NOW,
    });
    // Same needsInput total, but only one of the two can be approved.
    expect(question.needsInput).toBe(permission.needsInput);
    expect(hasSameGlanceableContent(withTitle(question), withTitle(permission))).toBe(false);
    expect(
      hasSameGlanceableContent(withTitle(question), withTitle({ ...question, status: 'stale' }))
    ).toBe(false);
    expect(
      hasSameGlanceableContent(
        withTitle(question),
        withTitle({ ...question, needsInputSince: '2026-01-01T00:00:00.000Z' })
      )
    ).toBe(false);
  });
});

describe('GlanceablePublisher waiting ask', () => {
  function makePublisher(overrides: { terminalBlankEpoch?: () => number } = {}) {
    const asks: (WaitingAsk | null)[] = [];
    const publisher = new GlanceablePublisher({
      sinks: [],
      now: () => NOW,
      ...overrides,
      onWaitingAskChange: ask => {
        asks.push(ask);
      },
    });
    return { publisher, asks };
  }

  it('reports the oldest waiting ask, then null when the rows go empty', () => {
    const { publisher, asks } = makePublisher();
    publisher.handleSessions(
      [
        { id: 'newer', status: 'question', statusUpdatedAt: new Date(NOW - 1000).toISOString() },
        {
          id: 'older',
          status: 'permission',
          statusUpdatedAt: new Date(NOW - 60_000).toISOString(),
        },
      ],
      PUB_CTX
    );
    expect(asks).toHaveLength(1);
    expect(asks.at(-1)).toMatchObject({
      kiloSessionId: 'older',
      status: 'permission',
      isCloudAgent: false,
      recordedAt: NOW,
    });

    // Busy-only rows carry no permission or question: nothing is asking.
    publisher.handleSessions([{ id: 'busy', status: 'busy' }], PUB_CTX);
    expect(asks.at(-1)).toBeNull();
    publisher.handleSessions([], PUB_CTX);
    expect(asks.at(-1)).toBeNull();
    publisher.dispose();
  });

  it('skips the already-actioned session so the next waiting ask is recorded', () => {
    const { sink, calls } = makeSink();
    const asks: (WaitingAsk | null)[] = [];
    const rows = [
      {
        id: 'answered',
        status: 'permission',
        statusUpdatedAt: new Date(NOW - 60_000).toISOString(),
      },
      { id: 'next', status: 'permission', statusUpdatedAt: new Date(NOW - 1000).toISOString() },
    ];

    // The answered row is the oldest, so without the skip it wins the selection.
    const unskipped = new GlanceablePublisher({
      sinks: [],
      now: () => NOW,
      onWaitingAskChange: ask => {
        asks.push(ask);
      },
    });
    unskipped.handleSessions(rows, PUB_CTX);
    expect(asks.at(-1)).toMatchObject({ kiloSessionId: 'answered' });
    unskipped.dispose();

    const publisher = new GlanceablePublisher({
      sinks: [sink],
      now: () => NOW,
      skipWaitingAskSessionId: 'answered',
      onWaitingAskChange: ask => {
        asks.push(ask);
      },
    });
    publisher.handleSessions(rows, PUB_CTX);
    // The next waiting row is recorded instead, so its action stays reachable.
    expect(asks.at(-1)).toMatchObject({ kiloSessionId: 'next', status: 'permission' });
    // The skipped row still counts: the snapshot still comes from the tray.
    expect(lastSnapshot(calls, 'startOrUpdate').needsInput).toBe(2);
    publisher.dispose();
  });

  it('clears the ask on a fetch error', () => {
    const { publisher, asks } = makePublisher();
    publisher.handleSessions([{ id: 'waiting', status: 'permission' }], PUB_CTX);
    expect(asks.at(-1)).toMatchObject({ kiloSessionId: 'waiting' });

    publisher.handleFetchError(PUB_CTX);
    expect(asks.at(-1)).toBeNull();
    publisher.dispose();
  });

  it('reports null while the publisher is gated after a terminal blank', () => {
    const { publisher, asks } = makePublisher({ terminalBlankEpoch: getTerminalBlankEpoch });
    publisher.handleSessions([{ id: 'waiting', status: 'permission' }], PUB_CTX);
    expect(asks.at(-1)).toMatchObject({ kiloSessionId: 'waiting' });

    writeSignedOutSnapshotAndEnd();
    publisher.handleSessions([{ id: 'waiting', status: 'permission' }], PUB_CTX);
    expect(asks).toHaveLength(2);
    expect(asks.at(-1)).toBeNull();
    publisher.dispose();
  });

  it('keeps working without an ask consumer', () => {
    const { sink, calls } = makeSink();
    const publisher = new GlanceablePublisher({ sinks: [sink], now: () => NOW });
    publisher.handleSessions([{ id: 'waiting', status: 'permission' }], PUB_CTX);
    expect(count(calls, 'startOrUpdate')).toBe(1);
    publisher.dispose();
  });
});
