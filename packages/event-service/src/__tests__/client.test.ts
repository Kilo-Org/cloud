import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventServiceClient } from '../client';

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

    const messages = lastMockWs.sent.map(s => JSON.parse(s) as unknown);
    expect(messages).toContainEqual({
      type: 'context.subscribe',
      contexts: ['room:123', 'user:456'],
    });
  });

  it('dispatches events to registered handlers', async () => {
    const client = makeClient();
    await client.connect();

    const received: Array<{ context: string; payload: unknown }> = [];
    client.on('message.created', (context, payload) => {
      received.push({ context, payload });
    });

    lastMockWs.triggerMessage({
      type: 'event',
      context: 'room:123',
      event: 'message.created',
      payload: { text: 'hello' },
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ context: 'room:123', payload: { text: 'hello' } });
  });

  it('unsubscribe (off) removes handler — event no longer received', async () => {
    const client = makeClient();
    await client.connect();

    const received: Array<{ context: string; payload: unknown }> = [];
    const off = client.on('message.created', (context, payload) => {
      received.push({ context, payload });
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
    expect(received[0]).toEqual({ context: 'room:123', payload: { text: 'first' } });
  });
});
