import { describe, expect, it, spyOn } from 'bun:test';
import {
  KILO_FEED_FRESHNESS_TIMEOUT_MS,
  SANDBOX_CONTROL_REPORT_INTERVAL_MS,
  maybeStartSandboxControlClient,
  observeKiloFeedResponse,
  startSandboxControlEventFeed,
} from './sandbox-control-runtime';
import type { SandboxControlClient, SandboxControlClientOptions } from './sandbox-control-client';
import type { SandboxHeartbeatPayload } from '../../../src/shared/sandbox-control-protocol';

function fakeClient(): SandboxControlClient {
  return {
    connect: async () => {},
    close: () => {},
    sendEvent: () => true,
  };
}

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

function idlePayload(): SandboxHeartbeatPayload {
  return {
    state: 'idle',
    kilo: { ready: true },
    sessions: [],
  };
}

describe('maybeStartSandboxControlClient', () => {
  it('returns null when env is missing', () => {
    const created: SandboxControlClientOptions[] = [];
    const logs: string[] = [];

    expect(
      maybeStartSandboxControlClient({}, message => logs.push(message), {
        wrapperVersion: '2.4.0',
        createClient: options => {
          created.push(options);
          return fakeClient();
        },
      })
    ).toBeNull();

    expect(
      maybeStartSandboxControlClient(
        {
          SANDBOX_CONTROL_URL: 'wss://example.test/sandbox-control/sbx_1',
          SANDBOX_CONTROL_CREDENTIAL: 'secret',
        },
        message => logs.push(message),
        {
          wrapperVersion: '2.4.0',
          createClient: options => {
            created.push(options);
            return fakeClient();
          },
        }
      )
    ).toBeNull();

    expect(created).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('constructs a client when env is present without logging the credential', async () => {
    const credential = 'super-secret-token';
    const logs: string[] = [];
    let received: SandboxControlClientOptions | undefined;
    let connectCalls = 0;
    const client = fakeClient();
    const originalConnect = client.connect.bind(client);
    client.connect = async () => {
      connectCalls += 1;
      await originalConnect();
    };

    const started = maybeStartSandboxControlClient(
      {
        SANDBOX_CONTROL_URL: 'wss://example.test/sandbox-control/sbx_1',
        SANDBOX_CONTROL_CREDENTIAL: credential,
        PROVIDER_INSTANCE_ID: 'inst_1',
        wrapperInstanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
      message => logs.push(message),
      {
        wrapperVersion: '2.4.0',
        createClient: options => {
          received = options;
          return client;
        },
      }
    );

    expect(started).toBe(client);
    expect(received).toMatchObject({
      url: 'wss://example.test/sandbox-control/sbx_1',
      credential,
      providerInstanceId: 'inst_1',
      wrapperInstanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      wrapperVersion: '2.4.0',
    });
    expect(received?.log).toBeTypeOf('function');
    expect(received?.onConnectionLost).toBeTypeOf('function');
    expect(received?.onReconnectExhausted).toBeTypeOf('function');
    await Promise.resolve();
    expect(connectCalls).toBe(1);
    expect(logs.join('\n')).not.toContain(credential);
  });

  it('forwards onRequest and emits sandbox.ready after connect', async () => {
    const events: Array<{ event: string; payload: unknown }> = [];
    const onRequest = async () => ({ ok: true as const, result: { healthy: true } });
    let received: SandboxControlClientOptions | undefined;
    const client: SandboxControlClient = {
      connect: async () => {},
      close: () => {},
      sendEvent: (event, payload) => {
        events.push({ event, payload });
        return true;
      },
    };

    const started = maybeStartSandboxControlClient(
      {
        SANDBOX_CONTROL_URL: 'wss://example.test/sandbox-control/sbx_1',
        SANDBOX_CONTROL_CREDENTIAL: 'secret',
        PROVIDER_INSTANCE_ID: 'inst_1',
      },
      () => {},
      {
        wrapperVersion: '2.4.0',
        onRequest,
        createClient: options => {
          received = options;
          return client;
        },
      }
    );

    expect(started).toBe(client);
    expect(received?.onRequest).toBe(onRequest);
    await flushAsyncWork();
    expect(events).toEqual([
      { event: 'sandbox.ready', payload: { kiloReady: true, globalFeedAttached: true } },
    ]);
    started?.close();
  });

  it('emits sandbox.ready then an immediate heartbeat when getHeartbeatPayload is set', async () => {
    const events: Array<{ event: string; payload: unknown }> = [];
    const heartbeatPayload = idlePayload();
    const client: SandboxControlClient = {
      connect: async () => {},
      close: () => {},
      sendEvent: (event, payload) => {
        events.push({ event, payload });
        return true;
      },
    };

    const started = maybeStartSandboxControlClient(
      {
        SANDBOX_CONTROL_URL: 'wss://example.test/sandbox-control/sbx_1',
        SANDBOX_CONTROL_CREDENTIAL: 'secret',
        PROVIDER_INSTANCE_ID: 'inst_1',
      },
      () => {},
      {
        wrapperVersion: '2.4.0',
        getHeartbeatPayload: () => heartbeatPayload,
        createClient: () => client,
      }
    );

    await flushAsyncWork();
    expect(events).toEqual([
      { event: 'sandbox.ready', payload: { kiloReady: true, globalFeedAttached: true } },
      { event: 'sandbox.heartbeat', payload: heartbeatPayload },
    ]);
    started?.close();
  });

  it('emits readiness and heartbeats only while the Kilo event feed is live', async () => {
    const events: Array<{ event: string; payload: unknown }> = [];
    const heartbeatPayload = idlePayload();
    let ready = false;
    let received: SandboxControlClientOptions | undefined;
    const client: SandboxControlClient = {
      connect: async () => {},
      close: () => {},
      sendEvent: (event, payload) => {
        events.push({ event, payload });
        return true;
      },
    };

    const started = maybeStartSandboxControlClient(
      {
        SANDBOX_CONTROL_URL: 'wss://example.test/sandbox-control/sbx_1',
        SANDBOX_CONTROL_CREDENTIAL: 'secret',
        PROVIDER_INSTANCE_ID: 'inst_1',
      },
      () => {},
      {
        wrapperVersion: '2.4.0',
        isReady: () => ready,
        getHeartbeatPayload: () => heartbeatPayload,
        createClient: options => {
          received = options;
          return client;
        },
      }
    );

    await flushAsyncWork();
    expect(events).toEqual([]);

    received?.onDisconnected?.();
    ready = true;
    expect(events).toEqual([]);
    started?.close();
  });

  it('does not re-advertise readiness after an established disconnect', async () => {
    const events: Array<{ event: string; payload: unknown }> = [];
    const connected: SandboxControlClient[] = [];
    const heartbeatPayload = idlePayload();
    let received: SandboxControlClientOptions | undefined;
    const client: SandboxControlClient = {
      connect: async () => {},
      close: () => {},
      sendEvent: (event, payload) => {
        events.push({ event, payload });
        return true;
      },
    };

    maybeStartSandboxControlClient(
      {
        SANDBOX_CONTROL_URL: 'wss://example.test/sandbox-control/sbx_1',
        SANDBOX_CONTROL_CREDENTIAL: 'secret',
        PROVIDER_INSTANCE_ID: 'inst_1',
      },
      () => {},
      {
        wrapperVersion: '2.4.0',
        getHeartbeatPayload: () => heartbeatPayload,
        onConnected: startedClient => connected.push(startedClient),
        createClient: options => {
          received = options;
          return client;
        },
      }
    );

    await flushAsyncWork();
    received?.onDisconnected?.();
    expect(connected).toEqual([client]);
    expect(events).toEqual([
      { event: 'sandbox.ready', payload: { kiloReady: true, globalFeedAttached: true } },
      { event: 'sandbox.heartbeat', payload: heartbeatPayload },
    ]);
    client.close();
  });

  it('sends heartbeats on a 15-second interval independent of sampling', async () => {
    const timers = spyOn(globalThis, 'setInterval');
    const events: Array<{ event: string; payload: unknown }> = [];
    let sampleCalls = 0;
    const samplePending = Promise.withResolvers<void>();
    const heartbeatPayload = idlePayload();
    const started = maybeStartSandboxControlClient(
      {
        SANDBOX_CONTROL_URL: 'wss://example.test/sandbox-control/sbx_1',
        SANDBOX_CONTROL_CREDENTIAL: 'secret',
        PROVIDER_INSTANCE_ID: 'inst_1',
      },
      () => {},
      {
        wrapperVersion: '2.4.0',
        getHeartbeatPayload: () => heartbeatPayload,
        sampleHeartbeat: async () => {
          sampleCalls++;
          await samplePending.promise;
        },
        createClient: () => ({
          connect: async () => {},
          close: () => {},
          sendEvent: (event, payload) => {
            events.push({ event, payload });
            return true;
          },
        }),
      }
    );
    try {
      await flushAsyncWork();
      expect(events).toEqual([
        { event: 'sandbox.ready', payload: { kiloReady: true, globalFeedAttached: true } },
        { event: 'sandbox.heartbeat', payload: heartbeatPayload },
      ]);
      expect(sampleCalls).toBe(1);
      const tick = timers.mock.calls.find(
        ([, ms]) => ms === SANDBOX_CONTROL_REPORT_INTERVAL_MS
      )?.[0];
      if (typeof tick !== 'function') throw new Error('Missing heartbeat interval');
      tick();
      await flushAsyncWork();
      expect(sampleCalls).toBe(1);
      expect(events.filter(e => e.event === 'sandbox.heartbeat')).toHaveLength(2);
      samplePending.resolve();
      await flushAsyncWork();
      tick();
      await flushAsyncWork();
      expect(sampleCalls).toBe(2);
    } finally {
      started?.close();
      samplePending.resolve();
      await flushAsyncWork();
      timers.mockRestore();
    }
  });

  it('retries failed payload construction without emitting fabricated state', async () => {
    const timers = spyOn(globalThis, 'setInterval');
    const events: Array<{ event: string; payload: unknown }> = [];
    const logs: string[] = [];
    let polls = 0;
    let disconnected = 0;
    const started = maybeStartSandboxControlClient(
      {
        SANDBOX_CONTROL_URL: 'wss://example.test/sandbox-control/sbx_1',
        SANDBOX_CONTROL_CREDENTIAL: 'secret',
        PROVIDER_INSTANCE_ID: 'inst_1',
      },
      message => logs.push(message),
      {
        wrapperVersion: '2.4.0',
        onDisconnected: () => {
          disconnected++;
        },
        getHeartbeatPayload: () => {
          polls++;
          if (polls === 1) throw new Error('private-status-credential');
          return {
            state: 'active' as const,
            kilo: { ready: true },
            sessions: [{ kiloSessionId: 'kilo_1', state: 'finalizing' as const, idleForMs: 0 }],
          };
        },
        createClient: () => ({
          connect: async () => {},
          close: () => {},
          sendEvent: (event, payload) => {
            events.push({ event, payload });
            return true;
          },
        }),
      }
    );
    try {
      await flushAsyncWork();
      expect(events).toEqual([
        { event: 'sandbox.ready', payload: { kiloReady: true, globalFeedAttached: true } },
      ]);
      expect(disconnected).toBe(0);
      const tick = timers.mock.calls.find(
        ([, ms]) => ms === SANDBOX_CONTROL_REPORT_INTERVAL_MS
      )?.[0];
      if (typeof tick !== 'function') throw new Error('Missing heartbeat interval');
      tick();
      await flushAsyncWork();
      expect(polls).toBe(2);
      expect(events.at(-1)?.event).toBe('sandbox.heartbeat');
      expect(disconnected).toBe(0);
      expect(logs.join('\n')).not.toContain('private-status-credential');
    } finally {
      started?.close();
      timers.mockRestore();
    }
  });

  it.each(['false', 'throw'] as const)(
    'leaves final disconnect to reconnect exhaustion when heartbeat delivery returns %s',
    async failure => {
      const timers = spyOn(globalThis, 'setInterval');
      let disconnected = 0;
      const started = maybeStartSandboxControlClient(
        {
          SANDBOX_CONTROL_URL: 'wss://example.test/sandbox-control/sbx_1',
          SANDBOX_CONTROL_CREDENTIAL: 'secret',
          PROVIDER_INSTANCE_ID: 'inst_1',
        },
        () => {},
        {
          wrapperVersion: '2.4.0',
          getHeartbeatPayload: () => idlePayload(),
          onDisconnected: () => {
            disconnected++;
          },
          createClient: clientOptions => ({
            connect: async () => {},
            close: () => {},
            sendEvent: event => {
              if (event !== 'sandbox.heartbeat') return true;
              if (failure === 'throw') throw new Error('private transport error');
              clientOptions.onConnectionLost();
              return false;
            },
          }),
        }
      );
      try {
        await flushAsyncWork();
        expect(disconnected).toBe(0);
        expect(
          timers.mock.calls.filter(([, ms]) => ms === SANDBOX_CONTROL_REPORT_INTERVAL_MS)
        ).toHaveLength(0);
      } finally {
        started?.close();
        timers.mockRestore();
      }
    }
  );

  it('leaves final disconnect to reconnect exhaustion when the ready event fails', async () => {
    let disconnected = 0;
    const started = maybeStartSandboxControlClient(
      {
        SANDBOX_CONTROL_URL: 'wss://example.test/sandbox-control/sbx_1',
        SANDBOX_CONTROL_CREDENTIAL: 'secret',
        PROVIDER_INSTANCE_ID: 'inst_1',
      },
      () => {},
      {
        wrapperVersion: '2.4.0',
        onDisconnected: () => {
          disconnected++;
        },
        createClient: clientOptions => ({
          connect: async () => {},
          close: () => {},
          sendEvent: () => {
            clientOptions.onConnectionLost();
            return false;
          },
        }),
      }
    );
    try {
      await flushAsyncWork();
      expect(disconnected).toBe(0);
    } finally {
      started?.close();
    }
  });

  it('clears reconnect after close and omits credentials from connect failure logs', async () => {
    const credential = 'super-secret-token';
    const logs: string[] = [];
    const events: Array<{ event: string; payload: unknown }> = [];
    let received: SandboxControlClientOptions | undefined;
    const client: SandboxControlClient = {
      connect: async () => {
        throw new Error(`sandbox control connect failed: ${credential}`);
      },
      close: () => {},
      sendEvent: (event, payload) => {
        events.push({ event, payload });
        return true;
      },
    };

    const started = maybeStartSandboxControlClient(
      {
        SANDBOX_CONTROL_URL: 'wss://example.test/sandbox-control/sbx_1',
        SANDBOX_CONTROL_CREDENTIAL: credential,
        PROVIDER_INSTANCE_ID: 'inst_1',
      },
      message => logs.push(message),
      {
        wrapperVersion: '2.4.0',
        createClient: options => {
          received = options;
          return client;
        },
      }
    );

    await flushAsyncWork();
    started?.close();
    received?.onDisconnected?.();
    received?.log?.('sandbox control reconnect scheduled in 0ms (socket closed)');
    expect(events).toEqual([]);
    expect(logs.join('\n')).not.toContain(credential);
    expect(logs.join('\n')).not.toContain('Authorization');
    expect(logs.some(line => line.includes('sandbox control client failed'))).toBe(true);
  });

  it.each(['readiness', 'close', 'disconnect'] as const)(
    'cancels owned sampling and permanently stops reports after %s is lost',
    async loss => {
      const timers = spyOn(globalThis, 'setInterval');
      const cleared = spyOn(globalThis, 'clearInterval');
      const events: string[] = [];
      const sampleBlocked = Promise.withResolvers<void>();
      let ready = true;
      let sampleCalls = 0;
      let signal: AbortSignal | undefined;
      let received: SandboxControlClientOptions | undefined;
      let disconnected = 0;
      const started = maybeStartSandboxControlClient(
        {
          SANDBOX_CONTROL_URL: 'wss://example.test/control',
          SANDBOX_CONTROL_CREDENTIAL: 'secret',
          PROVIDER_INSTANCE_ID: 'inst_1',
        },
        () => {},
        {
          wrapperVersion: '2.4.0',
          isReady: () => ready,
          getHeartbeatPayload: idlePayload,
          onDisconnected: () => {
            disconnected++;
          },
          sampleHeartbeat: async input => {
            signal = input;
            sampleCalls++;
            await sampleBlocked.promise;
          },
          createClient: options => {
            received = options;
            return {
              connect: async () => {},
              close: () => {},
              sendEvent: event => {
                events.push(event);
                return true;
              },
            };
          },
        }
      );
      try {
        await flushAsyncWork();
        const tick = timers.mock.calls.find(
          ([, ms]) => ms === SANDBOX_CONTROL_REPORT_INTERVAL_MS
        )?.[0];
        if (typeof tick !== 'function') throw new Error('Missing heartbeat interval');
        expect(events).toEqual(['sandbox.ready', 'sandbox.heartbeat']);
        expect(signal?.aborted).toBe(false);
        if (loss === 'readiness') ready = false;
        else if (loss === 'close') started?.close();
        else received?.onReconnectExhausted?.();
        tick();
        expect(signal?.aborted).toBe(true);
        expect(cleared).toHaveBeenCalledTimes(1);
        sampleBlocked.resolve();
        await flushAsyncWork();
        ready = true;
        tick();
        await flushAsyncWork();
        expect(events).toEqual(['sandbox.ready', 'sandbox.heartbeat']);
        expect(sampleCalls).toBe(1);
        expect(disconnected).toBe(loss === 'disconnect' ? 1 : 0);
        expect(
          timers.mock.calls.filter(([, ms]) => ms === SANDBOX_CONTROL_REPORT_INTERVAL_MS)
        ).toHaveLength(1);
      } finally {
        started?.close();
        sampleBlocked.resolve();
        await flushAsyncWork();
        timers.mockRestore();
        cleared.mockRestore();
      }
    }
  );

  it.each(['throw', 'reject'] as const)(
    'keeps reporting and retries when sampling callbacks %s',
    async failure => {
      const timers = spyOn(globalThis, 'setInterval');
      const events: string[] = [];
      const logs: string[] = [];
      let samples = 0;
      const started = maybeStartSandboxControlClient(
        {
          SANDBOX_CONTROL_URL: 'wss://example.test/control',
          SANDBOX_CONTROL_CREDENTIAL: 'secret',
          PROVIDER_INSTANCE_ID: 'inst_1',
        },
        message => logs.push(message),
        {
          wrapperVersion: '2.4.0',
          getHeartbeatPayload: idlePayload,
          sampleHeartbeat: () => {
            samples++;
            if (failure === 'throw') throw new Error('private-native-error');
            return Promise.reject(new Error('private-native-error'));
          },
          createClient: () => ({
            connect: async () => {},
            close: () => {},
            sendEvent: event => {
              events.push(event);
              return true;
            },
          }),
        }
      );
      try {
        await flushAsyncWork();
        const tick = timers.mock.calls.find(
          ([, ms]) => ms === SANDBOX_CONTROL_REPORT_INTERVAL_MS
        )?.[0];
        if (typeof tick !== 'function') throw new Error('Missing heartbeat interval');
        tick();
        await flushAsyncWork();
        expect(events).toEqual(['sandbox.ready', 'sandbox.heartbeat', 'sandbox.heartbeat']);
        expect(samples).toBe(2);
        expect(logs.join(' ')).not.toContain('private-native-error');
      } finally {
        started?.close();
        timers.mockRestore();
      }
    }
  );
});

describe('startSandboxControlEventFeed', () => {
  it('counts raw SSE activity without requiring a parsed application event', async () => {
    const abort = new AbortController();
    const encoder = new TextEncoder();
    let activity = 0;
    const response = observeKiloFeedResponse(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(': heartbeat\n\n'));
            controller.close();
          },
        })
      ),
      abort.signal,
      () => {
        activity++;
      }
    );
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Missing feed body');
    let done = false;
    while (!done) done = (await reader.read()).done;
    expect(activity).toBe(1);
  });

  it('waits for a real first event before startup and forwards that event', async () => {
    const abort = new AbortController();
    const firstEvent = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    const received: unknown[] = [];
    const failures: unknown[] = [];
    const connected = { payload: { type: 'server.connected' } };
    abort.signal.addEventListener('abort', () => stopped.resolve(), { once: true });

    async function* stream(): AsyncGenerator<unknown> {
      await firstEvent.promise;
      yield connected;
      await stopped.promise;
    }

    let started = false;
    const starting = startSandboxControlEventFeed({
      signal: abort.signal,
      open: async signal => {
        expect(signal.aborted).toBe(false);
        return { stream: stream() };
      },
      consume: async events => {
        for await (const event of events) {
          received.push(event);
        }
      },
      onUnexpectedClose: error => failures.push(error),
    });
    void starting.then(() => {
      started = true;
    });

    await flushAsyncWork();
    expect(started).toBe(false);
    expect(received).toEqual([]);

    firstEvent.resolve();
    await starting;
    await Promise.resolve();
    expect(started).toBe(true);
    expect(received).toEqual([connected]);

    abort.abort();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(failures).toEqual([]);
  });

  it('returns the underlying iterator when a worktree stops consuming its feed', async () => {
    const abort = new AbortController();
    let closed = false;
    const failures: unknown[] = [];
    async function* stream(): AsyncGenerator<unknown> {
      try {
        yield { payload: { type: 'server.connected' } };
        yield { payload: { type: 'session.created' } };
      } finally {
        closed = true;
      }
    }
    await startSandboxControlEventFeed({
      signal: abort.signal,
      open: async () => ({ stream: stream() }),
      consume: async events => {
        for await (const event of events) {
          expect(event).toEqual({ payload: { type: 'server.connected' } });
          abort.abort();
          break;
        }
      },
      onUnexpectedClose: error => failures.push(error),
    });
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(closed).toBe(true);
    expect(failures).toEqual([]);
  });

  it('cancels a stalled iterator without waiting for failed disposal or late chunks', async () => {
    const abort = new AbortController();
    const next = Promise.withResolvers<IteratorResult<unknown>>();
    const reading = Promise.withResolvers<void>();
    const received: unknown[] = [];
    const failures: unknown[] = [];
    let first = true;
    let returned = 0;
    const stream = {
      [Symbol.asyncIterator](): AsyncIterator<unknown> {
        return {
          next: () => {
            if (first) {
              first = false;
              return Promise.resolve({ value: { payload: { type: 'server.connected' } } });
            }
            reading.resolve();
            return next.promise;
          },
          return: () => {
            returned += 1;
            return Promise.reject(new Error('iterator disposal failed'));
          },
        };
      },
    };
    const feed = await startSandboxControlEventFeed({
      signal: abort.signal,
      open: async () => ({ stream }),
      consume: async events => {
        for await (const event of events) received.push(event);
      },
      onUnexpectedClose: error => failures.push(error),
    });
    await reading.promise;
    feed.close();
    await feed.settled;
    expect(abort.signal.aborted).toBe(false);
    expect(returned).toBe(1);
    next.resolve({ value: { payload: { type: 'session.updated' } } });
    await flushAsyncWork();
    expect(received).toEqual([{ payload: { type: 'server.connected' } }]);
    expect(failures).toEqual([]);
  });

  it('aborts the transformed response reader when a subscription closes', async () => {
    const abort = new AbortController();
    const encoder = new TextEncoder();
    let cancelled = false;
    const response = observeKiloFeedResponse(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(': heartbeat\n\n'));
          },
          cancel() {
            cancelled = true;
          },
        })
      ),
      abort.signal,
      () => {}
    );
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Missing feed body');
    await reader.read();
    abort.abort();
    await reader.closed.catch(() => undefined);
    expect(cancelled).toBe(true);
  });

  it('rejects when the global feed subscription fails', async () => {
    const abort = new AbortController();
    let consumed = false;
    const failure = await startSandboxControlEventFeed({
      signal: abort.signal,
      open: async () => {
        throw new Error('Kilo server unavailable');
      },
      consume: async () => {
        consumed = true;
      },
      onUnexpectedClose: () => {},
    }).then(
      () => undefined,
      (error: unknown) => error
    );

    expect(failure).toEqual(new Error('Kilo server unavailable'));
    expect(consumed).toBe(false);
  });

  it('rejects when the global feed provides no stream', async () => {
    const abort = new AbortController();
    const failure = await startSandboxControlEventFeed({
      signal: abort.signal,
      open: async () => ({}),
      consume: async () => {},
      onUnexpectedClose: () => {},
    }).then(
      () => undefined,
      (error: unknown) => error
    );

    expect(failure).toEqual(new Error('Kilo global event feed is unavailable'));
  });

  it('rejects a stream that ends before its first event', async () => {
    const abort = new AbortController();

    async function* stream(): AsyncGenerator<unknown> {}

    const failure = await startSandboxControlEventFeed({
      signal: abort.signal,
      open: async () => ({ stream: stream() }),
      consume: async () => {},
      onUnexpectedClose: () => {},
    }).then(
      () => undefined,
      (error: unknown) => error
    );

    expect(failure).toEqual(new Error('Kilo global event feed ended before startup'));
  });

  it('reports an established feed ending as a fatal runtime failure', async () => {
    const abort = new AbortController();
    const received: unknown[] = [];
    const failures: unknown[] = [];

    async function* stream(): AsyncGenerator<unknown> {
      yield { payload: { type: 'server.connected' } };
    }

    await startSandboxControlEventFeed({
      signal: abort.signal,
      open: async () => ({ stream: stream() }),
      consume: async events => {
        for await (const event of events) {
          received.push(event);
        }
      },
      onUnexpectedClose: error => failures.push(error),
    });
    await new Promise<void>(resolve => setTimeout(resolve, 0));

    expect(received).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      reason: 'feed_ended',
      message: 'Kilo global event feed ended',
    });
  });

  it('keeps silent work healthy on raw Kilo heartbeats and retires a frozen open feed', async () => {
    const abort = new AbortController();
    const timers = spyOn(globalThis, 'setInterval');
    const failures: unknown[] = [];
    let now = 0;
    const firstConsumed = Promise.withResolvers<void>();
    let delivered: () => void = firstConsumed.resolve;
    let streamSignal: AbortSignal | undefined;
    const queue: unknown[] = [{ payload: { type: 'server.connected' } }];
    let next = Promise.withResolvers<void>();
    const stream = {
      async *[Symbol.asyncIterator]() {
        while (!abort.signal.aborted) {
          if (queue.length === 0) await next.promise;
          const event = queue.shift();
          next = Promise.withResolvers<void>();
          if (event !== undefined) yield event;
        }
      },
    };
    try {
      const feed = await startSandboxControlEventFeed({
        signal: abort.signal,
        now: () => now,
        open: async signal => {
          streamSignal = signal;
          return { stream };
        },
        consume: async events => {
          for await (const event of events) {
            expect(event).toBeDefined();
            delivered?.();
          }
        },
        onUnexpectedClose: error => failures.push(error),
      });
      await firstConsumed.promise;
      for (now = 10_000; now <= 120_000; now += 10_000) {
        const consumed = Promise.withResolvers<void>();
        delivered = consumed.resolve;
        queue.push({ payload: { type: 'server.heartbeat', properties: {} } });
        next.resolve();
        await consumed.promise;
        expect(feed.isFresh()).toBe(true);
      }
      expect(failures).toEqual([]);
      now += KILO_FEED_FRESHNESS_TIMEOUT_MS;
      expect(feed.isFresh()).toBe(false);
      const watchdog = timers.mock.calls.find(([, ms]) => ms === 10_000)?.[0];
      if (typeof watchdog !== 'function') throw new Error('missing feed freshness watchdog');
      watchdog();
      watchdog();
      expect(streamSignal?.aborted).toBe(true);
      expect(abort.signal.aborted).toBe(false);
      expect(failures).toEqual([
        expect.objectContaining({
          reason: 'feed_stale',
          message: 'Kilo global event feed stopped responding',
        }),
      ]);
    } finally {
      abort.abort();
      next.resolve();
      timers.mockRestore();
    }
  });

  it('rejects an implicit global-feed reconnect instead of forwarding across a gap', async () => {
    const abort = new AbortController();
    const failed = Promise.withResolvers<unknown>();
    const received: unknown[] = [];
    async function* stream() {
      yield { payload: { type: 'server.connected' } };
      yield { payload: { type: 'server.connected' } };
      yield { payload: { type: 'session.turn.close', properties: {} } };
    }
    const feed = await startSandboxControlEventFeed({
      signal: abort.signal,
      open: async () => ({ stream: stream() }),
      consume: async events => {
        for await (const event of events) received.push(event);
      },
      onUnexpectedClose: failed.resolve,
    });
    expect(await failed.promise).toMatchObject({
      reason: 'feed_reconnected',
      message: 'Kilo global event feed reconnected with a delivery gap',
    });
    expect(received).toHaveLength(1);
    expect(feed.isFresh()).toBe(false);
    expect(abort.signal.aborted).toBe(false);
    abort.abort();
  });

  it('reports an established feed error as a fatal runtime failure', async () => {
    const abort = new AbortController();
    const failures: unknown[] = [];
    const failure = new Error('Kilo server exited');

    async function* stream(): AsyncGenerator<unknown> {
      yield { payload: { type: 'server.connected' } };
      throw failure;
    }

    await startSandboxControlEventFeed({
      signal: abort.signal,
      open: async () => ({ stream: stream() }),
      consume: async events => {
        for await (const event of events) {
          expect(event).toEqual({ payload: { type: 'server.connected' } });
        }
      },
      onUnexpectedClose: error => failures.push(error),
    });
    await new Promise<void>(resolve => setTimeout(resolve, 0));

    expect(failures).toEqual([failure]);
  });
});
