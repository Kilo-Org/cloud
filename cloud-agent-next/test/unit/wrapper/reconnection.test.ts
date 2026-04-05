/**
 * Unit tests for ingest WebSocket reconnection logic in createConnectionManager.
 *
 * Tests exponential backoff, event buffering during disconnection,
 * heartbeat pause/resume, and close-during-reconnect scenarios.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  createConnectionManager,
  type ConnectionCallbacks,
} from '../../../wrapper/src/connection.js';
import { WrapperState, type JobContext } from '../../../wrapper/src/state.js';
import type { WrapperKiloClient } from '../../../wrapper/src/kilo-api.js';
import type { IngestEvent } from '../../../src/shared/protocol.js';

// ---------------------------------------------------------------------------
// Polyfills for Node.js test environment
// ---------------------------------------------------------------------------

// CloseEvent is a browser API not available in Node — provide a minimal shim
if (typeof CloseEvent === 'undefined') {
  const g = globalThis as Record<string, unknown>;
  g.CloseEvent = class extends Event {
    code: number;
    reason: string;
    wasClean: boolean;
    constructor(type: string, init?: { code?: number; reason?: string; wasClean?: boolean }) {
      super(type);
      this.code = init?.code ?? 0;
      this.reason = init?.reason ?? '';
      this.wasClean = init?.wasClean ?? false;
    }
  };
}

// MessageEvent may also be missing in some Node versions
if (typeof MessageEvent === 'undefined') {
  const g = globalThis as Record<string, unknown>;
  g.MessageEvent = class extends Event {
    data: unknown;
    constructor(type: string, init?: { data?: unknown }) {
      super(type);
      this.data = init?.data;
    }
  };
}

// ---------------------------------------------------------------------------
// MockWebSocket
// ---------------------------------------------------------------------------

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  sent: string[] = [];
  url: string;

  constructor(url: string, _options?: unknown) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(_code?: number, _reason?: string): void {
    this.readyState = MockWebSocket.CLOSED;
  }

  // Test helpers
  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  simulateClose(code = 1006, reason = ''): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code, reason }));
  }

  simulateError(): void {
    this.onerror?.(new Event('error'));
  }

  static reset(): void {
    MockWebSocket.instances = [];
  }

  static get latest(): MockWebSocket | undefined {
    return MockWebSocket.instances[MockWebSocket.instances.length - 1];
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const createJobContext = (): JobContext => ({
  executionId: 'exec_test',
  sessionId: 'session_abc',
  userId: 'user_xyz',
  kiloSessionId: 'kilo_sess_456',
  ingestUrl: 'wss://ingest.example.com/ingest',
  ingestToken: 'token_secret',
  workerAuthToken: 'kilo_token_789',
});

const createCallbacks = (): ConnectionCallbacks & {
  onReconnecting: ReturnType<typeof vi.fn>;
  onReconnected: ReturnType<typeof vi.fn>;
  onDisconnect: ReturnType<typeof vi.fn>;
} => ({
  onMessageComplete: vi.fn(),
  onTerminalError: vi.fn(),
  onCommand: vi.fn(),
  onDisconnect: vi.fn(),
  onCompletionSignal: vi.fn(),
  onReconnecting: vi.fn(),
  onReconnected: vi.fn(),
});

const createMockKiloClient = (): WrapperKiloClient => ({
  createSession: vi.fn().mockResolvedValue({ id: 'kilo_sess' }),
  getSession: vi.fn().mockResolvedValue({ id: 'kilo_sess' }),
  sendPromptAsync: vi.fn().mockResolvedValue(undefined),
  abortSession: vi.fn().mockResolvedValue(true),
  sendCommand: vi.fn().mockResolvedValue(undefined),
  answerPermission: vi.fn().mockResolvedValue(true),
  answerQuestion: vi.fn().mockResolvedValue(true),
  rejectQuestion: vi.fn().mockResolvedValue(true),
  generateCommitMessage: vi.fn().mockResolvedValue({ message: 'test commit' }),
  sdkClient: {
    event: {
      // Return a stream that never yields — keeps event subscription alive
      subscribe: vi.fn().mockResolvedValue({
        stream: (async function* () {
          // Never yield — keeps alive without events
          await new Promise(() => {});
        })(),
      }),
    },
  } as unknown as WrapperKiloClient['sdkClient'],
  serverUrl: 'http://127.0.0.1:0',
});

/**
 * Mock fetch to simulate a never-ending SSE stream.
 * The ReadableStream stays open so the SSE consumer never closes.
 */
function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(() => {
      const stream = new ReadableStream({
        start() {
          // Never push data — keeps SSE consumer alive without events
        },
      });
      return Promise.resolve(
        new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      );
    })
  );
}

/**
 * Open the connection manager, simulating WS open so the promise resolves.
 * Returns the initial MockWebSocket instance.
 */
async function openConnection(
  manager: ReturnType<typeof createConnectionManager>
): Promise<MockWebSocket> {
  const openPromise = manager.open();
  // openIngestWs creates a WS and waits for onopen
  const ws = MockWebSocket.latest!;
  ws.simulateOpen();
  // Event subscription starts in the background (fire-and-forget)
  await openPromise;
  return ws;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ingest WS reconnection', () => {
  let state: WrapperState;
  let callbacks: ReturnType<typeof createCallbacks>;

  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.reset();
    vi.stubGlobal('WebSocket', MockWebSocket);
    stubFetch();

    state = new WrapperState();
    state.startJob(createJobContext());
    callbacks = createCallbacks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function createManager() {
    return createConnectionManager(state, { kiloClient: createMockKiloClient() }, callbacks);
  }

  // -------------------------------------------------------------------------
  // Test: unexpected close triggers reconnection
  // -------------------------------------------------------------------------

  it('attempts reconnection on unexpected WS close', async () => {
    const manager = createManager();
    const ws = await openConnection(manager);

    // Unexpected close (code 1006 = abnormal closure)
    ws.simulateClose(1006);

    expect(callbacks.onDisconnect).not.toHaveBeenCalled();
    expect(manager.isReconnecting()).toBe(true);
    expect(callbacks.onReconnecting).toHaveBeenCalledWith(1);

    // Advance past first backoff (1s)
    await vi.advanceTimersByTimeAsync(1_000);

    // A new WS should have been created
    const newWs = MockWebSocket.latest!;
    expect(newWs).not.toBe(ws);
    newWs.simulateOpen();

    // Wait for reconnect promise to resolve
    await vi.advanceTimersByTimeAsync(0);

    expect(callbacks.onReconnected).toHaveBeenCalled();
    expect(manager.isReconnecting()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test: reconnection fails after all attempts
  // -------------------------------------------------------------------------

  it('calls onDisconnect after all reconnection attempts fail', async () => {
    const manager = createManager();
    const ws = await openConnection(manager);

    ws.simulateClose(1006);
    expect(manager.isReconnecting()).toBe(true);

    // Backoff delays: 1s, 2s, 4s (3 attempts)
    const delays = [1_000, 2_000, 4_000];

    for (let i = 0; i < delays.length; i++) {
      expect(callbacks.onReconnecting).toHaveBeenCalledWith(i + 1);
      await vi.advanceTimersByTimeAsync(delays[i]);

      // New WS created — simulate error so openIngestWs rejects
      const attemptWs = MockWebSocket.latest!;
      attemptWs.simulateError();

      // Let the rejection propagate and next attempt to schedule
      await vi.advanceTimersByTimeAsync(0);
    }

    // After 3 failures, onDisconnect should fire
    expect(callbacks.onDisconnect).toHaveBeenCalledWith(
      'ingest websocket closed (reconnection failed)'
    );
    expect(manager.isReconnecting()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test: expected close (closedByUs) — no reconnection
  // -------------------------------------------------------------------------

  it('does not reconnect when connection is closed by us', async () => {
    const manager = createManager();
    const ws = await openConnection(manager);

    // close() sets closedByUs = true, then calls ws.close()
    await manager.close();

    // The WS is already closed by close(), but simulate the onclose event
    // that arrives after (close() sets ingestWs=null, so onclose with stale ws is ignored)
    ws.simulateClose(1000, 'normal close');

    expect(callbacks.onDisconnect).not.toHaveBeenCalled();
    expect(manager.isReconnecting()).toBe(false);

    // Advance timers to verify no reconnection attempts
    await vi.advanceTimersByTimeAsync(60_000);
    // Only the initial WS should exist (no new connections attempted)
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Test: events are buffered during reconnection and flushed on reconnect
  // -------------------------------------------------------------------------

  it('buffers events during reconnection and flushes on reconnect', async () => {
    const manager = createManager();
    const ws = await openConnection(manager);

    // Simulate unexpected close
    ws.simulateClose(1006);
    expect(manager.isReconnecting()).toBe(true);

    // Send events via state.sendToIngest while disconnected
    const event1: IngestEvent = {
      streamEventType: 'kilocode',
      timestamp: new Date().toISOString(),
      data: { event: 'test_event_1' },
    };
    const event2: IngestEvent = {
      streamEventType: 'output',
      timestamp: new Date().toISOString(),
      data: { text: 'some output' },
    };
    state.sendToIngest(event1);
    state.sendToIngest(event2);

    // Events should NOT have been sent to the old WS
    // (old WS is closed, so nothing is sent — events are buffered internally)
    const oldWsSentAfterClose = ws.sent.filter(msg => {
      const parsed = JSON.parse(msg);
      return parsed.streamEventType === 'kilocode' || parsed.streamEventType === 'output';
    });
    // The old WS may have sent a heartbeat before close; filter to our test events
    expect(oldWsSentAfterClose).toHaveLength(0);

    // Advance past first backoff (1s) and reconnect
    await vi.advanceTimersByTimeAsync(1_000);
    const newWs = MockWebSocket.latest!;
    expect(newWs).not.toBe(ws);
    newWs.simulateOpen();
    await vi.advanceTimersByTimeAsync(0);

    // Verify wrapper_resumed marker was sent
    const resumeMsg = newWs.sent.find(msg => {
      const parsed = JSON.parse(msg);
      return parsed.streamEventType === 'wrapper_resumed';
    });
    expect(resumeMsg).toBeDefined();
    const parsedResume = JSON.parse(resumeMsg!);
    expect(parsedResume.data.bufferedEvents).toBe(2);
    expect(parsedResume.data.eventsLost).toBe(false);

    // Verify buffered events were flushed to new WS
    const flushedEvents = newWs.sent
      .map(msg => JSON.parse(msg))
      .filter(
        (e: { streamEventType: string }) =>
          e.streamEventType === 'kilocode' || e.streamEventType === 'output'
      );
    expect(flushedEvents).toHaveLength(2);
    expect(flushedEvents[0].data.event).toBe('test_event_1');
    expect(flushedEvents[1].data.text).toBe('some output');
  });

  // -------------------------------------------------------------------------
  // Test: SSE consumer stays alive during reconnection
  // -------------------------------------------------------------------------

  it('keeps event subscription alive during WS reconnection', async () => {
    const manager = createManager();
    const ws = await openConnection(manager);

    // Simulate unexpected WS close
    ws.simulateClose(1006);
    expect(manager.isReconnecting()).toBe(true);

    // The event subscription should NOT have triggered onDisconnect
    // (only WS disconnected, not the event stream).
    expect(callbacks.onDisconnect).not.toHaveBeenCalled();

    // Reconnect
    await vi.advanceTimersByTimeAsync(1_000);
    MockWebSocket.latest!.simulateOpen();
    await vi.advanceTimersByTimeAsync(0);

    // After reconnection, the connection should be working again
    expect(manager.isReconnecting()).toBe(false);
    expect(manager.isConnected()).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test: close() during reconnection cancels it
  // -------------------------------------------------------------------------

  it('cancels reconnection when close() is called during reconnect', async () => {
    const manager = createManager();
    const ws = await openConnection(manager);

    ws.simulateClose(1006);
    expect(manager.isReconnecting()).toBe(true);

    const instanceCountBefore = MockWebSocket.instances.length;

    // Call close() while reconnecting
    await manager.close();
    expect(manager.isReconnecting()).toBe(false);

    // Advance past all possible backoff delays (1+2+4+8+16 = 31s)
    await vi.advanceTimersByTimeAsync(60_000);

    // No new WebSocket connections should have been attempted
    expect(MockWebSocket.instances).toHaveLength(instanceCountBefore);
  });

  // -------------------------------------------------------------------------
  // Test: no custom heartbeat interval (heartbeats are forwarded from kilo)
  // -------------------------------------------------------------------------

  it('does not send custom heartbeat — heartbeats come from kilo server.heartbeat forwarding', async () => {
    const manager = createManager();
    const ws = await openConnection(manager);

    // Advance well past the old 20s heartbeat interval
    await vi.advanceTimersByTimeAsync(60_000);

    // No heartbeats should be sent by the wrapper — they are forwarded
    // from kilo's server.heartbeat event, not generated on a timer.
    const heartbeats = ws.sent.filter(msg => {
      const parsed = JSON.parse(msg);
      return parsed.streamEventType === 'heartbeat';
    });
    expect(heartbeats.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Test: exponential backoff delays
  // -------------------------------------------------------------------------

  it('uses exponential backoff delays for reconnection attempts', async () => {
    const manager = createManager();
    const ws = await openConnection(manager);

    ws.simulateClose(1006);

    // Track when each new WS instance is created by checking instance count
    // Backoff: attempt 1 = 1s, attempt 2 = 2s, attempt 3 = 4s
    const delays = [1_000, 2_000, 4_000];

    for (let i = 0; i < delays.length; i++) {
      const countBefore = MockWebSocket.instances.length;

      // Advance just under the delay — no new WS yet
      await vi.advanceTimersByTimeAsync(delays[i] - 1);
      expect(MockWebSocket.instances).toHaveLength(countBefore);

      // Advance the remaining 1ms — new WS should appear
      await vi.advanceTimersByTimeAsync(1);
      expect(MockWebSocket.instances).toHaveLength(countBefore + 1);

      // Simulate failure to trigger next attempt
      MockWebSocket.latest!.simulateError();
      await vi.advanceTimersByTimeAsync(0);
    }
  });

  // -------------------------------------------------------------------------
  // Test: onReconnecting fires with correct attempt number
  // -------------------------------------------------------------------------

  it('fires onReconnecting with incrementing attempt number', async () => {
    const manager = createManager();
    const ws = await openConnection(manager);

    ws.simulateClose(1006);

    // First attempt fires immediately on close
    expect(callbacks.onReconnecting).toHaveBeenCalledWith(1);

    // Fail attempt 1
    await vi.advanceTimersByTimeAsync(1_000);
    MockWebSocket.latest!.simulateError();
    await vi.advanceTimersByTimeAsync(0);

    expect(callbacks.onReconnecting).toHaveBeenCalledWith(2);

    // Fail attempt 2
    await vi.advanceTimersByTimeAsync(2_000);
    MockWebSocket.latest!.simulateError();
    await vi.advanceTimersByTimeAsync(0);

    expect(callbacks.onReconnecting).toHaveBeenCalledWith(3);
    expect(callbacks.onReconnecting).toHaveBeenCalledTimes(3);
  });

  // -------------------------------------------------------------------------
  // Test: WS messages received after reconnect are dispatched as commands
  // -------------------------------------------------------------------------

  it('dispatches commands received on the reconnected WS', async () => {
    const manager = createManager();
    const ws = await openConnection(manager);

    ws.simulateClose(1006);

    await vi.advanceTimersByTimeAsync(1_000);
    const newWs = MockWebSocket.latest!;
    newWs.simulateOpen();
    await vi.advanceTimersByTimeAsync(0);

    // Simulate a command message on the new WS
    const cmd = { type: 'ping' };
    newWs.onmessage?.(new MessageEvent('message', { data: JSON.stringify(cmd) }));

    expect(callbacks.onCommand).toHaveBeenCalledWith(cmd);
  });

  // -------------------------------------------------------------------------
  // Test: stale onclose from old WS is ignored during reconnection
  // -------------------------------------------------------------------------

  it('ignores onclose from a stale WebSocket instance', async () => {
    const manager = createManager();
    const ws = await openConnection(manager);

    // Trigger reconnection
    ws.simulateClose(1006);
    expect(manager.isReconnecting()).toBe(true);

    // Reconnect successfully
    await vi.advanceTimersByTimeAsync(1_000);
    const newWs = MockWebSocket.latest!;
    newWs.simulateOpen();
    await vi.advanceTimersByTimeAsync(0);

    expect(manager.isReconnecting()).toBe(false);
    callbacks.onDisconnect.mockClear();
    callbacks.onReconnecting.mockClear();

    // Now fire another close on the OLD ws — should be ignored
    // (the code checks `if (ingestWs !== ws) return;`)
    ws.simulateClose(1006);

    expect(callbacks.onDisconnect).not.toHaveBeenCalled();
    expect(manager.isReconnecting()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test: successful reconnect on later attempt (not the first)
  // -------------------------------------------------------------------------

  it('reconnects successfully on a later attempt after initial failures', async () => {
    const manager = createManager();
    const ws = await openConnection(manager);

    ws.simulateClose(1006);

    // Fail attempt 1
    await vi.advanceTimersByTimeAsync(1_000);
    MockWebSocket.latest!.simulateError();
    await vi.advanceTimersByTimeAsync(0);

    // Fail attempt 2
    await vi.advanceTimersByTimeAsync(2_000);
    MockWebSocket.latest!.simulateError();
    await vi.advanceTimersByTimeAsync(0);

    // Succeed attempt 3
    await vi.advanceTimersByTimeAsync(4_000);
    const newWs = MockWebSocket.latest!;
    newWs.simulateOpen();
    await vi.advanceTimersByTimeAsync(0);

    expect(callbacks.onReconnected).toHaveBeenCalledTimes(1);
    expect(callbacks.onDisconnect).not.toHaveBeenCalled();
    expect(manager.isReconnecting()).toBe(false);
    expect(callbacks.onReconnecting).toHaveBeenCalledTimes(3);
  });

  // -------------------------------------------------------------------------
  // Test: isConnected reflects disconnected state during reconnection
  // -------------------------------------------------------------------------

  it('returns false from isConnected during reconnection', async () => {
    const manager = createManager();
    await openConnection(manager);

    // Initially connected
    expect(manager.isConnected()).toBe(true);

    // Simulate unexpected close
    MockWebSocket.latest!.simulateClose(1006);

    // During reconnection, not connected
    expect(manager.isConnected()).toBe(false);
    expect(manager.isReconnecting()).toBe(true);

    // Reconnect
    await vi.advanceTimersByTimeAsync(1_000);
    MockWebSocket.latest!.simulateOpen();
    await vi.advanceTimersByTimeAsync(0);

    // isConnected remains false because SSE consumer is still set from initial open,
    // but we need the WS to be open. After reconnect the WS is open, so it depends
    // on whether sseConsumer is non-null. Since we didn't close the SSE consumer,
    // isConnected should be true.
    expect(manager.isConnected()).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test: no buffer overflow marker when buffer hasn't overflowed
  // -------------------------------------------------------------------------

  it('sends wrapper_resumed with eventsLost=false when buffer does not overflow', async () => {
    const manager = createManager();
    const ws = await openConnection(manager);

    ws.simulateClose(1006);

    // Buffer a single event
    state.sendToIngest({
      streamEventType: 'output',
      timestamp: new Date().toISOString(),
      data: { text: 'test' },
    });

    // Reconnect
    await vi.advanceTimersByTimeAsync(1_000);
    const newWs = MockWebSocket.latest!;
    newWs.simulateOpen();
    await vi.advanceTimersByTimeAsync(0);

    const resumeMsg = newWs.sent.find(msg => JSON.parse(msg).streamEventType === 'wrapper_resumed');
    expect(resumeMsg).toBeDefined();
    expect(JSON.parse(resumeMsg!).data.eventsLost).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test: no wrapper_resumed when no events were buffered
  // -------------------------------------------------------------------------

  it('does not send wrapper_resumed when no events were buffered', async () => {
    const manager = createManager();
    const ws = await openConnection(manager);

    ws.simulateClose(1006);

    // Don't send any events during disconnection

    // Reconnect
    await vi.advanceTimersByTimeAsync(1_000);
    const newWs = MockWebSocket.latest!;
    newWs.simulateOpen();
    await vi.advanceTimersByTimeAsync(0);

    const resumeMsg = newWs.sent.find(msg => JSON.parse(msg).streamEventType === 'wrapper_resumed');
    expect(resumeMsg).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Test: close() during in-flight reconnect discards stale socket
  // -------------------------------------------------------------------------

  it('discards stale socket when close() is called during in-flight reconnect', async () => {
    const manager = createManager();
    const ws = await openConnection(manager);

    // Trigger reconnection
    ws.simulateClose(1006);
    expect(manager.isReconnecting()).toBe(true);

    // Advance past the backoff timer — openIngestWs() is called, new WS created
    await vi.advanceTimersByTimeAsync(1_000);
    const reconnectWs = MockWebSocket.latest!;
    expect(reconnectWs).not.toBe(ws);

    // close() is called before the reconnect WS opens — generation increments
    await manager.close();
    expect(manager.isReconnecting()).toBe(false);

    // Now the WS opens (stale) — the generation check should discard it
    reconnectWs.simulateOpen();
    await vi.advanceTimersByTimeAsync(0);

    expect(callbacks.onReconnected).not.toHaveBeenCalled();

    // Verify no heartbeats are running on the stale socket
    reconnectWs.sent.length = 0;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(reconnectWs.sent).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Test: closedByUs flag does not leak into next execution
  // -------------------------------------------------------------------------

  it('does not leak closedByUs flag into the next execution', async () => {
    const manager = createManager();
    const ws = await openConnection(manager);

    // close() sets closedByUs=true, closes WS, then resets closedByUs=false
    await manager.close();

    // Old WS fires onclose (stale socket — ignored by guard)
    ws.simulateClose(1000, 'normal close');

    // Simulate starting a new execution with a fresh manager on the same state
    // (In production, state.startJob() is called for the new job. Here we
    // just create a new manager to ensure closedByUs doesn't carry over.)
    const callbacks2 = createCallbacks();
    const manager2 = createConnectionManager(
      state,
      { kiloClient: createMockKiloClient() },
      callbacks2
    );
    const ws2 = await openConnection(manager2);

    // Simulate unexpected close on the new connection
    ws2.simulateClose(1006);

    // Should trigger reconnection, NOT be swallowed by closedByUs
    expect(manager2.isReconnecting()).toBe(true);
    expect(callbacks2.onDisconnect).not.toHaveBeenCalled();
    expect(callbacks2.onReconnecting).toHaveBeenCalledWith(1);
  });
});
