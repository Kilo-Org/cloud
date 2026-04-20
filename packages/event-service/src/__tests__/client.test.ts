import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventServiceClient, EventServiceRpcError } from '../client';

class MockWebSocket {
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readonly url: string;
  readyState = 1; // OPEN
  sent: string[] = [];

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3; // CLOSED
  }

  triggerOpen(): void {
    this.onopen?.(new Event('open'));
  }

  triggerMessage(data: unknown): void {
    const event = { data: JSON.stringify(data) } as MessageEvent;
    this.onmessage?.(event);
  }

  triggerClose(): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent('close'));
  }
}

let lastMockWs: MockWebSocket;

beforeEach(() => {
  vi.stubGlobal('WebSocket', function (url: string) {
    lastMockWs = new MockWebSocket(url);
    // Auto-trigger open asynchronously so connect() can attach handlers first
    Promise.resolve().then(() => lastMockWs.triggerOpen());
    return lastMockWs;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeClient(url = 'ws://localhost:8080') {
  return new EventServiceClient({
    url,
    getToken: () => Promise.resolve('test-token'),
  });
}

describe('EventServiceClient', () => {
  it('connects and sends subscribe for pre-registered contexts', async () => {
    const client = makeClient();
    client.subscribe(['room:123', 'user:456']);
    await client.connect();

    expect(lastMockWs.url).toBe('ws://localhost:8080/connect?token=test-token');
    expect(client.isConnected()).toBe(true);

    const messages = lastMockWs.sent.map((s) => JSON.parse(s) as unknown);
    expect(messages).toContainEqual({
      type: 'context.subscribe',
      contexts: ['room:123', 'user:456'],
    });
  });

  it('resolves RPC response by matching id', async () => {
    const client = makeClient();
    await client.connect();

    const rpcPromise = client.rpc<{ ok: boolean }>('chat', 'getMessages', { roomId: 'abc' });

    // Find the rpc message that was sent
    const rpcMsg = lastMockWs.sent
      .map((s) => JSON.parse(s) as { type: string; id: string })
      .find((m) => m.type === 'rpc');

    expect(rpcMsg).toBeDefined();

    // Simulate server response
    lastMockWs.triggerMessage({
      id: rpcMsg!.id,
      type: 'rpc.response',
      payload: { ok: true },
    });

    const result = await rpcPromise;
    expect(result).toEqual({ ok: true });
  });

  it('rejects RPC on error response with EventServiceRpcError', async () => {
    const client = makeClient();
    await client.connect();

    const rpcPromise = client.rpc('chat', 'deleteMessage', { id: '1' });

    const rpcMsg = lastMockWs.sent
      .map((s) => JSON.parse(s) as { type: string; id: string })
      .find((m) => m.type === 'rpc');

    lastMockWs.triggerMessage({
      id: rpcMsg!.id,
      type: 'rpc.error',
      error: { code: 403, body: { message: 'Forbidden' } },
    });

    await expect(rpcPromise).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof EventServiceRpcError &&
        err.code === 403 &&
        (err.body as { message: string }).message === 'Forbidden'
      );
    });
  });

  it('dispatches events to registered handlers', async () => {
    const client = makeClient();
    await client.connect();

    const received: unknown[] = [];
    client.on('room:123:message.created', (payload) => {
      received.push(payload);
    });

    lastMockWs.triggerMessage({
      type: 'event',
      context: 'room:123',
      event: 'message.created',
      payload: { text: 'hello' },
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ text: 'hello' });
  });

  it('unsubscribe (off) removes handler — event no longer received', async () => {
    const client = makeClient();
    await client.connect();

    const received: unknown[] = [];
    const off = client.on('room:123:message.created', (payload) => {
      received.push(payload);
    });

    // Trigger once — should receive
    lastMockWs.triggerMessage({
      type: 'event',
      context: 'room:123',
      event: 'message.created',
      payload: { text: 'first' },
    });

    // Remove handler
    off();

    // Trigger again — should NOT receive
    lastMockWs.triggerMessage({
      type: 'event',
      context: 'room:123',
      event: 'message.created',
      payload: { text: 'second' },
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ text: 'first' });
  });
});
