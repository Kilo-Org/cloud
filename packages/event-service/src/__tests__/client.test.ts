import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventServiceClient } from '../client';

class MockWebSocket {
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readonly url: string;
  readyState = 1; // OPEN
  sent: string[] = [];

  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: (...args: unknown[]) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3; // CLOSED
  }

  triggerOpen(): void {
    for (const fn of this.listeners.get('open') ?? []) fn(new Event('open'));
  }

  triggerMessage(data: unknown): void {
    const event = { data: JSON.stringify(data) } as MessageEvent;
    for (const fn of this.listeners.get('message') ?? []) fn(event);
  }

  triggerClose(): void {
    this.readyState = 3;
    for (const fn of this.listeners.get('close') ?? []) fn(new CloseEvent('close'));
  }

  triggerError(): void {
    for (const fn of this.listeners.get('error') ?? []) fn(new Event('error'));
  }
}

let lastMockWs: MockWebSocket;
let allMockWs: MockWebSocket[];

beforeEach(() => {
  allMockWs = [];
  // Mock the ticket endpoint — connect() does a fetch before opening the WS
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ticket: 'test-ticket', userId: 'user-123' }),
    })
  );
  vi.stubGlobal('WebSocket', function (url: string) {
    lastMockWs = new MockWebSocket(url);
    allMockWs.push(lastMockWs);
    // Auto-trigger open asynchronously so connect() can attach handlers first
    void Promise.resolve().then(() => lastMockWs.triggerOpen());
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

    expect(lastMockWs.url).toBe('ws://localhost:8080/connect?ticket=test-ticket&userId=user-123');
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

  it('auto-reconnects after disconnect() → connect() cycle', async () => {
    vi.useFakeTimers();
    const client = makeClient();

    // 1. Connect normally
    await client.connect();
    expect(client.isConnected()).toBe(true);

    // 2. Disconnect — sets destroyed = true internally
    client.disconnect();
    expect(client.isConnected()).toBe(false);

    // 3. Re-connect on the same instance (e.g. React remount with stable ref)
    await client.connect();
    expect(client.isConnected()).toBe(true);
    const wsAfterReconnect = lastMockWs;

    // 4. Simulate unexpected socket close — should trigger auto-reconnect
    wsAfterReconnect.triggerClose();
    expect(client.isConnected()).toBe(false);

    // 5. Advance past the max first-attempt delay (1000ms * jitter ≤ 1000ms)
    await vi.advanceTimersByTimeAsync(4000);

    // connect() resets destroyed, so onclose schedules a reconnect.
    // 3 WebSockets total: initial + re-connect + auto-reconnect
    expect(allMockWs).toHaveLength(3);

    vi.useRealTimers();
  });

  it('closes previous WebSocket on repeated connect() calls', async () => {
    const client = makeClient();

    // First connect
    await client.connect();
    const ws1 = lastMockWs;
    expect(ws1.readyState).toBe(1); // OPEN

    // Second connect without disconnect — should close the first socket
    await client.connect();
    const ws2 = lastMockWs;

    expect(ws1).not.toBe(ws2);
    expect(ws1.readyState).toBe(3); // CLOSED — properly cleaned up
    expect(allMockWs).toHaveLength(2);
  });

  it('error+close before open schedules a single reconnect timer', async () => {
    vi.useFakeTimers();
    try {
      let wsCount = 0;
      // Override the WebSocket mock so the first socket errors before open
      // (error → close, the sequence browsers fire). The second socket
      // succeeds normally so we can count reconnect attempts cleanly.
      vi.stubGlobal('WebSocket', function (url: string) {
        lastMockWs = new MockWebSocket(url);
        allMockWs.push(lastMockWs);
        wsCount++;
        if (wsCount === 1) {
          lastMockWs.readyState = 0; // CONNECTING
          void Promise.resolve().then(() => {
            lastMockWs.triggerError();
            lastMockWs.triggerClose();
          });
        } else {
          // Reconnect attempt succeeds
          void Promise.resolve().then(() => lastMockWs.triggerOpen());
        }
        return lastMockWs;
      });

      const client = makeClient();
      // connect() should absorb the failure and schedule a reconnect
      await client.connect();
      expect(client.isConnected()).toBe(false);
      expect(allMockWs).toHaveLength(1);

      // Advance past the max first-attempt delay. If the bug were present,
      // two timers would fire and we'd see 3 WebSockets (original + 2
      // reconnects). With the fix, exactly one reconnect fires.
      await vi.advanceTimersByTimeAsync(2000);
      expect(allMockWs).toHaveLength(2);
      expect(client.isConnected()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('schedules reconnect after initial ticket failure', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 503 })
        .mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ ticket: 'retry-ticket', userId: 'user-123' }),
        });
      vi.stubGlobal('fetch', fetchMock);
      const client = makeClient();

      await expect(client.connect()).resolves.toBeUndefined();
      expect(allMockWs).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1000);
      expect(allMockWs).toHaveLength(1);
      expect(lastMockWs.url).toBe(
        'ws://localhost:8080/connect?ticket=retry-ticket&userId=user-123'
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
