import { describe, expect, it } from 'bun:test';
import {
  createSandboxControlClient,
  type SandboxControlClientOptions,
} from './sandbox-control-client';

class FakeWebSocket {
  readyState = 0;
  sent: string[] = [];
  private listeners = new Map<string, Set<(event: MessageEvent | Event) => void>>();

  addEventListener(type: string, listener: (event: MessageEvent | Event) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: MessageEvent | Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close', new Event('close'));
  }

  error(): void {
    this.emit('error', new Event('error'));
  }

  open(): void {
    this.readyState = 1;
    this.emit('open', new Event('open'));
  }

  respond(data: string): void {
    this.emit('message', { data } as MessageEvent);
  }

  private emit(type: string, event: MessageEvent | Event): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

describe('createSandboxControlClient', () => {
  it('opens with an Authorization header and completes sandbox.hello plus status probe', async () => {
    const fake = new FakeWebSocket();
    const client = createSandboxControlClient({
      url: 'wss://example.test/sandbox-control/sbx_1',
      credential: 'secret',
      wrapperVersion: '2.4.0',
      providerInstanceId: 'inst_1',
      openWebSocket: (url, credential) => {
        expect(url).toBe('wss://example.test/sandbox-control/sbx_1');
        expect(credential).toBe('secret');
        return fake as unknown as WebSocket;
      },
    });

    const connecting = client.connect();
    await Promise.resolve();
    fake.open();
    await Promise.resolve();
    expect(fake.sent).toHaveLength(1);
    const hello = JSON.parse(fake.sent[0] ?? '{}') as {
      requestId: string;
      operation: string;
      payload: { protocolVersion: number; wrapperVersion: string; providerInstanceId: string };
    };
    expect(hello.operation).toBe('sandbox.hello');
    expect(hello.payload).toEqual({
      protocolVersion: 1,
      wrapperVersion: '2.4.0',
      providerInstanceId: 'inst_1',
    });
    fake.respond(
      JSON.stringify({
        type: 'response',
        requestId: hello.requestId,
        ok: true,
        result: { protocolVersion: 1, handshakeComplete: true },
      })
    );
    fake.respond(
      JSON.stringify({
        type: 'request',
        requestId: 'status-1',
        operation: 'sandbox.status',
        payload: {},
      })
    );
    await connecting;
    expect(fake.sent[1]).toBe(
      JSON.stringify({
        type: 'response',
        requestId: 'status-1',
        ok: true,
      })
    );
    client.close();
    expect(fake.readyState).toBe(3);
  });

  it('includes the wrapper process instance in sandbox.hello without exposing the credential', async () => {
    const fake = new FakeWebSocket();
    const wrapperInstanceId = crypto.randomUUID();
    const client = createSandboxControlClient({
      url: 'wss://example.test/sandbox-control/sbx_1',
      credential: 'master-control-secret',
      providerInstanceId: 'inst_1',
      wrapperInstanceId,
      openWebSocket: () => fake as unknown as WebSocket,
    });

    const connecting = client.connect();
    await handshake(fake);
    await connecting;

    expect(JSON.parse(fake.sent[0] ?? '{}')).toMatchObject({
      operation: 'sandbox.hello',
      payload: { providerInstanceId: 'inst_1', wrapperInstanceId },
    });
    expect(fake.sent[0]).not.toContain('master-control-secret');
    client.close();
  });

  it('answers inbound sandbox.status after handshake when onRequest is provided', async () => {
    const fake = new FakeWebSocket();
    const client = createSandboxControlClient({
      url: 'wss://example.test/sandbox-control/sbx_1',
      credential: 'secret',
      providerInstanceId: 'inst_1',
      openWebSocket: () => fake as unknown as WebSocket,
      onRequest: async operation => {
        expect(operation).toBe('sandbox.status');
        return {
          ok: true,
          result: { healthy: true, state: 'idle', version: '2.4.0', kiloReady: true },
        };
      },
    });

    const connecting = client.connect();
    await Promise.resolve();
    fake.open();
    await Promise.resolve();
    const hello = JSON.parse(fake.sent[0] ?? '{}') as { requestId: string };
    fake.respond(
      JSON.stringify({
        type: 'response',
        requestId: hello.requestId,
        ok: true,
        result: { protocolVersion: 1, handshakeComplete: true },
      })
    );
    fake.respond(
      JSON.stringify({
        type: 'request',
        requestId: 'status-1',
        operation: 'sandbox.status',
        payload: {},
      })
    );
    await connecting;

    fake.respond(
      JSON.stringify({
        type: 'request',
        requestId: 'status-2',
        operation: 'sandbox.status',
        payload: {},
      })
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(JSON.parse(fake.sent[2] ?? '{}')).toEqual({
      type: 'response',
      requestId: 'status-2',
      ok: true,
      result: { healthy: true, state: 'idle', version: '2.4.0', kiloReady: true },
    });
    client.close();
  });

  it('includes session on sendEvent when provided', async () => {
    const fake = new FakeWebSocket();
    const client = createSandboxControlClient({
      url: 'wss://example.test/sandbox-control/sbx_1',
      credential: 'secret',
      providerInstanceId: 'inst_1',
      openWebSocket: () => fake as unknown as WebSocket,
    });

    const connecting = client.connect();
    await Promise.resolve();
    fake.open();
    await Promise.resolve();
    const hello = JSON.parse(fake.sent[0] ?? '{}') as { requestId: string };
    fake.respond(
      JSON.stringify({
        type: 'response',
        requestId: hello.requestId,
        ok: true,
        result: { protocolVersion: 1, handshakeComplete: true },
      })
    );
    fake.respond(
      JSON.stringify({
        type: 'request',
        requestId: 'status-1',
        operation: 'sandbox.status',
        payload: {},
      })
    );
    await connecting;

    client.sendEvent?.('session.event', { type: 'session.idle', properties: {} });
    client.sendEvent?.(
      'session.event',
      { type: 'session.status', properties: { sessionID: 'ses_1' } },
      {
        directory: '/workspace',
        kiloSessionId: 'ses_1',
        rootKiloSessionId: 'ses_1',
      }
    );

    expect(JSON.parse(fake.sent[2] ?? '{}')).toEqual({
      type: 'event',
      event: 'session.event',
      payload: { type: 'session.idle', properties: {} },
    });
    expect(JSON.parse(fake.sent[3] ?? '{}')).toEqual({
      type: 'event',
      event: 'session.event',
      session: {
        directory: '/workspace',
        kiloSessionId: 'ses_1',
        rootKiloSessionId: 'ses_1',
      },
      payload: { type: 'session.status', properties: { sessionID: 'ses_1' } },
    });
    client.close();
  });

  it('retains its original wrapper process instance across socket reconnects', async () => {
    const sockets: FakeWebSocket[] = [];
    const wrapperInstanceId = crypto.randomUUID();
    let reconnects = 0;
    const options: SandboxControlClientOptions = {
      url: 'wss://example.test/sandbox-control/sbx_1',
      credential: 'secret',
      providerInstanceId: 'inst_1',
      wrapperInstanceId,
      reconnectDelayMs: () => 0,
      onReconnect: () => {
        reconnects += 1;
      },
      openWebSocket: () => {
        const next = new FakeWebSocket();
        sockets.push(next);
        return next as unknown as WebSocket;
      },
    };
    const client = createSandboxControlClient(options);

    const connecting = client.connect();
    await handshake(sockets[0]);
    await connecting;
    expect(reconnects).toBe(0);
    expect(JSON.parse(sockets[0]?.sent[0] ?? '{}')).toMatchObject({
      payload: { wrapperInstanceId },
    });

    options.wrapperInstanceId = crypto.randomUUID();
    sockets[0]?.close();
    await waitForReconnect();
    expect(sockets).toHaveLength(2);
    await handshake(sockets[1]);
    expect(reconnects).toBe(1);
    expect(JSON.parse(sockets[1]?.sent[0] ?? '{}')).toMatchObject({
      operation: 'sandbox.hello',
      payload: { wrapperInstanceId },
    });
    client.close();
  });

  it('retries a failed sandbox.hello until handshake succeeds', async () => {
    const sockets: FakeWebSocket[] = [];
    const client = createSandboxControlClient({
      url: 'wss://example.test/sandbox-control/sbx_1',
      credential: 'secret',
      providerInstanceId: 'inst_1',
      reconnectDelayMs: () => 0,
      openWebSocket: () => {
        const next = new FakeWebSocket();
        sockets.push(next);
        return next as unknown as WebSocket;
      },
    });

    const connecting = client.connect();
    await Promise.resolve();
    const first = sockets[0];
    if (!first) throw new Error('missing first socket');
    first.open();
    await Promise.resolve();
    const hello = JSON.parse(first.sent[0] ?? '{}') as { requestId: string };
    first.respond(
      JSON.stringify({
        type: 'response',
        requestId: hello.requestId,
        ok: false,
        error: { code: 'unavailable', message: 'sandbox.hello failed', retryable: true },
      })
    );
    await waitForReconnect();
    expect(sockets).toHaveLength(2);
    await handshake(sockets[1]);
    await connecting;
    client.close();
  });

  it('retries the initial open failure until handshake succeeds', async () => {
    const sockets: FakeWebSocket[] = [];
    const client = createSandboxControlClient({
      url: 'wss://example.test/sandbox-control/sbx_1',
      credential: 'secret',
      providerInstanceId: 'inst_1',
      reconnectDelayMs: () => 0,
      openWebSocket: () => {
        const next = new FakeWebSocket();
        sockets.push(next);
        return next as unknown as WebSocket;
      },
    });

    const connecting = client.connect();
    await Promise.resolve();
    sockets[0]?.close();
    await waitForReconnect();
    expect(sockets).toHaveLength(2);
    await handshake(sockets[1]);
    await connecting;
    client.close();
  });

  it('does not start concurrent reconnects when close and error both fire', async () => {
    const sockets: FakeWebSocket[] = [];
    const client = createSandboxControlClient({
      url: 'wss://example.test/sandbox-control/sbx_1',
      credential: 'secret',
      providerInstanceId: 'inst_1',
      reconnectDelayMs: () => 0,
      openWebSocket: () => {
        const next = new FakeWebSocket();
        sockets.push(next);
        return next as unknown as WebSocket;
      },
    });

    const connecting = client.connect();
    await handshake(sockets[0]);
    await connecting;
    sockets[0]?.error();
    sockets[0]?.close();
    await waitForReconnect();
    expect(sockets).toHaveLength(2);
    client.close();
  });

  it('does not reconnect after explicit close', async () => {
    const sockets: FakeWebSocket[] = [];
    const client = createSandboxControlClient({
      url: 'wss://example.test/sandbox-control/sbx_1',
      credential: 'secret',
      providerInstanceId: 'inst_1',
      reconnectDelayMs: () => 0,
      openWebSocket: () => {
        const next = new FakeWebSocket();
        sockets.push(next);
        return next as unknown as WebSocket;
      },
    });

    const connecting = client.connect();
    await handshake(sockets[0]);
    await connecting;
    client.close();
    await waitForReconnect();
    await waitForReconnect();
    expect(sockets).toHaveLength(1);
  });

  it('ignores inbound requests from a replaced socket', async () => {
    const sockets: FakeWebSocket[] = [];
    const client = createSandboxControlClient({
      url: 'wss://example.test/sandbox-control/sbx_1',
      credential: 'secret',
      providerInstanceId: 'inst_1',
      reconnectDelayMs: () => 0,
      onRequest: async () => ({ ok: true, result: { healthy: true } }),
      openWebSocket: () => {
        const next = new FakeWebSocket();
        sockets.push(next);
        return next as unknown as WebSocket;
      },
    });

    const connecting = client.connect();
    await handshake(sockets[0]);
    await connecting;
    const first = sockets[0];
    if (!first) throw new Error('missing first socket');
    first.close();
    await waitForReconnect();
    await handshake(sockets[1]);

    first.readyState = 1;
    const sentBefore = first.sent.length;
    first.respond(
      JSON.stringify({
        type: 'request',
        requestId: 'stale-status',
        operation: 'sandbox.status',
        payload: {},
      })
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(first.sent).toHaveLength(sentBefore);

    client.sendEvent?.('sandbox.ready', { kiloReady: true });
    expect(JSON.parse(sockets[1]?.sent[2] ?? '{}')).toMatchObject({
      type: 'event',
      event: 'sandbox.ready',
    });
    client.close();
  });

  it('does not log credentials included in an untrusted handshake failure', async () => {
    const credential = 'super-secret-token';
    const logs: string[] = [];
    const sockets: FakeWebSocket[] = [];
    const client = createSandboxControlClient({
      url: 'wss://example.test/sandbox-control/sbx_1?token=signed-url-secret',
      credential,
      providerInstanceId: 'inst_1',
      reconnectDelayMs: () => 0,
      log: message => logs.push(message),
      openWebSocket: () => {
        const next = new FakeWebSocket();
        sockets.push(next);
        return next as unknown as WebSocket;
      },
    });

    const connecting = client.connect();
    await Promise.resolve();
    const first = sockets[0];
    if (!first) throw new Error('missing first socket');
    first.open();
    await Promise.resolve();
    const hello = JSON.parse(first.sent[0] ?? '{}') as { requestId: string };
    first.respond(
      JSON.stringify({
        type: 'response',
        requestId: hello.requestId,
        ok: false,
        error: {
          code: 'unauthorized',
          message: `rejected ${credential} signed-url-secret`,
          retryable: true,
        },
      })
    );
    await waitForReconnect();
    await handshake(sockets[1]);
    await connecting;

    expect(logs.join('\n')).not.toContain(credential);
    expect(logs.join('\n')).not.toContain('signed-url-secret');
    expect(logs).toContain('sandbox control connect failed');
    client.close();
  });

  it('does not log credentials or the signed url on retry', async () => {
    const credential = 'super-secret-token';
    const logs: string[] = [];
    const sockets: FakeWebSocket[] = [];
    const client = createSandboxControlClient({
      url: 'wss://example.test/sandbox-control/sbx_1?token=signed-url-secret',
      credential,
      providerInstanceId: 'inst_1',
      reconnectDelayMs: () => 0,
      log: message => logs.push(message),
      openWebSocket: () => {
        const next = new FakeWebSocket();
        sockets.push(next);
        return next as unknown as WebSocket;
      },
    });

    const connecting = client.connect();
    await Promise.resolve();
    sockets[0]?.close();
    await waitForReconnect();
    await handshake(sockets[1]);
    await connecting;
    const joined = logs.join('\n');
    expect(joined).not.toContain(credential);
    expect(joined).not.toContain('signed-url-secret');
    expect(joined).not.toContain('Authorization');
    expect(joined).toContain('sandbox control connect failed');
    client.close();
  });
});

async function handshake(fake: FakeWebSocket | undefined): Promise<void> {
  if (!fake) throw new Error('missing socket');
  await Promise.resolve();
  fake.open();
  await Promise.resolve();
  const hello = JSON.parse(fake.sent[0] ?? '{}') as { requestId: string };
  fake.respond(
    JSON.stringify({
      type: 'response',
      requestId: hello.requestId,
      ok: true,
      result: { protocolVersion: 1, handshakeComplete: true },
    })
  );
  fake.respond(
    JSON.stringify({
      type: 'request',
      requestId: 'status-1',
      operation: 'sandbox.status',
      payload: {},
    })
  );
  await Promise.resolve();
}

async function waitForReconnect(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>(resolve => {
    setTimeout(resolve, 0);
  });
}
