import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withDORetry } from '@kilocode/worker-utils';
import {
  createSandboxNotificationDispatcher,
  SANDBOX_NOTIFICATION_LIMITS,
  type NotificationLoss,
  type SandboxNotification,
} from './notifications.js';

const SESSION = 'workspace_11111111-1111-1111-1111-111111111111';
const event = (text: string): Extract<SandboxNotification, { kind: 'events' }> => ({
  kind: 'events',
  payload: { events: [{ type: 'text', properties: { text } }] },
});
const route = (attemptId: string): SandboxNotification => ({
  kind: 'route',
  payload: { state: 'ready', attemptId },
});
const outcome = (sessionId: string): SandboxNotification => ({
  kind: 'outcome',
  payload: { sessionId, status: 'completed', lastMessageId: 'msg' },
});

function harness(hold = true) {
  const calls: { sessionId: string; notification: SandboxNotification; deadlineAt: number }[] = [];
  const releases: (() => void)[] = [];
  const diagnostics: NotificationLoss[] = [];
  let live = 0;
  let peak = 0;
  const liveSessions = new Map<string, number>();
  let peakPerSession = 0;
  const dispatcher = createSandboxNotificationDispatcher({
    budgetMs: () => 2_000,
    diagnostic: loss => diagnostics.push(loss),
    waitUntil: work => {
      void work.catch(error => {
        throw error;
      });
    },
    send: async (sessionId, notification, deadlineAt, signal) => {
      live++;
      peak = Math.max(peak, live);
      liveSessions.set(sessionId, (liveSessions.get(sessionId) ?? 0) + 1);
      peakPerSession = Math.max(peakPerSession, liveSessions.get(sessionId) ?? 0);
      try {
        await withDORetry(
          () => ({}),
          async () => {
            calls.push({ sessionId, notification, deadlineAt });
            if (hold) await new Promise<void>(resolve => releases.push(resolve));
          },
          'test.notification',
          { maxAttempts: 3, baseBackoffMs: 10, maxBackoffMs: 10, scope: { deadlineAt, signal } }
        );
      } finally {
        live--;
        liveSessions.set(sessionId, (liveSessions.get(sessionId) ?? 0) - 1);
      }
    },
  });
  return {
    dispatcher,
    calls,
    releases,
    diagnostics,
    peak: () => peak,
    peakPerSession: () => peakPerSession,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});
const pump = () => vi.advanceTimersByTimeAsync(0);

describe('Sandbox notification buffering', () => {
  it('bounds critical-only count and rejects newest without overwriting attempts', async () => {
    const { dispatcher, calls, releases, diagnostics } = harness();
    for (let index = 0; index < 1_010; index++)
      dispatcher.enqueue(SESSION, route(`attempt-${index}`));
    expect(dispatcher.snapshot()).toMatchObject({ retained: 1_000, pending: 1_000 });
    expect(dispatcher.snapshot().losses).toContainEqual(
      expect.objectContaining({ cause: 'capacity', droppedCount: 10 })
    );
    await pump();
    expect(calls[0]?.notification).toEqual(route('attempt-0'));
    releases[0]?.();
    await pump();
    expect(calls[1]?.notification).toEqual(route('attempt-1'));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(dispatcher.snapshot()).toMatchObject({ retained: 0, bytes: 0, active: 0, lanes: 0 });
    expect(calls).toHaveLength(2);
    expect(diagnostics.find(loss => loss.cause === 'capacity')?.droppedCount).toBe(10);
  });

  it('bounds UTF-8 bytes including active payload and evicts oldest eligible events before critical work', async () => {
    const { dispatcher, calls, releases } = harness();
    dispatcher.enqueue(SESSION, route('held'));
    await pump();
    const large = 'é'.repeat(1_000_000);
    for (let index = 0; index < 8; index++) {
      dispatcher.enqueue(SESSION, event(`${index}:${large}`));
      dispatcher.enqueue(SESSION, route(`attempt-${index}`));
      expect(dispatcher.snapshot().bytes).toBeLessThanOrEqual(SANDBOX_NOTIFICATION_LIMITS.bytes);
    }
    expect(dispatcher.snapshot().losses).toContainEqual(
      expect.objectContaining({
        cause: 'capacity',
        droppedCount: 4,
        droppedBytes: expect.any(Number),
      })
    );
    releases[0]?.();
    await pump();
    expect(calls[1]?.notification).toEqual(route('attempt-0'));
    expect(dispatcher.snapshot().bytes).toBeLessThanOrEqual(SANDBOX_NOTIFICATION_LIMITS.bytes);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(dispatcher.snapshot().bytes).toBe(0);
  });

  it('evicts event traffic to admit critical notifications at the count cap', async () => {
    const { dispatcher } = harness();
    for (let index = 0; index < 1_000; index++)
      dispatcher.enqueue(`lane-${index}`, event(`${index}`));
    dispatcher.enqueue(SESSION, outcome(SESSION));
    expect(dispatcher.snapshot()).toMatchObject({ retained: 1_000 });
    expect(dispatcher.snapshot().losses).toContainEqual(
      expect.objectContaining({ cause: 'capacity', droppedCount: 1 })
    );
    await vi.advanceTimersByTimeAsync(2_000);
  });

  it('drops newest critical traffic at the byte cap without evicting active events', async () => {
    const { dispatcher, calls } = harness();
    dispatcher.enqueue(SESSION, event('x'.repeat(3 * 1024 * 1024)));
    await pump();
    dispatcher.enqueue(SESSION, route('a'.repeat(3 * 1024 * 1024)));
    dispatcher.enqueue(SESSION, route('b'.repeat(3 * 1024 * 1024)));
    expect(dispatcher.snapshot()).toMatchObject({ retained: 2, pending: 1, active: 1 });
    expect(dispatcher.snapshot().bytes).toBeLessThanOrEqual(SANDBOX_NOTIFICATION_LIMITS.bytes);
    expect(dispatcher.snapshot().losses).toContainEqual(
      expect.objectContaining({ cause: 'capacity', droppedCount: 1 })
    );
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(dispatcher.snapshot().bytes).toBe(0);
  });

  it('drops an oversized entry without evicting retained critical work', async () => {
    const { dispatcher, calls } = harness();
    dispatcher.enqueue(SESSION, route('retained'));
    dispatcher.enqueue(SESSION, event('x'.repeat(SANDBOX_NOTIFICATION_LIMITS.bytes)));
    expect(dispatcher.snapshot().retained).toBe(1);
    await pump();
    expect(calls[0]?.notification).toEqual(route('retained'));
    await vi.advanceTimersByTimeAsync(2_000);
  });

  it('includes retained routing identity in the byte cap', async () => {
    const { dispatcher, calls } = harness();
    dispatcher.enqueue('x'.repeat(SANDBOX_NOTIFICATION_LIMITS.bytes), route('ready'));
    expect(dispatcher.snapshot()).toMatchObject({ retained: 0, bytes: 0, lanes: 0 });
    await pump();
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
  });

  it('coalesces adjacent events in order without crossing outcomes or attempts', async () => {
    const { dispatcher, calls } = harness(false);
    dispatcher.enqueue(SESSION, event('a'));
    dispatcher.enqueue(SESSION, event('b'));
    dispatcher.enqueue(SESSION, outcome(SESSION));
    dispatcher.enqueue(SESSION, route('attempt-a'));
    dispatcher.enqueue(SESSION, route('attempt-b'));
    dispatcher.enqueue(SESSION, event('c'));
    await pump();
    expect(calls.map(call => call.notification)).toEqual([
      {
        kind: 'events',
        payload: { events: [...event('a').payload.events, ...event('b').payload.events] },
      },
      outcome(SESSION),
      route('attempt-a'),
      route('attempt-b'),
      event('c'),
    ]);
    expect(dispatcher.snapshot()).toMatchObject({ retained: 0, bytes: 0, active: 0, lanes: 0 });
  });

  it('accounts coalesced UTF-8 bytes exactly without changing incoming batches', async () => {
    const { dispatcher } = harness();
    const batch = event('é');
    dispatcher.enqueue(SESSION, batch);
    dispatcher.enqueue(SESSION, batch);
    const combined = {
      kind: 'events',
      payload: { events: [...batch.payload.events, ...batch.payload.events] },
    };
    expect(batch.payload.events).toHaveLength(1);
    expect(dispatcher.snapshot().bytes).toBe(
      new TextEncoder().encode(JSON.stringify({ sessionId: SESSION, ...combined })).byteLength
    );
    await vi.advanceTimersByTimeAsync(2_000);
  });

  it('starts at most four independent lanes and never overlaps one session', async () => {
    const { dispatcher, calls, releases, peak, peakPerSession } = harness();
    for (let index = 0; index < 8; index++) {
      dispatcher.enqueue(`lane-${index}`, route('first'));
      dispatcher.enqueue(`lane-${index}`, route('second'));
    }
    await pump();
    expect(calls.map(call => call.sessionId)).toEqual(['lane-0', 'lane-1', 'lane-2', 'lane-3']);
    for (let index = 0; index < 4; index++) {
      releases[index]?.();
      await pump();
    }
    expect(calls.slice(4).map(call => call.sessionId)).toEqual([
      'lane-4',
      'lane-5',
      'lane-6',
      'lane-7',
    ]);
    expect(peak()).toBe(4);
    expect(peakPerSession()).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
  });

  it('selects queued lanes round-robin instead of draining a busy session first', async () => {
    const { dispatcher, calls, releases } = harness();
    for (let index = 0; index < 6; index++) dispatcher.enqueue(`lane-${index}`, route('first'));
    for (let index = 0; index < 6; index++) dispatcher.enqueue(`lane-${index}`, route('second'));
    await pump();
    releases[0]?.();
    await pump();
    releases[1]?.();
    await pump();
    expect(calls.slice(4).map(call => call.sessionId)).toEqual(['lane-4', 'lane-5']);
    releases[4]?.();
    await pump();
    expect(calls[6]?.sessionId).toBe('lane-0');
    await vi.advanceTimersByTimeAsync(2_000);
  });

  it('allows bounded loss of a fifth critical lane behind four held peers, without starting expired RPCs', async () => {
    const { dispatcher, calls, diagnostics } = harness();
    for (let index = 0; index < 5; index++) dispatcher.enqueue(`lane-${index}`, route('first'));
    await pump();
    expect(calls).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toHaveLength(4);
    expect(dispatcher.snapshot()).toMatchObject({ retained: 0, bytes: 0, active: 0, lanes: 0 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(
      diagnostics
        .filter(loss => loss.cause === 'expired')
        .reduce((sum, loss) => sum + loss.droppedCount, 0)
    ).toBeGreaterThanOrEqual(1);
  });

  it('keeps the oldest enqueue deadline when coalescing and supplies only remaining budget', async () => {
    const { dispatcher, calls, releases } = harness();
    dispatcher.enqueue(SESSION, route('held'));
    await pump();
    await vi.advanceTimersByTimeAsync(100);
    dispatcher.enqueue(SESSION, event('a'));
    await vi.advanceTimersByTimeAsync(1_000);
    dispatcher.enqueue(SESSION, event('b'));
    releases[0]?.();
    await pump();
    expect(calls[1]?.deadlineAt).toBe(2_100);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(dispatcher.snapshot().retained).toBe(0);
  });

  it('expires pending entries without waiting for an occupied lane to finish', async () => {
    const { dispatcher, calls } = harness();
    dispatcher.enqueue(SESSION, route('held'));
    dispatcher.enqueue(SESSION, outcome(SESSION));
    await pump();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toHaveLength(1);
    expect(dispatcher.snapshot()).toMatchObject({ pending: 0, retained: 0, bytes: 0 });
  });

  it('retires queued references and aborts active retry budgets without affecting siblings', async () => {
    const { dispatcher, calls } = harness();
    dispatcher.enqueue(SESSION, event('held'));
    dispatcher.enqueue(SESSION, outcome(SESSION));
    dispatcher.enqueue('sibling', route('ready'));
    await pump();
    dispatcher.retire(SESSION);
    dispatcher.retire(SESSION);
    await pump();
    expect(dispatcher.snapshot()).toMatchObject({ pending: 0, retained: 1, active: 1, lanes: 0 });
    expect(calls).toHaveLength(2);
    expect(dispatcher.snapshot().losses).toContainEqual(
      expect.objectContaining({ cause: 'retired', droppedCount: 2 })
    );
    await vi.advanceTimersByTimeAsync(2_000);
    expect(dispatcher.snapshot().bytes).toBe(0);
  });

  it('aggregates diagnostics by bounded cause, saturates counts and retains no unsafe identity or payload', async () => {
    const { dispatcher, diagnostics } = harness();
    for (let index = 0; index < 10_000; index++) dispatcher.wrapperDropped(Number.MAX_SAFE_INTEGER);
    expect(dispatcher.snapshot().losses).toEqual([
      {
        cause: 'wrapper',
        droppedCount: Number.MAX_SAFE_INTEGER,
        droppedBytes: 0,
        maxQueueAgeMs: 0,
      },
    ]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(diagnostics).toHaveLength(1);
    expect(dispatcher.snapshot().losses).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds failure accounting and proceeds to retained outcomes without logging payload or raw errors', async () => {
    const calls: string[] = [];
    const diagnostics: NotificationLoss[] = [];
    const dispatcher = createSandboxNotificationDispatcher({
      budgetMs: () => 2_000,
      waitUntil: work => {
        void work;
      },
      diagnostic: loss => diagnostics.push(loss),
      send: async (_sessionId, notification) => {
        calls.push(notification.kind);
        if (notification.kind === 'events') throw new Error('sensitive-error-content');
      },
    });
    dispatcher.enqueue('unsafe-session-identity', event('sensitive-payload'));
    dispatcher.enqueue('unsafe-session-identity', outcome('unsafe-session-identity'));
    await pump();
    expect(calls).toEqual(['events', 'outcome']);
    expect(dispatcher.snapshot()).toMatchObject({ retained: 0, bytes: 0, active: 0, lanes: 0 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(diagnostics).toEqual([
      { cause: 'failed', droppedCount: 1, droppedBytes: expect.any(Number), maxQueueAgeMs: 0 },
    ]);
    expect(JSON.stringify(diagnostics)).not.toMatch(/sensitive|unsafe/);
    expect(dispatcher.snapshot().losses).toEqual([]);
  });

  it('reconstruction starts empty rather than replaying best-effort in-memory work', async () => {
    const original = harness();
    original.dispatcher.enqueue(SESSION, route('old'));
    const rebuilt = harness(false);
    expect(rebuilt.dispatcher.snapshot()).toMatchObject({
      pending: 0,
      retained: 0,
      bytes: 0,
      active: 0,
      lanes: 0,
      losses: [],
    });
    rebuilt.dispatcher.enqueue(SESSION, route('new'));
    await pump();
    expect(rebuilt.calls.map(call => call.notification)).toEqual([route('new')]);
    await vi.advanceTimersByTimeAsync(2_000);
  });
});
