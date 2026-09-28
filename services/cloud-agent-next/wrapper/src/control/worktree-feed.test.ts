import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import {
  KILO_FEED_FRESHNESS_TIMEOUT_MS,
  KILO_FEED_RECOVERY_DEADLINE_MS,
  KILO_FEED_RECOVERY_MAX_ATTEMPTS,
} from './sandbox-control-runtime';
import { createWorktreeFeed, type KiloFeedEvent } from './worktree-feed';

const encoder = new TextEncoder();

function frame(payload: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

const connectedFrame = frame({ payload: { type: 'server.connected', properties: {} } });

function sessionFrame(id: string): Uint8Array {
  return frame({
    directory: '/workspace',
    payload: { type: 'session.updated', properties: { sessionID: id } },
  });
}

type Connection = {
  signal: AbortSignal;
  cancelled: boolean;
  aborted: boolean;
  enqueue: (chunk: Uint8Array) => void;
  close: () => void;
  error: (error: unknown) => void;
};

function createServer(options: { failAt?: number[]; emptyFrom?: number; emptyAt?: number[] } = {}) {
  const connections: Connection[] = [];
  let calls = 0;
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit
  ) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (!signal) throw new Error('missing fetch signal');
    calls += 1;
    if (options.failAt?.includes(calls) === true) {
      throw new TypeError(`network down ${calls}`);
    }
    const empty =
      (options.emptyFrom !== undefined && calls >= options.emptyFrom) ||
      options.emptyAt?.includes(calls) === true;
    let ref: ReadableStreamDefaultController<Uint8Array> | undefined;
    const controls: Connection = {
      signal,
      cancelled: false,
      aborted: false,
      enqueue: () => {},
      close: () => {},
      error: () => {},
    };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        ref = controller;
        if (empty) controller.close();
        signal.addEventListener(
          'abort',
          () => {
            controls.aborted = true;
            try {
              controller.error(new DOMException('Aborted', 'AbortError'));
            } catch {
              // Source already closed or cancelled.
            }
          },
          { once: true }
        );
      },
      cancel() {
        controls.cancelled = true;
      },
    });
    controls.enqueue = chunk => {
      try {
        ref?.enqueue(chunk);
      } catch {
        // Source already closed.
      }
    };
    controls.close = () => {
      try {
        ref?.close();
      } catch {
        // Source already closed.
      }
    };
    controls.error = error => {
      try {
        ref?.error(error);
      } catch {
        // Source already closed.
      }
    };
    connections.push(controls);
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
  }) as unknown as typeof fetch);
  return { connections, fetchCalls: () => calls, restore: () => fetchSpy.mockRestore() };
}

function sleepSeam() {
  const pending: Array<{ ms: number; resolve: () => void }> = [];
  const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise(resolve => {
      if (signal.aborted) {
        resolve();
        return;
      }
      pending.push({ ms, resolve: () => resolve() });
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  return { pending, sleep };
}

function watchdogSeam() {
  const spy = spyOn(globalThis, 'setInterval');
  return {
    fire(): void {
      const calls = spy.mock.calls.filter(([, ms]) => ms === 10_000);
      const call = calls.at(-1);
      if (!call) throw new Error('missing feed freshness watchdog');
      (call[0] as () => void)();
    },
    restore: () => spy.mockRestore(),
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for feed state');
    await Bun.sleep(5);
  }
}

type FeedFixture = ReturnType<typeof buildFeed>;

function buildFeed(seam: {
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}) {
  const events: KiloFeedEvent[] = [];
  const failures: string[] = [];
  const logs: string[] = [];
  const aborter = new AbortController();
  const source = {
    scopeId: 'worktree_a',
    runtimeId: 'runtime_a',
    directory: '/workspace',
    kiloClient: { serverUrl: 'http://127.0.0.1:1' },
    signal: aborter.signal,
  };
  const feed = createWorktreeFeed({
    source,
    isCurrent: () => true,
    onEvent: event => events.push(event),
    onFailure: reason => failures.push(reason),
    now: seam.now,
    sleep: seam.sleep,
    log: message => logs.push(message),
  });
  return { aborter, events, failures, feed, logs, source };
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function track(fixture: FeedFixture, ...restores: Array<() => void>): void {
  cleanups.push(() => {
    fixture.feed.close();
    for (const restore of restores) restore();
  });
}

describe('createWorktreeFeed connection-owned recovery', () => {
  it('reconnects a silent healthy feed without retiring the runtime', async () => {
    const server = createServer();
    const clock = { value: 1_000_000 };
    const sleeps = sleepSeam();
    const watchdogs = watchdogSeam();
    const fixture = buildFeed({ now: () => clock.value, sleep: sleeps.sleep });
    track(fixture, server.restore, watchdogs.restore);

    const opening = fixture.feed.open();
    await waitFor(() => server.connections.length === 1);
    server.connections[0]!.enqueue(connectedFrame);
    await opening;
    server.connections[0]!.enqueue(sessionFrame('first'));
    await waitFor(() => fixture.events.length === 1);

    clock.value += KILO_FEED_FRESHNESS_TIMEOUT_MS + 1;
    expect(fixture.feed.isFresh()).toBe(false);
    expect(fixture.feed.isRecovering()).toBe(true);
    expect(fixture.feed.prepareForNewWork()).toBe(false);
    watchdogs.fire();
    await waitFor(() => server.connections[0]!.aborted);
    expect(fixture.feed.isRecovering()).toBe(true);
    expect(fixture.feed.isFresh()).toBe(false);
    expect(fixture.failures).toEqual([]);
    expect(fixture.aborter.signal.aborted).toBe(false);

    await waitFor(() => sleeps.pending.length === 1);
    sleeps.pending[0]!.resolve();
    await waitFor(() => server.connections.length === 2);

    clock.value += KILO_FEED_FRESHNESS_TIMEOUT_MS - 1;
    watchdogs.fire();
    expect(server.connections[1]!.aborted).toBe(false);

    server.connections[1]!.enqueue(sessionFrame('second'));
    await waitFor(() => fixture.events.length === 2);
    expect(fixture.feed.isFresh()).toBe(true);
    expect(fixture.feed.isRecovering()).toBe(false);
    expect(fixture.feed.prepareForNewWork()).toBe(true);
    expect(fixture.failures).toEqual([]);
    expect(fixture.aborter.signal.aborted).toBe(false);
  });

  it('admits recovery GET 6 and recovers without retiring the runtime', async () => {
    const server = createServer({ failAt: [2, 3, 4, 5, 6] });
    const clock = { value: 1_000_000 };
    const sleeps = sleepSeam();
    const fixture = buildFeed({ now: () => clock.value, sleep: sleeps.sleep });
    track(fixture, server.restore);

    const opening = fixture.feed.open();
    await waitFor(() => server.connections.length === 1);
    server.connections[0]!.enqueue(connectedFrame);
    server.connections[0]!.enqueue(sessionFrame('first'));
    await opening;
    await waitFor(() => fixture.events.length === 1);
    // End the startup stream so the episode starts with a fresh recovery budget.
    server.connections[0]!.close();

    // Five recovery GETs fail; the sixth (fetch 7) must be admitted and succeed.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const sleep = await waitForSleep(sleeps);
      sleep.resolve();
    }
    await waitFor(() => server.connections.length === 2);
    server.connections[1]!.enqueue(connectedFrame);
    server.connections[1]!.enqueue(sessionFrame('second'));
    await waitFor(() => fixture.events.length === 2);

    expect(server.fetchCalls()).toBe(7);
    expect(fixture.failures).toEqual([]);
    expect(fixture.feed.prepareForNewWork()).toBe(true);
    expect(fixture.aborter.signal.aborted).toBe(false);
  });

  it('exhausts the episode after GET 6 of the outage and reports the preserved reason once', async () => {
    const server = createServer({ emptyFrom: 2 });
    const clock = { value: 1_000_000 };
    const sleeps = sleepSeam();
    const fixture = buildFeed({ now: () => clock.value, sleep: sleeps.sleep });
    track(fixture, server.restore);

    const opening = fixture.feed.open();
    await waitFor(() => server.connections.length === 1);
    server.connections[0]!.enqueue(connectedFrame);
    await opening;
    server.connections[0]!.enqueue(sessionFrame('first'));
    await waitFor(() => fixture.events.length === 1);

    server.connections[0]!.close();
    await waitFor(() => fixture.failures.length === 1);
    expect(server.connections).toHaveLength(1 + KILO_FEED_RECOVERY_MAX_ATTEMPTS);
    expect(fixture.failures).toEqual(['feed_ended']);
    expect(fixture.feed.isFresh()).toBe(false);
    expect(fixture.aborter.signal.aborted).toBe(false);
  });

  it('recovers when a replacement GET returns an empty response before its first event', async () => {
    const server = createServer({ emptyAt: [2] });
    const clock = { value: 1_000_000 };
    const sleeps = sleepSeam();
    const fixture = buildFeed({ now: () => clock.value, sleep: sleeps.sleep });
    track(fixture, server.restore);

    const opening = fixture.feed.open();
    await waitFor(() => server.connections.length === 1);
    server.connections[0]!.enqueue(connectedFrame);
    await opening;
    server.connections[0]!.enqueue(sessionFrame('first'));
    await waitFor(() => fixture.events.length === 1);

    server.connections[0]!.close();
    // GET 2 ends empty before its first event; GET 3 must still be made.
    await waitFor(() => server.connections.length === 3);
    server.connections[2]!.enqueue(connectedFrame);
    server.connections[2]!.enqueue(sessionFrame('second'));
    await waitFor(() => fixture.events.length === 2);
    expect(fixture.failures).toEqual([]);
    expect(fixture.feed.prepareForNewWork()).toBe(true);
  });

  it('recovers from a stream error with a replacement GET', async () => {
    const server = createServer();
    const clock = { value: 1_000_000 };
    const sleeps = sleepSeam();
    const fixture = buildFeed({ now: () => clock.value, sleep: sleeps.sleep });
    track(fixture, server.restore);

    const opening = fixture.feed.open();
    await waitFor(() => server.connections.length === 1);
    server.connections[0]!.enqueue(connectedFrame);
    await opening;
    server.connections[0]!.enqueue(sessionFrame('first'));
    await waitFor(() => fixture.events.length === 1);

    server.connections[0]!.error(new Error('socket died'));
    await waitFor(() => sleeps.pending.length === 1);
    expect(fixture.feed.isRecovering()).toBe(true);
    sleeps.pending[0]!.resolve();
    await waitFor(() => server.connections.length === 2);
    server.connections[1]!.enqueue(connectedFrame);
    server.connections[1]!.enqueue(sessionFrame('second'));
    await waitFor(() => fixture.events.length === 2);
    expect(fixture.failures).toEqual([]);
    expect(fixture.feed.isFresh()).toBe(true);
    expect(fixture.feed.isRecovering()).toBe(false);
    expect(fixture.feed.prepareForNewWork()).toBe(true);
  });

  it('suppresses server.connected while forwarding session events', async () => {
    const server = createServer();
    const clock = { value: 1_000_000 };
    const sleeps = sleepSeam();
    const fixture = buildFeed({ now: () => clock.value, sleep: sleeps.sleep });
    cleanups.push(() => {
      fixture.feed.close();
      server.restore();
    });

    const opening = fixture.feed.open();
    await waitFor(() => server.connections.length === 1);
    server.connections[0]!.enqueue(connectedFrame);
    server.connections[0]!.enqueue(connectedFrame);
    server.connections[0]!.enqueue(sessionFrame('first'));
    await opening;
    await waitFor(() => fixture.events.length === 1);
    await Bun.sleep(10);
    expect(fixture.events.map(event => event.type)).toEqual(['session.updated']);
    expect(fixture.failures).toEqual([]);
  });

  it('retires at the episode deadline when backoff resolves without a watchdog tick', async () => {
    const server = createServer();
    const clock = { value: 1_000_000 };
    const sleeps = sleepSeam();
    const fixture = buildFeed({ now: () => clock.value, sleep: sleeps.sleep });
    track(fixture, server.restore);

    const opening = fixture.feed.open();
    await waitFor(() => server.connections.length === 1);
    server.connections[0]!.enqueue(connectedFrame);
    await opening;
    server.connections[0]!.enqueue(sessionFrame('first'));
    await waitFor(() => fixture.events.length === 1);

    server.connections[0]!.error(new Error('socket died'));
    await waitFor(() => sleeps.pending.length === 1);

    // The backoff outlives the 120 s episode deadline. Resolve it without
    // firing the watchdog: the sleep-wake admission check must retire first.
    clock.value += KILO_FEED_RECOVERY_DEADLINE_MS + 1;
    sleeps.pending[0]!.resolve();

    await waitFor(() => fixture.failures.length === 1);
    expect(fixture.failures).toEqual(['feed_failed']);
    expect(fixture.events).toHaveLength(1);
    expect(server.fetchCalls()).toBe(1);
    expect(server.connections).toHaveLength(1);
    expect(fixture.feed.prepareForNewWork()).toBe(false);
    expect(fixture.aborter.signal.aborted).toBe(false);
  });

  it('retires at the episode deadline while the SDK is backing off', async () => {
    const server = createServer();
    const clock = { value: 1_000_000 };
    const sleeps = sleepSeam();
    const watchdogs = watchdogSeam();
    const fixture = buildFeed({ now: () => clock.value, sleep: sleeps.sleep });
    track(fixture, server.restore, watchdogs.restore);

    const opening = fixture.feed.open();
    await waitFor(() => server.connections.length === 1);
    server.connections[0]!.enqueue(connectedFrame);
    await opening;
    server.connections[0]!.enqueue(sessionFrame('first'));
    await waitFor(() => fixture.events.length === 1);

    server.connections[0]!.error(new Error('socket died'));
    await waitFor(() => sleeps.pending.length === 1);
    expect(fixture.feed.isRecovering()).toBe(true);
    expect(fixture.feed.prepareForNewWork()).toBe(false);

    clock.value += KILO_FEED_RECOVERY_DEADLINE_MS + 1;
    watchdogs.fire();
    await waitFor(() => fixture.failures.length === 1);
    expect(fixture.failures).toEqual(['feed_failed']);
    expect(server.connections).toHaveLength(1);
    expect(fixture.aborter.signal.aborted).toBe(false);
  });

  it('enforces the episode deadline even while incomplete bytes keep the feed fresh', async () => {
    const server = createServer();
    const clock = { value: 1_000_000 };
    const sleeps = sleepSeam();
    const watchdogs = watchdogSeam();
    const fixture = buildFeed({ now: () => clock.value, sleep: sleeps.sleep });
    track(fixture, server.restore, watchdogs.restore);

    const opening = fixture.feed.open();
    await waitFor(() => server.connections.length === 1);
    server.connections[0]!.enqueue(connectedFrame);
    await opening;
    server.connections[0]!.enqueue(sessionFrame('first'));
    await waitFor(() => fixture.events.length === 1);

    server.connections[0]!.error(new Error('socket died'));
    await waitFor(() => sleeps.pending.length === 1);
    sleeps.pending[0]!.resolve();
    await waitFor(() => server.connections.length === 2);
    const episodeStart = clock.value;

    const partial = encoder.encode('data: {"payload":{"type":"session.up');
    clock.value = episodeStart + KILO_FEED_FRESHNESS_TIMEOUT_MS + 1;
    server.connections[1]!.enqueue(partial);
    await Bun.sleep(10);
    expect(fixture.feed.isFresh()).toBe(true);
    expect(fixture.failures).toEqual([]);

    clock.value = episodeStart + KILO_FEED_RECOVERY_DEADLINE_MS + 1;
    server.connections[1]!.enqueue(partial);
    await Bun.sleep(10);
    expect(fixture.feed.isFresh()).toBe(true);

    watchdogs.fire();
    await waitFor(() => fixture.failures.length === 1);
    expect(fixture.failures).toEqual(['feed_failed']);
    expect(fixture.aborter.signal.aborted).toBe(false);
  });

  it('starts a fresh budget for a second outage after recovery', async () => {
    const server = createServer();
    const clock = { value: 1_000_000 };
    const sleeps = sleepSeam();
    const fixture = buildFeed({ now: () => clock.value, sleep: sleeps.sleep });
    track(fixture, server.restore);

    const opening = fixture.feed.open();
    await waitFor(() => server.connections.length === 1);
    server.connections[0]!.enqueue(connectedFrame);
    await opening;
    server.connections[0]!.enqueue(sessionFrame('first'));
    await waitFor(() => fixture.events.length === 1);

    server.connections[0]!.close();
    await waitFor(() => server.connections.length === 2);
    server.connections[1]!.enqueue(connectedFrame);
    server.connections[1]!.enqueue(sessionFrame('second'));
    await waitFor(() => fixture.events.length === 2);
    expect(fixture.failures).toEqual([]);
    const recoveries = fixture.logs.filter(line => line.includes('phase=recovering'));
    expect(recoveries).toHaveLength(1);

    server.connections[1]!.close();
    await waitFor(() => server.connections.length === 3);
    expect(fixture.feed.isRecovering()).toBe(true);
    server.connections[2]!.enqueue(connectedFrame);
    server.connections[2]!.enqueue(sessionFrame('third'));
    await waitFor(() => fixture.events.length === 3);
    expect(fixture.failures).toEqual([]);
    expect(fixture.logs.filter(line => line.includes('phase=recovering'))).toHaveLength(2);
    expect(fixture.feed.prepareForNewWork()).toBe(true);
  });

  it('stops during retry without another fetch or a duplicate failure', async () => {
    const server = createServer();
    const clock = { value: 1_000_000 };
    const sleeps = sleepSeam();
    const fixture = buildFeed({ now: () => clock.value, sleep: sleeps.sleep });
    track(fixture, server.restore);

    const opening = fixture.feed.open();
    await waitFor(() => server.connections.length === 1);
    server.connections[0]!.enqueue(connectedFrame);
    await opening;
    server.connections[0]!.enqueue(sessionFrame('first'));
    await waitFor(() => fixture.events.length === 1);

    server.connections[0]!.error(new Error('socket died'));
    await waitFor(() => sleeps.pending.length === 1);

    fixture.feed.close();
    await Bun.sleep(20);
    expect(server.connections).toHaveLength(1);
    expect(fixture.failures).toEqual([]);
    expect(fixture.feed.prepareForNewWork()).toBe(false);
  });

  it('does not let a slow event callback delay the next feed callback', async () => {
    const server = createServer();
    const clock = { value: 1_000_000 };
    const sleeps = sleepSeam();
    const firstEntered = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const received: string[] = [];
    const aborter = new AbortController();
    const feed = createWorktreeFeed({
      source: {
        scopeId: 'worktree_a',
        runtimeId: 'runtime_a',
        directory: '/workspace',
        kiloClient: { serverUrl: 'http://127.0.0.1:1' },
        signal: aborter.signal,
      },
      isCurrent: () => true,
      onEvent: async event => {
        received.push(String(event.properties.sessionID));
        if (received.length === 1) {
          firstEntered.resolve();
          await releaseFirst.promise;
        }
      },
      onFailure: () => {},
      now: () => clock.value,
      sleep: sleeps.sleep,
    });
    cleanups.push(() => {
      feed.close();
      server.restore();
    });

    const opening = feed.open();
    await waitFor(() => server.connections.length === 1);
    server.connections[0]!.enqueue(connectedFrame);
    await opening;
    server.connections[0]!.enqueue(sessionFrame('first'));
    await firstEntered.promise;
    server.connections[0]!.enqueue(sessionFrame('second'));
    await waitFor(() => received.length === 2);
    expect(received).toEqual(['first', 'second']);
    releaseFirst.resolve();
  });

  it('writes feed lifecycle log lines with identity and skips the healthy freshness ping', async () => {
    const server = createServer();
    const clock = { value: 1_000_000 };
    const sleeps = sleepSeam();
    const watchdogs = watchdogSeam();
    const fixture = buildFeed({ now: () => clock.value, sleep: sleeps.sleep });
    track(fixture, server.restore, watchdogs.restore);

    const opening = fixture.feed.open();
    await waitFor(() => server.connections.length === 1);
    server.connections[0]!.enqueue(connectedFrame);
    await opening;
    server.connections[0]!.enqueue(sessionFrame('first'));
    await waitFor(() => fixture.events.length === 1);

    clock.value += KILO_FEED_FRESHNESS_TIMEOUT_MS + 1;
    watchdogs.fire();
    await waitFor(() => sleeps.pending.length === 1);
    sleeps.pending[0]!.resolve();
    await waitFor(() => server.connections.length === 2);
    server.connections[1]!.enqueue(sessionFrame('second'));
    await waitFor(() => fixture.events.length === 2);

    expect(fixture.logs.some(line => line.includes('phase=get_start'))).toBe(true);
    expect(fixture.logs.some(line => line.includes('phase=retry_delay delayMs='))).toBe(true);
    expect(fixture.logs.some(line => line.includes('phase=recovering reason=feed_stale'))).toBe(
      true
    );
    expect(fixture.logs.some(line => line.includes('phase=recovered'))).toBe(true);
    expect(fixture.logs.every(line => line.includes('scopeId=worktree_a'))).toBe(true);
    expect(fixture.logs.every(line => line.includes('runtimeId=runtime_a'))).toBe(true);
    expect(fixture.logs.some(line => line.includes('freshness'))).toBe(false);
  });
});

async function waitForSleep(
  sleeps: ReturnType<typeof sleepSeam>
): Promise<{ resolve: () => void }> {
  const start = Date.now();
  while (sleeps.pending.length === 0) {
    if (Date.now() - start > 3_000) throw new Error('Timed out waiting for SDK backoff');
    await Bun.sleep(5);
  }
  return sleeps.pending.shift()!;
}
