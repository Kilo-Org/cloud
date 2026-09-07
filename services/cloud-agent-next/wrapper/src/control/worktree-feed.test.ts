import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import {
  SANDBOX_CONTROL_RECOVERY_MAX_ATTEMPTS,
  sandboxEventPublicationPayloadSchema,
  type ControlFrame,
} from '../../../src/shared/sandbox-control-protocol';
import { createSandboxControlClient } from './sandbox-control-client';
import { eventKiloSessionId, sessionEventIdentity } from './feed';
import { forgetAttachedRoot, rememberAttachedRoot } from './session-directories';
import * as controlRuntime from './sandbox-control-runtime';
import { createWorktreeFeed, type KiloFeedEvent } from './worktree-feed';

type FeedOptions = Parameters<typeof controlRuntime.startSandboxControlEventFeed>[0];

function asFetch(
  fn: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>
): typeof fetch {
  return Object.assign(fn, { preconnect: fetch.preconnect });
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) break;
    await Bun.sleep(10);
  }
  if (condition()) return;
  throw new Error('Timed out waiting for native feed state');
}

function nativeFeed(options: FeedOptions) {
  let fresh = true;
  return {
    emit: async (value: unknown) => {
      await options.consume(
        (async function* () {
          yield value;
        })()
      );
    },
    fail: (reason: controlRuntime.KiloEventFeedError['reason']) => {
      fresh = false;
      options.onUnexpectedClose(
        new controlRuntime.KiloEventFeedError(reason, 'Native feed failed')
      );
    },
    result: {
      isFresh: () => fresh && !options.signal.aborted,
      usable: Promise.resolve(true),
      close: () => {
        fresh = false;
      },
      settled: Promise.resolve(),
    },
  };
}

function fixture(rejectReconnections = false) {
  const source = {
    scopeId: 'worktree_a',
    runtimeId: crypto.randomUUID(),
    directory: '/workspace',
    kiloClient: { serverUrl: 'http://127.0.0.1:1' },
    signal: new AbortController().signal,
  };
  const attempts: ReturnType<typeof nativeFeed>[] = [];
  const failures: string[] = [];
  const events: KiloFeedEvent[] = [];
  const start = spyOn(controlRuntime, 'startSandboxControlEventFeed').mockImplementation(
    async options => {
      if (rejectReconnections && attempts.length > 0) throw new Error('Feed unavailable');
      const attempt = nativeFeed(options);
      attempts.push(attempt);
      return attempt.result;
    }
  );
  const feed = createWorktreeFeed({
    source,
    isCurrent: (runtimeId, kiloClient) =>
      runtimeId === source.runtimeId && kiloClient === source.kiloClient,
    onEvent: event => events.push(event),
    onFailure: reason => failures.push(reason),
  });
  return { attempts, events, failures, feed, source, start };
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('createWorktreeFeed', () => {
  it.each([true, false])(
    'preserves producer lifetime with event receipts=%s',
    async eventReceipts => {
      const sockets: Array<ReturnType<typeof socket>> = [];
      function socket() {
        const events = new EventTarget();
        return Object.assign(events, {
          readyState: 1,
          sent: [] as ControlFrame[],
          send(data: string) {
            if (data === 'ping') return;
            const frame = JSON.parse(data) as ControlFrame;
            this.sent.push(frame);
            if (frame.type !== 'request') return;
            const result =
              frame.operation === 'sandbox.hello'
                ? {
                    protocolVersion: 1,
                    handshakeComplete: true,
                    capabilities: { connectionRecovery: true, eventReceipts },
                  }
                : frame.operation === 'sandbox.event.publish'
                  ? {
                      receiptId: sandboxEventPublicationPayloadSchema.parse(frame.payload)
                        .receiptId,
                      applied: true,
                    }
                  : undefined;
            if (!result) return;
            events.dispatchEvent(
              new MessageEvent('message', {
                data: JSON.stringify({
                  type: 'response',
                  requestId: frame.requestId,
                  ok: true,
                  result,
                }),
              })
            );
            if (frame.operation === 'sandbox.hello')
              events.dispatchEvent(
                new MessageEvent('message', {
                  data: JSON.stringify({
                    type: 'request',
                    requestId: 'probe',
                    operation: 'sandbox.status',
                    payload: {},
                  }),
                })
              );
          },
          close() {
            this.readyState = 3;
            events.dispatchEvent(new Event('close'));
          },
        });
      }
      const client = createSandboxControlClient({
        url: 'wss://example.test/control',
        credential: 'test',
        providerInstanceId: 'test',
        reconnectDelayMs: () => 0,
        openWebSocket: () => {
          const next = socket();
          if (sockets.length > 0) next.readyState = 0;
          sockets.push(next);
          return next as unknown as WebSocket;
        },
      });
      const h = fixture();
      const feeds: ReturnType<typeof createWorktreeFeed>[] = [];
      const start = () => {
        const feed = createWorktreeFeed({
          source: h.source,
          isCurrent: runtimeId => runtimeId === h.source.runtimeId,
          onEvent: async event => {
            const identity = sessionEventIdentity({
              ...event,
              sessionId: eventKiloSessionId(event.properties),
              runtimeDirectory: h.source.directory,
            });
            if (!identity) throw new Error('Missing event identity');
            expect(
              await client.publishSessionEvent?.(
                { type: event.type, properties: event.properties },
                identity
              )
            ).toBe(true);
          },
          onFailure: reason => h.failures.push(reason),
        });
        feeds.push(feed);
        return feed.open();
      };
      const envelope = {
        directory: h.source.directory,
        nativeRuntimeId: crypto.randomUUID(),
        payload: {
          type: 'session.status',
          properties: { sessionID: 'receipt_root', status: { type: 'idle' } },
        },
      };
      rememberAttachedRoot('receipt_root', h.source.directory);
      try {
        await client.connect();
        const originalSocket = sockets[0];
        if (!originalSocket) throw new Error('Missing original socket');
        if (eventReceipts) originalSocket.close();
        await start();
        const originalId = h.source.runtimeId;
        await h.attempts[0]?.emit(envelope);
        h.source.runtimeId = crypto.randomUUID();
        await start();
        await h.attempts[0]?.emit(envelope);
        await h.attempts[1]?.emit(envelope);
        const frames = () =>
          sockets
            .flatMap(item => item.sent)
            .filter(frame => frame.type === 'request' || frame.type === 'event')
            .filter(frame =>
              eventReceipts
                ? frame.type === 'request' && frame.operation === 'sandbox.event.publish'
                : frame.type === 'event'
            );
        if (eventReceipts) {
          expect(frames()).toEqual([]);
          await waitFor(() => sockets.length === 2);
          const replacement = sockets[1];
          if (!replacement) throw new Error('Missing replacement socket');
          replacement.readyState = 1;
          replacement.dispatchEvent(new Event('open'));
        }
        await waitFor(() => frames().length === 2);
        if (eventReceipts) {
          expect(sockets).toHaveLength(2);
          const publications = frames().map(frame =>
            sandboxEventPublicationPayloadSchema.parse(frame.payload)
          );
          expect(publications.map(item => item.session.nativeRuntimeId)).toEqual([
            originalId,
            h.source.runtimeId,
          ]);
          expect(publications.map(item => item.sequence)).toEqual([1, 2]);
          expect(
            originalSocket.sent.some(
              frame => frame.type === 'request' && frame.operation === 'sandbox.event.publish'
            )
          ).toBe(false);
        } else {
          expect(sockets).toHaveLength(1);
          for (const frame of frames())
            expect(frame).toEqual({
              type: 'event',
              event: 'session.event',
              session: {
                directory: h.source.directory,
                kiloSessionId: 'receipt_root',
                rootKiloSessionId: 'receipt_root',
              },
              payload: envelope.payload,
            });
        }
        expect(h.failures).toEqual([]);
      } finally {
        for (const feed of feeds) feed.close();
        client.close();
        h.start.mockRestore();
        forgetAttachedRoot('receipt_root');
      }
    }
  );

  it.each(['feed_ended', 'feed_failed', 'feed_stale', 'feed_reconnected'] as const)(
    'replaces a %s subscription without stopping the native process',
    async reason => {
      const h = fixture();
      cleanups.push(() => {
        h.feed.close();
        h.start.mockRestore();
      });
      await h.feed.open();
      const original = h.attempts[0];
      if (!original) throw new Error('Missing original subscription');
      original.fail(reason);
      expect(h.feed.prepareForNewWork()).toBe(false);
      await waitFor(() => h.attempts.length === 2 && h.feed.isFresh());
      const replacement = h.attempts[1];
      if (!replacement) throw new Error('Missing replacement subscription');
      await original.emit({
        directory: h.source.directory,
        payload: { type: 'session.updated', properties: { sessionID: 'stale' } },
      });
      await replacement.emit({
        directory: h.source.directory,
        payload: { type: 'session.updated', properties: { sessionID: 'current' } },
      });
      expect(h.source.signal.aborted).toBe(false);
      expect(h.feed.prepareForNewWork()).toBe(true);
      expect(h.events).toEqual([
        {
          directory: h.source.directory,
          nativeRuntimeId: h.source.runtimeId,
          type: 'session.updated',
          properties: { sessionID: 'current' },
        },
      ]);
      expect(h.failures).toEqual([]);
    }
  );

  it('exhausts only the original recovery episode when replacement subscriptions cannot open', async () => {
    const h = fixture(true);
    cleanups.push(() => {
      h.feed.close();
      h.start.mockRestore();
    });
    await h.feed.open();
    h.attempts[0]?.fail('feed_ended');
    await waitFor(() => h.failures.length === 1);
    expect(h.start).toHaveBeenCalledTimes(1 + SANDBOX_CONTROL_RECOVERY_MAX_ATTEMPTS);
    expect(h.failures).toEqual(['feed_ended']);
    expect(h.source.signal.aborted).toBe(false);
    expect(h.feed.prepareForNewWork()).toBe(false);
  });

  it('does not start a second recovery loop while an earlier attempt is uncertain', async () => {
    const h = fixture();
    cleanups.push(() => {
      h.feed.close();
      h.start.mockRestore();
    });
    await h.feed.open();
    const original = h.attempts[0];
    if (!original) throw new Error('Missing original subscription');
    original.fail('feed_ended');
    original.fail('feed_failed');
    await waitFor(() => h.attempts.length === 2 && h.feed.isFresh());
    expect(h.start).toHaveBeenCalledTimes(2);
    expect(h.failures).toEqual([]);
  });

  it('keeps immediate real reconnects inside one bounded recovery episode', async () => {
    const encoder = new TextEncoder();
    const connected = encoder.encode(
      'data: {"payload":{"type":"server.connected","properties":{}}}\n\n'
    );
    let closeInitial: (() => void) | undefined;
    let connections = 0;
    const failures: string[] = [];
    const diagnostics: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      asFetch(async () => {
        connections += 1;
        const immediateReconnect = connections > 1;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(connected);
              if (immediateReconnect) {
                controller.enqueue(connected);
                controller.close();
              } else {
                closeInitial = () => controller.close();
              }
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } }
        );
      })
    );
    const source = {
      scopeId: 'worktree_a',
      runtimeId: crypto.randomUUID(),
      directory: '/workspace',
      kiloClient: { serverUrl: 'http://127.0.0.1:1' },
      signal: new AbortController().signal,
    };
    const feed = createWorktreeFeed({
      source,
      isCurrent: (runtimeId, kiloClient) =>
        runtimeId === source.runtimeId && kiloClient === source.kiloClient,
      onFailure: reason => failures.push(reason),
      onDiagnostic: (event, fields) => diagnostics.push({ event, fields }),
    });
    try {
      await feed.open();
      closeInitial?.();
      await waitFor(() => connections >= 2);
      expect(feed.prepareForNewWork()).toBe(false);
      await waitFor(() => failures.length === 1);
      expect(connections).toBe(1 + SANDBOX_CONTROL_RECOVERY_MAX_ATTEMPTS);
      expect(failures).toEqual(['feed_ended']);
      expect(feed.prepareForNewWork()).toBe(false);
      expect(diagnostics).toContainEqual(
        expect.objectContaining({
          event: 'control.feed',
          fields: expect.objectContaining({ scopeId: source.scopeId }),
        })
      );
    } finally {
      feed.close();
      fetchSpy.mockRestore();
    }
  });

  it(
    'expires raw incomplete reconnect activity within the original recovery deadline',
    async () => {
      const encoder = new TextEncoder();
      const connected = encoder.encode(
        'data: {"payload":{"type":"server.connected","properties":{}}}\n\n'
      );
      const rawActivity = encoder.encode(' ');
      let closeInitial: (() => void) | undefined;
      let connections = 0;
      const failures: string[] = [];
      const activities = new Set<ReturnType<typeof setInterval>>();
      const source = {
        scopeId: 'worktree_a',
        runtimeId: crypto.randomUUID(),
        directory: '/workspace',
        kiloClient: { serverUrl: 'http://127.0.0.1:1' },
        signal: new AbortController().signal,
      };
      const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
        asFetch(async () => {
          connections += 1;
          let activity: ReturnType<typeof setInterval> | undefined;
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(connected);
                if (connections === 1) {
                  closeInitial = () => controller.close();
                } else {
                  activity = setInterval(() => controller.enqueue(rawActivity), 1_000);
                  activities.add(activity);
                }
              },
              cancel() {
                if (activity) {
                  clearInterval(activity);
                  activities.delete(activity);
                }
              },
            }),
            { headers: { 'Content-Type': 'text/event-stream' } }
          );
        })
      );
      const feed = createWorktreeFeed({
        source,
        isCurrent: (runtimeId, kiloClient) =>
          runtimeId === source.runtimeId && kiloClient === source.kiloClient,
        onFailure: reason => failures.push(reason),
      });
      try {
        await feed.open();
        const recoveryStartedAt = Date.now();
        closeInitial?.();
        await waitFor(() => connections === 2);
        expect(connections).toBe(2);

        await waitFor(
          () => failures.length === 1,
          controlRuntime.KILO_FEED_FRESHNESS_TIMEOUT_MS + 5_000
        );

        expect(Date.now() - recoveryStartedAt).toBeLessThanOrEqual(
          controlRuntime.KILO_FEED_FRESHNESS_TIMEOUT_MS + 5_000
        );
        expect(connections).toBe(4);
        expect(connections).toBeLessThanOrEqual(1 + SANDBOX_CONTROL_RECOVERY_MAX_ATTEMPTS);
        expect(failures).toEqual(['feed_ended']);
        expect(source.signal.aborted).toBe(false);
        expect(feed.prepareForNewWork()).toBe(false);
      } finally {
        feed.close();
        for (const activity of activities) clearInterval(activity);
        fetchSpy.mockRestore();
      }
    },
    controlRuntime.KILO_FEED_FRESHNESS_TIMEOUT_MS + 10_000
  );
});
