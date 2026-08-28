import { describe, expect, it } from 'bun:test';
import {
  maybeStartSandboxControlClient,
  startSandboxControlEventFeed,
} from './sandbox-control-runtime';
import type { SandboxControlClient, SandboxControlClientOptions } from './sandbox-control-client';

function fakeClient(): SandboxControlClient {
  return {
    connect: async () => {},
    close: () => {},
    sendEvent: () => {},
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
    expect(received?.onReconnect).toBeTypeOf('function');
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
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual([
      { event: 'sandbox.ready', payload: { kiloReady: true, globalFeedAttached: true } },
    ]);
    started?.close();
  });

  it('emits sandbox.ready then an immediate heartbeat when getHeartbeatPayload is set', async () => {
    const events: Array<{ event: string; payload: unknown }> = [];
    const heartbeatPayload = {
      state: 'idle',
      kilo: { ready: true },
      sessions: [],
    };
    const client: SandboxControlClient = {
      connect: async () => {},
      close: () => {},
      sendEvent: (event, payload) => {
        events.push({ event, payload });
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

    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual([
      { event: 'sandbox.ready', payload: { kiloReady: true, globalFeedAttached: true } },
      { event: 'sandbox.heartbeat', payload: heartbeatPayload },
    ]);
    started?.close();
  });

  it('emits readiness and heartbeats only while the Kilo event feed is live', async () => {
    const events: Array<{ event: string; payload: unknown }> = [];
    const heartbeatPayload = { state: 'idle', kilo: { ready: true }, sessions: [] };
    let ready = false;
    let received: SandboxControlClientOptions | undefined;
    const client: SandboxControlClient = {
      connect: async () => {},
      close: () => {},
      sendEvent: (event, payload) => {
        events.push({ event, payload });
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

    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual([]);

    ready = true;
    received?.onReconnect?.();
    expect(events).toEqual([
      { event: 'sandbox.ready', payload: { kiloReady: true, globalFeedAttached: true } },
      { event: 'sandbox.heartbeat', payload: heartbeatPayload },
    ]);

    ready = false;
    received?.onReconnect?.();
    expect(events).toHaveLength(2);
    started?.close();
  });

  it('emits ready and heartbeat again on reconnect without duplicating timers', async () => {
    const events: Array<{ event: string; payload: unknown }> = [];
    const connected: SandboxControlClient[] = [];
    const heartbeatPayload = { state: 'idle' };
    let received: SandboxControlClientOptions | undefined;
    const client: SandboxControlClient = {
      connect: async () => {},
      close: () => {},
      sendEvent: (event, payload) => {
        events.push({ event, payload });
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

    await Promise.resolve();
    await Promise.resolve();
    received?.onReconnect?.();
    expect(connected).toEqual([client, client]);
    expect(events).toEqual([
      { event: 'sandbox.ready', payload: { kiloReady: true, globalFeedAttached: true } },
      { event: 'sandbox.heartbeat', payload: heartbeatPayload },
      { event: 'sandbox.ready', payload: { kiloReady: true, globalFeedAttached: true } },
      { event: 'sandbox.heartbeat', payload: heartbeatPayload },
    ]);
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

    await Promise.resolve();
    await Promise.resolve();
    started?.close();
    received?.onReconnect?.();
    received?.log?.('sandbox control reconnect scheduled in 0ms (socket closed)');
    expect(events).toEqual([]);
    expect(logs.join('\n')).not.toContain(credential);
    expect(logs.join('\n')).not.toContain('Authorization');
    expect(logs.some(line => line.includes('sandbox control client failed'))).toBe(true);
  });
});

describe('startSandboxControlEventFeed', () => {
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
        expect(signal).toBe(abort.signal);
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

    await Promise.resolve();
    await Promise.resolve();
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
    expect(failures[0]).toEqual(new Error('Kilo global event feed ended'));
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
