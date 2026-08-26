import { describe, expect, it } from 'bun:test';
import { maybeStartSandboxControlClient } from './sandbox-control-runtime';
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
        throw new Error('sandbox control connect failed');
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
