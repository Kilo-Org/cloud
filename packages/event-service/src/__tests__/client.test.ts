import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventServiceClient, HandshakeTimeoutError } from '../client';

class MockWebSocket {
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readonly url: string;
  readonly protocols: string | string[] | undefined;
  readyState = 1; // OPEN
  sent: string[] = [];
  closeCode: number | undefined;
  closeReason: string | undefined;

  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
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

  close(code?: number, reason?: string): void {
    this.closeCode = code;
    this.closeReason = reason;
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
let ticketCounter: number;

beforeEach(() => {
  allMockWs = [];
  ticketCounter = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      ticketCounter += 1;
      return new Response(JSON.stringify({ ticket: `ticket-${ticketCounter}` }), {
        headers: { 'content-type': 'application/json' },
      });
    })
  );
  const WebSocketMock = function (url: string, protocols?: string | string[]) {
    lastMockWs = new MockWebSocket(url, protocols);
    allMockWs.push(lastMockWs);
    // Auto-trigger open asynchronously so connect() can attach handlers first
    void Promise.resolve().then(() => lastMockWs.triggerOpen());
    return lastMockWs;
  };
  WebSocketMock.OPEN = 1;
  WebSocketMock.CLOSING = 2;
  WebSocketMock.CLOSED = 3;
  vi.stubGlobal('WebSocket', WebSocketMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeClient(url = 'ws://localhost:8080') {
  return new EventServiceClient({
    url,
    getToken: () => Promise.resolve('header.payload.sig'),
  });
}

function expectNonSecretProtocol(protocols: string | string[] | undefined): void {
  expect(protocols).toEqual(['kilo.events.v1']);
  expect(JSON.stringify(protocols)).not.toContain('header.payload.sig');
  expect(JSON.stringify(protocols)).not.toContain('kilo.jwt.');
  expect(JSON.stringify(protocols)).not.toMatch(
    /eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/
  );
}

describe('EventServiceClient', () => {
  it('mints a connection ticket and uses a non-secret subprotocol for /connect', async () => {
    const client = makeClient();
    client.subscribe(['room:123', 'user:456']);
    await client.connect();

    expect(fetch).toHaveBeenCalledWith('http://localhost:8080/connect-ticket', {
      method: 'POST',
      headers: { authorization: 'Bearer header.payload.sig' },
    });
    expect(lastMockWs.url).toBe('ws://localhost:8080/connect?ticket=ticket-1');
    expectNonSecretProtocol(lastMockWs.protocols);
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

  it('reconnects after a pre-open error without refreshing auth', async () => {
    vi.useFakeTimers();
    try {
      const tokens = ['stale.token.sig', 'fresh.token.sig'];
      const getToken = vi.fn(async () => tokens.shift() ?? 'fresh.token.sig');
      const retryAuth = (): 'retry' => 'retry';
      const onUnauthorized = vi.fn(retryAuth);
      let wsCount = 0;
      const WebSocketMock = function (url: string, protocols?: string | string[]) {
        lastMockWs = new MockWebSocket(url, protocols);
        allMockWs.push(lastMockWs);
        wsCount++;
        if (wsCount === 1) {
          lastMockWs.readyState = 0; // CONNECTING
          void Promise.resolve().then(() => {
            lastMockWs.triggerError();
            lastMockWs.triggerClose();
          });
        } else {
          void Promise.resolve().then(() => lastMockWs.triggerOpen());
        }
        return lastMockWs;
      };
      WebSocketMock.OPEN = 1;
      WebSocketMock.CLOSING = 2;
      WebSocketMock.CLOSED = 3;
      vi.stubGlobal('WebSocket', WebSocketMock);

      const client = new EventServiceClient({
        url: 'ws://localhost:8080',
        getToken,
        onUnauthorized,
      });

      await client.connect();

      expect(onUnauthorized).not.toHaveBeenCalled();
      expect(client.isConnected()).toBe(false);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(allMockWs).toHaveLength(2);
      expect(getToken).toHaveBeenCalledTimes(2);
      expect(fetch).toHaveBeenLastCalledWith('http://localhost:8080/connect-ticket', {
        method: 'POST',
        headers: { authorization: 'Bearer fresh.token.sig' },
      });
      expect(allMockWs[1]?.url).toBe('ws://localhost:8080/connect?ticket=ticket-2');
      expectNonSecretProtocol(allMockWs[1]?.protocols);
      expect(client.isConnected()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops after an explicit unauthorized stop decision from connect-ticket', async () => {
    vi.useFakeTimers();
    try {
      const stopAuth = (): 'stop' => 'stop';
      const onUnauthorized = vi.fn(stopAuth);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(null, { status: 401 }))
      );

      const client = new EventServiceClient({
        url: 'ws://localhost:8080',
        getToken: () => Promise.resolve('h.p.s'),
        onUnauthorized,
      });

      await client.connect();

      expect(onUnauthorized).toHaveBeenCalledTimes(1);
      expect(allMockWs).toHaveLength(0);
      expect(client.isConnected()).toBe(false);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(allMockWs).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops after the single unauthorized retry is exhausted', async () => {
    vi.useFakeTimers();
    try {
      const retryAuth = (): 'retry' => 'retry';
      const onUnauthorized = vi.fn(retryAuth);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(null, { status: 401 }))
      );

      const client = new EventServiceClient({
        url: 'ws://localhost:8080',
        getToken: () => Promise.resolve('h.p.s'),
        onUnauthorized,
      });

      await client.connect();
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
      expect(allMockWs).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(allMockWs).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps reconnecting after repeated pre-open failures', async () => {
    vi.useFakeTimers();
    const reconnectDelay = vi.spyOn(Math, 'random').mockReturnValue(1);
    try {
      const retryAuth = (): 'retry' => 'retry';
      const onUnauthorized = vi.fn(retryAuth);
      let wsCount = 0;
      const WebSocketMock = function (url: string, protocols?: string | string[]) {
        lastMockWs = new MockWebSocket(url, protocols);
        allMockWs.push(lastMockWs);
        wsCount++;
        if (wsCount <= 2) {
          lastMockWs.readyState = 0; // CONNECTING
          void Promise.resolve().then(() => {
            lastMockWs.triggerError();
            lastMockWs.triggerClose();
          });
        } else {
          void Promise.resolve().then(() => lastMockWs.triggerOpen());
        }
        return lastMockWs;
      };
      WebSocketMock.OPEN = 1;
      WebSocketMock.CLOSING = 2;
      WebSocketMock.CLOSED = 3;
      vi.stubGlobal('WebSocket', WebSocketMock);

      const client = new EventServiceClient({
        url: 'ws://localhost:8080',
        getToken: () => Promise.resolve('h.p.s'),
        onUnauthorized,
      });
      client.subscribe(['room:configured']);

      await client.connect();
      expect(client.isConnected()).toBe(false);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(allMockWs).toHaveLength(2);
      expect(client.isConnected()).toBe(false);

      await vi.advanceTimersByTimeAsync(4_000);
      expect(allMockWs).toHaveLength(3);
      expect(client.isConnected()).toBe(true);
      expect(onUnauthorized).not.toHaveBeenCalled();
      expect(allMockWs[2]?.sent.map(s => JSON.parse(s) as unknown)).toContainEqual({
        type: 'context.subscribe',
        contexts: ['room:configured'],
      });
    } finally {
      reconnectDelay.mockRestore();
      vi.useRealTimers();
    }
  });

  it('retries non-auth pre-open failures with normal backoff', async () => {
    vi.useFakeTimers();
    try {
      let wsCount = 0;
      const WebSocketMock = function (url: string, protocols?: string | string[]) {
        lastMockWs = new MockWebSocket(url, protocols);
        allMockWs.push(lastMockWs);
        wsCount++;
        if (wsCount === 1) {
          lastMockWs.readyState = 0; // CONNECTING
          void Promise.resolve().then(() => {
            lastMockWs.triggerError();
            lastMockWs.triggerClose();
          });
        } else {
          void Promise.resolve().then(() => lastMockWs.triggerOpen());
        }
        return lastMockWs;
      };
      WebSocketMock.OPEN = 1;
      WebSocketMock.CLOSING = 2;
      WebSocketMock.CLOSED = 3;
      vi.stubGlobal('WebSocket', WebSocketMock);

      const client = new EventServiceClient({
        url: 'ws://localhost:8080',
        getToken: () => Promise.resolve('h.p.s'),
      });

      await client.connect();
      expect(client.isConnected()).toBe(false);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(allMockWs).toHaveLength(2);
      expect(client.isConnected()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects connect promise when handshake never opens (10s timeout)', async () => {
    vi.useFakeTimers();
    try {
      // Override the WebSocket mock so the socket never opens and never
      // fires error/close — i.e. stays in CONNECTING forever.
      const WebSocketMock = function (url: string, protocols?: string | string[]) {
        lastMockWs = new MockWebSocket(url, protocols);
        allMockWs.push(lastMockWs);
        lastMockWs.readyState = 0; // CONNECTING
        // no open, no error, no close — stall.
        return lastMockWs;
      };
      WebSocketMock.OPEN = 1;
      WebSocketMock.CLOSING = 2;
      WebSocketMock.CLOSED = 3;
      vi.stubGlobal('WebSocket', WebSocketMock);

      const client = makeClient();
      // client.connect() absorbs rejection and schedules reconnect, so we
      // call the underlying connectOnce-returning promise via the public
      // connect() and observe effects instead.
      const connectPromise = client.connect();

      // The handshake timer runs at HANDSHAKE_TIMEOUT_MS (10s).
      await vi.advanceTimersByTimeAsync(10_000);

      // connect() resolves either way (it catches rejection), but the
      // stalled socket should now be closed with our sentinel code/reason.
      await connectPromise;
      expect(lastMockWs.closeCode).toBe(1000);
      expect(lastMockWs.closeReason).toBe('handshake-timeout');
      expect(client.isConnected()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('normal open clears the handshake timer — no timeout close', async () => {
    vi.useFakeTimers();
    try {
      const client = makeClient();
      // Default mock fires open asynchronously (see beforeEach).
      await client.connect();
      expect(client.isConnected()).toBe(true);

      // Advance past the handshake timeout. If the timer were still armed,
      // it would call ws.close(1000, 'handshake-timeout'). It must not.
      await vi.advanceTimersByTimeAsync(15_000);
      expect(lastMockWs.closeCode).toBeUndefined();
      expect(lastMockWs.closeReason).toBeUndefined();
      expect(client.isConnected()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('disconnect() during CONNECTING cancels the in-flight handshake', async () => {
    vi.useFakeTimers();
    try {
      const WebSocketMock = function (url: string, protocols?: string | string[]) {
        lastMockWs = new MockWebSocket(url, protocols);
        allMockWs.push(lastMockWs);
        lastMockWs.readyState = 0; // CONNECTING, never opens
        return lastMockWs;
      };
      WebSocketMock.OPEN = 1;
      WebSocketMock.CLOSING = 2;
      WebSocketMock.CLOSED = 3;
      vi.stubGlobal('WebSocket', WebSocketMock);

      const client = makeClient();
      const connectPromise = client.connect();
      // Wait for the getToken microtask and the WS construction.
      await vi.advanceTimersByTimeAsync(0);

      client.disconnect();

      // The socket from disconnect() was close()'d without a code, because
      // disconnect() uses plain close(). If the handshake timer were still
      // armed, it would fire and overwrite closeCode/closeReason with the
      // timeout sentinel. Advance past the timeout to prove it does not.
      await vi.advanceTimersByTimeAsync(15_000);
      expect(lastMockWs.closeCode).toBeUndefined();
      expect(lastMockWs.closeReason).toBeUndefined();
      expect(client.isConnected()).toBe(false);

      await connectPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconnect is scheduled after handshake timeout', async () => {
    vi.useFakeTimers();
    try {
      let wsCount = 0;
      const WebSocketMock = function (url: string, protocols?: string | string[]) {
        lastMockWs = new MockWebSocket(url, protocols);
        allMockWs.push(lastMockWs);
        wsCount++;
        if (wsCount === 1) {
          // First socket stalls in CONNECTING — handshake timeout fires.
          lastMockWs.readyState = 0;
        } else {
          // Reconnect opens normally.
          void Promise.resolve().then(() => lastMockWs.triggerOpen());
        }
        return lastMockWs;
      };
      WebSocketMock.OPEN = 1;
      WebSocketMock.CLOSING = 2;
      WebSocketMock.CLOSED = 3;
      vi.stubGlobal('WebSocket', WebSocketMock);

      const client = makeClient();
      // Do not await: connect() hangs on the stalled handshake until the
      // timeout fires. Kick it off, advance time, then await.
      const connectPromise = client.connect();
      await vi.advanceTimersByTimeAsync(10_000);
      await connectPromise;

      // Handshake timeout closed the first socket with the sentinel reason,
      // and rejected the in-flight promise. Reconnect is scheduled on top of
      // the initial backoff window (≤ 1s for the first attempt).
      expect(allMockWs[0]?.closeReason).toBe('handshake-timeout');
      await vi.advanceTimersByTimeAsync(2_000);
      expect(allMockWs).toHaveLength(2);
      expect(client.isConnected()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('exports HandshakeTimeoutError', () => {
    // Sanity check on the public error type.
    const err = new HandshakeTimeoutError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('HandshakeTimeoutError');
  });

  describe('subscribe/unsubscribe refcounting', () => {
    function sentMessages() {
      return lastMockWs.sent.map(s => JSON.parse(s) as unknown);
    }

    it('only sends one wire context.subscribe when two consumers subscribe to the same context', async () => {
      const client = makeClient();
      await client.connect();
      lastMockWs.sent = [];

      client.subscribe(['room:1']);
      client.subscribe(['room:1']);

      expect(sentMessages()).toEqual([{ type: 'context.subscribe', contexts: ['room:1'] }]);
    });

    it('keeps the subscription alive when one of two consumers unsubscribes', async () => {
      const client = makeClient();
      await client.connect();
      lastMockWs.sent = [];

      client.subscribe(['room:1']);
      client.subscribe(['room:1']);
      client.unsubscribe(['room:1']);

      // Only the initial 0→1 subscribe should have been sent. No unsubscribe yet
      // because the second consumer is still holding a ref.
      expect(sentMessages()).toEqual([{ type: 'context.subscribe', contexts: ['room:1'] }]);
    });

    it('sends context.unsubscribe only when the last consumer drops the ref (1→0)', async () => {
      const client = makeClient();
      await client.connect();
      lastMockWs.sent = [];

      client.subscribe(['room:1']);
      client.subscribe(['room:1']);
      client.unsubscribe(['room:1']);
      client.unsubscribe(['room:1']);

      expect(sentMessages()).toEqual([
        { type: 'context.subscribe', contexts: ['room:1'] },
        { type: 'context.unsubscribe', contexts: ['room:1'] },
      ]);
    });

    it('handles a mixed batch: only newly-active contexts get sent', async () => {
      const client = makeClient();
      await client.connect();
      client.subscribe(['room:1']);
      lastMockWs.sent = [];

      // room:1 already at refcount 1, room:2 is new. Only room:2 should hit the wire.
      client.subscribe(['room:1', 'room:2']);

      expect(sentMessages()).toEqual([{ type: 'context.subscribe', contexts: ['room:2'] }]);
    });

    it('extra unsubscribes for an unknown context are no-ops', async () => {
      const client = makeClient();
      await client.connect();
      lastMockWs.sent = [];

      // Never subscribed — must not crash and must not emit a wire message.
      client.unsubscribe(['ghost']);

      expect(sentMessages()).toEqual([]);
    });

    it('resubscribe-on-reconnect deduplicates by context (one entry per active context)', async () => {
      vi.useFakeTimers();
      const client = makeClient();
      await client.connect();

      // Two consumers hold the same context.
      client.subscribe(['room:1']);
      client.subscribe(['room:1']);

      // Drop the connection — auto-reconnect kicks in.
      lastMockWs.triggerClose();
      await vi.advanceTimersByTimeAsync(2000);
      expect(allMockWs.length).toBe(2);
      // The second mock socket also auto-triggers open via the global stub.
      await vi.advanceTimersByTimeAsync(0);

      const resubMessages = allMockWs[1].sent
        .map(s => JSON.parse(s) as { type: string; contexts?: string[] })
        .filter(m => m.type === 'context.subscribe');

      // Exactly one resubscribe message containing the context exactly once,
      // regardless of how many consumers hold the ref.
      expect(resubMessages).toHaveLength(1);
      expect(resubMessages[0]?.contexts).toEqual(['room:1']);

      vi.useRealTimers();
    });
  });
});
