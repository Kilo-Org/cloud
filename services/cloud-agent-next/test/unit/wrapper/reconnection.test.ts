/**
 * Unit tests for ingest WebSocket reconnection logic in createConnectionManager.
 *
 * Tests exponential backoff, event buffering during disconnection,
 * heartbeat pause/resume, and close-during-reconnect scenarios.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  allocateWrapperRuntimeState,
  clearAllocatedWrapperRuntimeState,
  clearWrapperRuntimeIdentity,
  getWrapperRuntimeState,
  READY_ONLY_IDLE_MS,
  recordWrapperAcceptedMessage,
  recordWrapperPong,
  recordWrapperReadyLease,
} from '../../../src/session/wrapper-runtime-state.js';
import {
  CODE_REVIEW_PERMISSION_REJECTION_MESSAGE,
  createConnectionManager,
  openIngestProgressChannel,
  type ConnectionCallbacks,
} from '../../../wrapper/src/connection.js';
import { WrapperState, type SessionContext } from '../../../wrapper/src/state.js';
import type { KiloEvent, WrapperKiloClient } from '../../../wrapper/src/kilo-api.js';
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

const createSessionContext = (overrides: Partial<SessionContext> = {}): SessionContext => ({
  kiloSessionId: 'kilo_sess_456',
  ingestUrl: 'wss://ingest.example.com/ingest',
  ingestToken: 'token_secret',
  workerAuthToken: 'kilo_token_789',
  wrapperRunId: 'run_test',
  wrapperGeneration: 7,
  wrapperConnectionId: 'conn_test',
  ...overrides,
});

const createCodeReviewSessionContext = (): SessionContext =>
  createSessionContext({ platform: 'code-review' });

const createCallbacks = (): ConnectionCallbacks & {
  onReconnecting: ReturnType<typeof vi.fn>;
  onReconnected: ReturnType<typeof vi.fn>;
  onDisconnect: ReturnType<typeof vi.fn>;
  onTerminalError: ReturnType<typeof vi.fn>;
  onRootSessionActivity: ReturnType<typeof vi.fn>;
  onSseEvent: ReturnType<typeof vi.fn>;
} => ({
  onMessageComplete: vi.fn(),
  onTerminalError: vi.fn(),
  onCommand: vi.fn(),
  onDisconnect: vi.fn(),
  onCompletionSignal: vi.fn(),
  onRootSessionActivity: vi.fn(),
  onReconnecting: vi.fn(),
  onReconnected: vi.fn(),
  onSseEvent: vi.fn(),
});

const createMockKiloClient = (overrides: Partial<WrapperKiloClient> = {}): WrapperKiloClient => ({
  createSession: vi.fn().mockResolvedValue({ id: 'kilo_sess' }),
  getSession: vi.fn().mockResolvedValue({ id: 'kilo_sess' }),
  sendPromptAsync: vi.fn().mockResolvedValue(undefined),
  abortSession: vi.fn().mockResolvedValue(true),
  sendCommand: vi.fn().mockResolvedValue(undefined),
  answerPermission: vi.fn().mockResolvedValue(true),
  answerQuestion: vi.fn().mockResolvedValue(true),
  rejectQuestion: vi.fn().mockResolvedValue(true),
  generateCommitMessage: vi.fn().mockResolvedValue({ message: 'test commit' }),
  getSessionStatuses: vi.fn().mockResolvedValue({}),
  getQuestions: vi.fn().mockResolvedValue([]),
  getPermissions: vi.fn().mockResolvedValue([]),
  getNetworkWaits: vi.fn().mockResolvedValue([]),
  resumeNetworkWait: vi.fn().mockResolvedValue(true),
  // Return a stream that never yields — keeps event subscription alive
  subscribeEvents: vi.fn().mockResolvedValue({
    stream: (async function* () {
      await new Promise(() => {});
    })(),
  }),
  serverUrl: 'http://127.0.0.1:0',
  ...overrides,
});

function createEventStream(events: KiloEvent[]): AsyncIterable<KiloEvent> {
  return (async function* () {
    for (const event of events) {
      yield event;
    }
    await new Promise(() => {});
  })();
}

function parseSentMessages(
  ws: MockWebSocket
): Array<{ streamEventType?: string; data: Record<string, unknown> }> {
  return ws.sent.map(msg => {
    const parsed = JSON.parse(msg) as { streamEventType?: string; data?: Record<string, unknown> };
    return { streamEventType: parsed.streamEventType, data: parsed.data ?? {} };
  });
}

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

describe('wrapper runtime state', () => {
  const createStorage = () => {
    const storage = new Map<string, unknown>();
    return {
      get: async (key: string) => storage.get(key),
      put: async (key: string, value: unknown) => {
        storage.set(key, value);
      },
      delete: async (key: string) => storage.delete(key),
    } as unknown as DurableObjectStorage;
  };

  it('preserves active liveness state when reusing the same wrapper allocation', async () => {
    const durableStorage = createStorage();

    const { state: allocated } = await allocateWrapperRuntimeState(durableStorage, 1_000);
    await recordWrapperAcceptedMessage(durableStorage, allocated, 10_000, 61_000);
    if (!allocated.wrapperConnectionId) throw new Error('expected wrapper connection ID');
    await recordWrapperPong(
      durableStorage,
      allocated.wrapperGeneration,
      allocated.wrapperConnectionId,
      2_000,
      62_000
    );

    const { state: reused } = await allocateWrapperRuntimeState(durableStorage, 3_000);
    const stored = await getWrapperRuntimeState(durableStorage);

    expect(reused.wrapperGeneration).toBe(allocated.wrapperGeneration);
    expect(reused.wrapperConnectionId).toBe(allocated.wrapperConnectionId);
    expect(stored.noOutputDeadlineAt).toBe(10_000);
    expect(stored.pingDeadlineAt).toBeUndefined();
    expect(stored.nextPingAt).toBe(62_000);
  });

  it('does not let stale terminal cleanup clear a newer wrapper runtime state', async () => {
    const durableStorage = createStorage();

    const { state: stale } = await allocateWrapperRuntimeState(durableStorage, 1_000);
    if (!stale.wrapperConnectionId) throw new Error('expected stale wrapper connection ID');
    await clearAllocatedWrapperRuntimeState(durableStorage, stale);

    const { state: current } = await allocateWrapperRuntimeState(durableStorage, 2_000);
    if (!current.wrapperConnectionId) throw new Error('expected current wrapper connection ID');
    await recordWrapperAcceptedMessage(durableStorage, current, 10_000, 61_000);

    const cleared = await clearWrapperRuntimeIdentity(
      durableStorage,
      {
        wrapperGeneration: stale.wrapperGeneration,
        wrapperConnectionId: stale.wrapperConnectionId,
      },
      { incrementGeneration: true }
    );
    const stored = await getWrapperRuntimeState(durableStorage);

    expect(cleared).toBeNull();
    expect(stored).toMatchObject({
      wrapperGeneration: current.wrapperGeneration,
      wrapperConnectionId: current.wrapperConnectionId,
      wrapperRunId: current.wrapperRunId,
      lastWrapperConnectedAt: 2_000,
      noOutputDeadlineAt: 10_000,
      nextPingAt: 61_000,
    });
    expect(stored.wrapperIdleDeadlineAt).toBeUndefined();
  });

  it('allocates a fresh fenced identity instead of reusing an obsolete execution-era record', async () => {
    const durableStorage = createStorage();
    await durableStorage.put('wrapper_runtime_state', {
      wrapperGeneration: 7,
      wrapperConnectionId: 'conn_legacy',
      acceptedExecutionId: 'exc_legacy',
    });

    const allocated = await allocateWrapperRuntimeState(durableStorage, 4_000);
    const stored = await getWrapperRuntimeState(durableStorage);

    expect(allocated.allocatedNewIdentity).toBe(true);
    expect(allocated.state.wrapperGeneration).toBe(8);
    expect(allocated.state.wrapperConnectionId).not.toBe('conn_legacy');
    expect(allocated.state.wrapperRunId).toMatch(/^wr_/);
    expect(stored).toEqual(allocated.state);
  });

  it('allocates fresh current identity even when obsolete grace cleanup fails', async () => {
    const durableStorage = createStorage();
    await durableStorage.put('wrapper_runtime_state', {
      wrapperGeneration: 5,
      wrapperConnectionId: 'conn_legacy',
      acceptedExecutionId: 'exc_legacy',
    });
    durableStorage.delete = async () => {
      throw new Error('cleanup unavailable');
    };

    const allocated = await allocateWrapperRuntimeState(durableStorage, 4_000);

    expect(allocated.allocatedNewIdentity).toBe(true);
    expect(allocated.state.wrapperGeneration).toBe(6);
    expect(allocated.state.wrapperRunId).toMatch(/^wr_/);
  });

  it('reports allocatedNewIdentity=true for cold allocation and false for hot reuse', async () => {
    const durableStorage = createStorage();

    const cold = await allocateWrapperRuntimeState(durableStorage, 1_000);
    expect(cold.allocatedNewIdentity).toBe(true);

    const hot = await allocateWrapperRuntimeState(durableStorage, 2_000);
    expect(hot.allocatedNewIdentity).toBe(false);
    expect(hot.state.wrapperConnectionId).toBe(cold.state.wrapperConnectionId);

    await clearAllocatedWrapperRuntimeState(durableStorage, hot.state);

    const nextCold = await allocateWrapperRuntimeState(durableStorage, 3_000);
    expect(nextCold.allocatedNewIdentity).toBe(true);
  });

  it('records a short ready-only idle lease for prepared wrappers', async () => {
    const durableStorage = createStorage();
    const { state: allocated } = await allocateWrapperRuntimeState(durableStorage, 1_000);

    await recordWrapperReadyLease(durableStorage, allocated, 2_000);

    const stored = await getWrapperRuntimeState(durableStorage);
    expect(stored.wrapperIdleDeadlineAt).toBe(2_000 + READY_ONLY_IDLE_MS);
    expect(stored.wrapperConnectionId).toBe(allocated.wrapperConnectionId);
  });

  it('clears ready-only idle lease when a message is accepted', async () => {
    const durableStorage = createStorage();
    const { state: allocated } = await allocateWrapperRuntimeState(durableStorage, 1_000);

    await recordWrapperReadyLease(durableStorage, allocated, 2_000);
    await recordWrapperAcceptedMessage(durableStorage, allocated, 10_000, 61_000);

    const stored = await getWrapperRuntimeState(durableStorage);
    expect(stored.wrapperIdleDeadlineAt).toBeUndefined();
    expect(stored.noOutputDeadlineAt).toBe(10_000);
    expect(stored.nextPingAt).toBe(61_000);
  });
});

describe('session binding fence values', () => {
  it('uses refreshed fence values in the next ingest URL and pong source state', async () => {
    const state = new WrapperState();
    state.bindSession(
      createSessionContext({
        ingestUrl: 'wss://ingest.example.com/ingest-refreshed',
        ingestToken: 'token_secret_refreshed',
        workerAuthToken: 'kilo_token_refreshed',
        wrapperGeneration: 8,
        wrapperConnectionId: 'conn_refreshed',
      })
    );
    const callbacks = createCallbacks();
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', MockWebSocket);
    stubFetch();

    try {
      const manager = createConnectionManager(
        state,
        { kiloClient: createMockKiloClient() },
        callbacks
      );
      const ws = await openConnection(manager);

      expect(ws.url).toContain('wrapperGeneration=8');
      expect(ws.url).toContain('wrapperConnectionId=conn_refreshed');
      state.sendToIngest({
        streamEventType: 'pong',
        data: {
          wrapperRunId: state.currentSession?.wrapperRunId,
          wrapperGeneration: state.currentSession?.wrapperGeneration,
          wrapperConnectionId: state.currentSession?.wrapperConnectionId,
        },
        timestamp: new Date().toISOString(),
      });
      const pong = ws.sent
        .map(message => JSON.parse(message))
        .find(event => event.streamEventType === 'pong');
      expect(pong.data).toMatchObject({
        wrapperRunId: 'run_test',
        wrapperGeneration: 8,
        wrapperConnectionId: 'conn_refreshed',
      });
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

describe('bootstrap progress channel', () => {
  beforeEach(() => {
    MockWebSocket.reset();
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends preparing events before the full Kilo connection is available', async () => {
    const state = new WrapperState();
    state.bindSession(createSessionContext());

    const openPromise = openIngestProgressChannel(state);
    const ws = MockWebSocket.latest!;
    ws.simulateOpen();
    const channel = await openPromise;

    expect(state.isConnected).toBe(false);
    expect(ws.url).toContain('wrapperRunId=run_test');
    expect(ws.url).toContain('wrapperGeneration=7');
    expect(ws.url).toContain('wrapperConnectionId=conn_test');

    state.sendToIngest({
      streamEventType: 'preparing',
      data: { step: 'cloning', message: 'Cloning repository...' },
      timestamp: '2026-05-17T00:00:00.000Z',
    });

    expect(parseSentMessages(ws)).toEqual([
      {
        streamEventType: 'preparing',
        data: { step: 'cloning', message: 'Cloning repository...' },
      },
    ]);

    channel.close();
    state.sendToIngest({
      streamEventType: 'preparing',
      data: { step: 'branch', message: 'Setting up branch...' },
      timestamp: '2026-05-17T00:00:01.000Z',
    });

    expect(ws.sent).toHaveLength(1);
  });
});

describe('ingest WS reconnection', () => {
  let state: WrapperState;
  let callbacks: ReturnType<typeof createCallbacks>;

  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.reset();
    vi.stubGlobal('WebSocket', MockWebSocket);
    stubFetch();

    state = new WrapperState();
    state.bindSession(createSessionContext());
    callbacks = createCallbacks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('opens ingest WebSocket with wrapper fencing query params', async () => {
    const manager = createManager();

    const ws = await openConnection(manager);

    expect(ws.url).toContain('wrapperRunId=run_test');
    expect(ws.url).toContain('wrapperGeneration=7');
    expect(ws.url).toContain('wrapperConnectionId=conn_test');
  });

  it('openIngestWs does not fall back to executionId when wrapperRunId is absent', async () => {
    const stateNoWr = new WrapperState();
    stateNoWr.bindSession(
      createSessionContext({
        wrapperGeneration: undefined,
        wrapperConnectionId: undefined,
      })
    );
    const mgr = createConnectionManager(
      stateNoWr,
      { kiloClient: createMockKiloClient() },
      createCallbacks()
    );
    const ws = await openConnection(mgr);
    expect(ws.url).not.toContain('executionId=');
    expect(ws.url).toContain('kiloSessionId=kilo_sess_456');
    expect(ws.url).toContain('sessionId=');
  });

  function createManager() {
    return createConnectionManager(state, { kiloClient: createMockKiloClient() }, callbacks);
  }

  function createManagerWithClient(kiloClient: WrapperKiloClient) {
    return createConnectionManager(state, { kiloClient }, callbacks);
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
    // (old WS is closed, so nothing is sent — events are buffered internally).
    // Filter to just our test events: the open-time kilo snapshot legitimately
    // sends a session.status kilocode event through the old WS *before* close,
    // so ignore that.
    const oldWsSentAfterClose = ws.sent.filter(msg => {
      const parsed = JSON.parse(msg);
      if (parsed.streamEventType === 'output' && parsed.data?.text === 'some output') {
        return true;
      }
      if (parsed.streamEventType === 'kilocode' && parsed.data?.event === 'test_event_1') {
        return true;
      }
      return false;
    });
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

    // Verify buffered events were flushed to new WS. Filter to the specific
    // test events — the reconnect-time kilo snapshot will add its own
    // session.status kilocode event, which we ignore.
    const flushedEvents = newWs.sent
      .map(msg => JSON.parse(msg))
      .filter((e: { streamEventType: string; data?: { event?: string; text?: string } }) => {
        if (e.streamEventType === 'kilocode' && e.data?.event === 'test_event_1') return true;
        if (e.streamEventType === 'output' && e.data?.text === 'some output') return true;
        return false;
      });
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
    await vi.advanceTimersByTimeAsync(0);

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

    // Simulate starting a new session with a fresh manager on the same state
    // (In production, state.bindSession() is called for the new session. Here we
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

  it('surfaces model-not-found session errors as terminal wrapper errors', async () => {
    const kiloClient = createMockKiloClient({
      subscribeEvents: vi.fn().mockResolvedValue({
        stream: createEventStream([
          {
            type: 'session.error',
            properties: {
              sessionID: 'kilo_sess_456',
              error: {
                name: 'UnknownError',
                data: { message: 'Model not found: kilo/does-not-exist.' },
              },
            },
          },
        ]),
      }),
    });

    const manager = createManagerWithClient(kiloClient);
    const ws = await openConnection(manager);
    await vi.advanceTimersByTimeAsync(0);

    const sessionErrors = parseSentMessages(ws).filter(
      event => event.streamEventType === 'kilocode' && event.data.event === 'session.error'
    );
    expect(sessionErrors).toHaveLength(1);
    expect(callbacks.onTerminalError).toHaveBeenCalledWith('Model not found: kilo/does-not-exist.');
  });

  it('records explicit Kilo gate results from event properties', async () => {
    const kiloClient = createMockKiloClient({
      subscribeEvents: vi.fn().mockResolvedValue({
        stream: createEventStream([
          {
            type: 'session.updated',
            properties: {
              sessionID: 'kilo_sess_456',
              gateResult: 'fail',
            },
          },
        ]),
      }),
    });

    const manager = createManagerWithClient(kiloClient);
    await openConnection(manager);
    await vi.advanceTimersByTimeAsync(0);

    expect(state.observedGateResult).toBe('fail');
  });

  it('reports root activity before a terminal root message completion after idle', async () => {
    const callbackOrder: string[] = [];
    callbacks.onSessionIdle = vi.fn(() => {
      callbackOrder.push('idle');
    });
    callbacks.onRootSessionActivity.mockImplementation(() => {
      callbackOrder.push('activity');
    });
    callbacks.onMessageComplete = vi.fn((messageId: string) => {
      callbackOrder.push(`complete:${messageId}`);
    });

    const kiloClient = createMockKiloClient({
      subscribeEvents: vi.fn().mockResolvedValue({
        stream: createEventStream([
          {
            type: 'session.idle',
            properties: { sessionID: 'kilo_sess_456' },
          },
          {
            type: 'message.updated',
            properties: {
              info: {
                id: 'assistant_msg_root_123',
                parentID: 'msg_root_user_123',
                role: 'assistant',
                sessionID: 'kilo_sess_456',
                time: { completed: 1_716_200_000_000 },
              },
            },
          },
        ]),
      }),
    });

    const manager = createManagerWithClient(kiloClient);
    await openConnection(manager);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(callbacks.onSessionIdle).toHaveBeenCalledTimes(1);
    expect(callbacks.onRootSessionActivity).toHaveBeenCalledTimes(1);
    expect(callbacks.onMessageComplete).toHaveBeenCalledWith('msg_root_user_123');
    expect(callbackOrder).toEqual(['idle', 'activity', 'complete:msg_root_user_123']);
  });

  it('rejects real-time code-review questions without disconnecting', async () => {
    state = new WrapperState();
    state.bindSession(createCodeReviewSessionContext());
    const rejectQuestion = vi.fn().mockResolvedValue(true);
    const kiloClient = createMockKiloClient({
      rejectQuestion,
      subscribeEvents: vi.fn().mockResolvedValue({
        stream: createEventStream([
          { type: 'question.asked', properties: { id: 'q_123', sessionID: 'kilo_sess_456' } },
        ]),
      }),
    });

    const manager = createManagerWithClient(kiloClient);
    const ws = await openConnection(manager);
    await vi.advanceTimersByTimeAsync(0);

    const questionEvents = parseSentMessages(ws).filter(
      event => event.streamEventType === 'kilocode' && event.data.event === 'question.asked'
    );
    expect(questionEvents).toHaveLength(0);
    expect(rejectQuestion).toHaveBeenCalledWith('q_123');
    expect(callbacks.onDisconnect).not.toHaveBeenCalled();
    expect(callbacks.onMessageComplete).not.toHaveBeenCalled();
  });

  it('rejects real-time code-review permissions without disconnecting', async () => {
    state = new WrapperState();
    state.bindSession(createCodeReviewSessionContext());
    const answerPermission = vi.fn().mockResolvedValue(true);
    const kiloClient = createMockKiloClient({
      answerPermission,
      subscribeEvents: vi.fn().mockResolvedValue({
        stream: createEventStream([
          {
            type: 'permission.asked',
            properties: { id: 'p_456', sessionID: 'kilo_sess_456', permission: 'file_write' },
          },
        ]),
      }),
    });

    const manager = createManagerWithClient(kiloClient);
    const ws = await openConnection(manager);
    await vi.advanceTimersByTimeAsync(0);

    const permissionEvents = parseSentMessages(ws).filter(
      event => event.streamEventType === 'kilocode' && event.data.event === 'permission.asked'
    );
    expect(permissionEvents).toHaveLength(0);
    expect(answerPermission).toHaveBeenCalledWith(
      'p_456',
      'reject',
      CODE_REVIEW_PERMISSION_REJECTION_MESSAGE
    );
    expect(callbacks.onDisconnect).not.toHaveBeenCalled();
    expect(callbacks.onMessageComplete).not.toHaveBeenCalled();
  });

  it.each(['question', 'permission'])(
    'ignores real-time code-review %s session status without disconnecting',
    async statusType => {
      state = new WrapperState();
      state.bindSession(createCodeReviewSessionContext());
      const kiloClient = createMockKiloClient({
        subscribeEvents: vi.fn().mockResolvedValue({
          stream: createEventStream([
            {
              type: 'session.status',
              properties: { sessionID: 'kilo_sess_456', status: { type: statusType } },
            },
          ]),
        }),
      });

      const manager = createManagerWithClient(kiloClient);
      const ws = await openConnection(manager);
      await vi.advanceTimersByTimeAsync(0);

      const statusEvents = parseSentMessages(ws).filter(event => {
        const status = event.data.status;
        return (
          event.streamEventType === 'kilocode' &&
          event.data.event === 'session.status' &&
          typeof status === 'object' &&
          status !== null &&
          'type' in status &&
          status.type === statusType
        );
      });
      expect(statusEvents).toHaveLength(0);
      expect(callbacks.onDisconnect).not.toHaveBeenCalled();
      expect(callbacks.onMessageComplete).not.toHaveBeenCalled();
    }
  );

  it('forwards real-time interactive questions for non-code-review jobs', async () => {
    const kiloClient = createMockKiloClient({
      subscribeEvents: vi.fn().mockResolvedValue({
        stream: createEventStream([
          { type: 'question.asked', properties: { id: 'q_123', sessionID: 'kilo_sess_456' } },
        ]),
      }),
    });

    const manager = createManagerWithClient(kiloClient);
    const ws = await openConnection(manager);
    await vi.advanceTimersByTimeAsync(0);

    const questionEvents = parseSentMessages(ws).filter(
      event => event.streamEventType === 'kilocode' && event.data.event === 'question.asked'
    );
    expect(questionEvents).toHaveLength(1);
    expect(kiloClient.rejectQuestion).not.toHaveBeenCalled();
  });

  it('forwards payment-style events and reports terminal errors', async () => {
    const kiloClient = createMockKiloClient({
      subscribeEvents: vi.fn().mockResolvedValue({
        stream: createEventStream([
          {
            type: 'payment_required',
            properties: { error: 'Insufficient credits', sessionID: 'kilo_sess_456' },
          },
        ]),
      }),
    });

    const manager = createManagerWithClient(kiloClient);
    const ws = await openConnection(manager);
    await vi.advanceTimersByTimeAsync(0);

    const paymentEvents = parseSentMessages(ws).filter(
      event => event.streamEventType === 'kilocode' && event.data.event === 'payment_required'
    );
    expect(paymentEvents).toHaveLength(1);
    expect(paymentEvents[0].data).toMatchObject({
      event: 'payment_required',
      error: 'Insufficient credits',
    });
    expect(callbacks.onTerminalError).toHaveBeenCalledWith('Insufficient credits');
    expect(callbacks.onDisconnect).not.toHaveBeenCalled();
    expect(callbacks.onMessageComplete).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test: close() clears event buffer to prevent stale events leaking
  // -------------------------------------------------------------------------

  it('clears event buffer on close() so stale events do not leak into the next open', async () => {
    const manager = createManager();
    const ws = await openConnection(manager);

    // Simulate unexpected close — events will be buffered while disconnected
    ws.simulateClose(1006);
    expect(manager.isReconnecting()).toBe(true);

    // Buffer events while disconnected
    state.sendToIngest({
      streamEventType: 'output',
      timestamp: new Date().toISOString(),
      data: { text: 'stale event from previous run' },
    });

    // Intentional close (drain boundary) — should clear the buffer
    await manager.close();
    expect(manager.isReconnecting()).toBe(false);

    // Reopen on the same manager — simulates a new session starting
    const openPromise = manager.open();
    const newWs = MockWebSocket.latest!;
    expect(newWs).not.toBe(ws);
    newWs.simulateOpen();
    await openPromise;

    // The stale buffered event should NOT be sent through the new connection
    const staleEventSent = newWs.sent.some(msg => {
      const parsed = JSON.parse(msg);
      return (
        parsed.streamEventType === 'output' && parsed.data?.text === 'stale event from previous run'
      );
    });
    expect(staleEventSent).toBe(false);

    // wrapper_resumed should NOT be sent since the buffer was cleared on close
    const resumedMsg = newWs.sent.find(
      msg => JSON.parse(msg).streamEventType === 'wrapper_resumed'
    );
    expect(resumedMsg).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Test: event buffer survives same-run reconnect
  // -------------------------------------------------------------------------

  it('preserves event buffer across unexpected disconnect and reconnect within the same run', async () => {
    const manager = createManager();
    const ws = await openConnection(manager);

    // Simulate unexpected close
    ws.simulateClose(1006);

    // Buffer events while disconnected
    state.sendToIngest({
      streamEventType: 'output',
      timestamp: new Date().toISOString(),
      data: { text: 'event during reconnect' },
    });

    // Reconnect (not close!) — events should still be flushed
    await vi.advanceTimersByTimeAsync(1_000);
    const newWs = MockWebSocket.latest!;
    newWs.simulateOpen();
    await vi.advanceTimersByTimeAsync(0);

    // The buffered event should be sent through the reconnected WS
    const bufferedEvent = newWs.sent.some(msg => {
      const parsed = JSON.parse(msg);
      return parsed.streamEventType === 'output' && parsed.data?.text === 'event during reconnect';
    });
    expect(bufferedEvent).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Subscribe handshake ordering — regression guard for the queue-while-busy
// hang caused by open() returning before the SSE subscription was live.
// See .plans/cloud-agent-queue-while-busy-findings.md.
// ---------------------------------------------------------------------------

type DeferredSubscribe = {
  promise: Promise<{ stream?: AsyncIterable<unknown> }>;
  resolve: (stream: AsyncIterable<unknown>) => void;
  reject: (err: Error) => void;
};

function createDeferredSubscribe(): DeferredSubscribe {
  let resolveFn!: (stream: AsyncIterable<unknown>) => void;
  let rejectFn!: (err: Error) => void;
  const promise = new Promise<{ stream?: AsyncIterable<unknown> }>((resolve, reject) => {
    resolveFn = (stream: AsyncIterable<unknown>) => resolve({ stream });
    rejectFn = reject;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

function neverYieldingStream(): AsyncIterable<unknown> {
  return (async function* () {
    await new Promise(() => {});
  })();
}

describe('subscribe-handshake ordering', () => {
  let state: WrapperState;
  let callbacks: ReturnType<typeof createCallbacks>;

  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.reset();
    vi.stubGlobal('WebSocket', MockWebSocket);
    stubFetch();

    state = new WrapperState();
    state.bindSession(createSessionContext());
    callbacks = createCallbacks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('open() does not resolve until subscribeEvents has returned', async () => {
    const deferred = createDeferredSubscribe();
    const kiloClient: WrapperKiloClient = {
      ...createMockKiloClient(),
      subscribeEvents: vi.fn().mockReturnValue(deferred.promise),
    };
    const manager = createConnectionManager(state, { kiloClient }, callbacks);

    const openPromise = manager.open();
    // Let openIngestWs's WS creation happen and resolve onopen
    MockWebSocket.latest!.simulateOpen();
    // Flush microtasks so open() can reach the attachEventSubscription await
    await vi.advanceTimersByTimeAsync(0);

    // While subscribe is pending, open() must not be settled and the manager
    // must not advertise as connected.
    expect(manager.isConnected()).toBe(false);
    let settled = false;
    void openPromise.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toBe(false);

    // Resolve the subscribe handshake → open() resolves and isConnected flips.
    deferred.resolve(neverYieldingStream());
    await openPromise;
    expect(manager.isConnected()).toBe(true);
  });

  it('open() rejects when subscribeEvents rejects and leaves isConnected false', async () => {
    const deferred = createDeferredSubscribe();
    const kiloClient: WrapperKiloClient = {
      ...createMockKiloClient(),
      subscribeEvents: vi.fn().mockReturnValue(deferred.promise),
    };
    const manager = createConnectionManager(state, { kiloClient }, callbacks);

    const openPromise = manager.open();
    // Attach rejection handler synchronously so the rejection never becomes
    // unhandled while timers advance.
    const rejection = expect(openPromise).rejects.toThrow(/SSE handshake failed/);
    MockWebSocket.latest!.simulateOpen();
    await vi.advanceTimersByTimeAsync(0);

    deferred.reject(new Error('SSE handshake failed'));
    await rejection;

    expect(manager.isConnected()).toBe(false);
    expect(state.isConnected).toBe(false);
    expect(state.sseAbortController).toBeNull();
  });

  it('does not arm the SSE watchdog before the stream is live', async () => {
    const deferred = createDeferredSubscribe();
    const kiloClient: WrapperKiloClient = {
      ...createMockKiloClient(),
      subscribeEvents: vi.fn().mockReturnValue(deferred.promise),
    };
    const manager = createConnectionManager(state, { kiloClient }, callbacks);

    const openPromise = manager.open();
    MockWebSocket.latest!.simulateOpen();
    await vi.advanceTimersByTimeAsync(0);

    // Before the subscribe handshake resolves, onSseEvent must NOT have been
    // called — the watchdog should arm on the first real kilo event, not on
    // "we are about to subscribe".
    expect(callbacks.onSseEvent).not.toHaveBeenCalled();

    deferred.resolve(neverYieldingStream());
    await openPromise;

    // Still no onSseEvent — the stream hasn't yielded anything yet.
    expect(callbacks.onSseEvent).not.toHaveBeenCalled();
  });

  it('events emitted immediately after open() resolves reach the consumer', async () => {
    let emit: ((event: { type: string; properties?: Record<string, unknown> }) => void) | null =
      null;
    const liveStream: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]() {
        const queue: unknown[] = [];
        const waiters: Array<(v: IteratorResult<unknown>) => void> = [];
        emit = event => {
          if (waiters.length > 0) {
            waiters.shift()!({ value: event, done: false });
          } else {
            queue.push(event);
          }
        };
        return {
          next(): Promise<IteratorResult<unknown>> {
            if (queue.length > 0) {
              return Promise.resolve({ value: queue.shift(), done: false });
            }
            return new Promise(resolve => {
              waiters.push(resolve);
            });
          },
        };
      },
    };
    const kiloClient: WrapperKiloClient = {
      ...createMockKiloClient(),
      subscribeEvents: vi.fn().mockResolvedValue({ stream: liveStream }),
    };
    const manager = createConnectionManager(state, { kiloClient }, callbacks);

    const openPromise = manager.open();
    MockWebSocket.latest!.simulateOpen();
    await openPromise;

    expect(emit).not.toBeNull();
    // Simulate kilo emitting session.idle immediately after the handshake —
    // the consumer should pick it up and fire onCompletionSignal.
    emit!({
      type: 'session.idle',
      properties: { sessionID: state.currentSession!.kiloSessionId },
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(callbacks.onCompletionSignal).toHaveBeenCalled();
  });

  it('open() rejects and cleans up if subscribeEvents returns no stream', async () => {
    const kiloClient: WrapperKiloClient = {
      ...createMockKiloClient(),
      subscribeEvents: vi.fn().mockResolvedValue({ stream: undefined }),
    };
    const manager = createConnectionManager(state, { kiloClient }, callbacks);

    const openPromise = manager.open();
    // Attach rejection handler synchronously so the rejection never becomes
    // unhandled, then drive the WS open and timers.
    const rejection = expect(openPromise).rejects.toThrow(/No event stream from SDK/);
    MockWebSocket.latest!.simulateOpen();
    await vi.advanceTimersByTimeAsync(0);
    await rejection;

    expect(manager.isConnected()).toBe(false);
    expect(state.isConnected).toBe(false);
    expect(callbacks.onDisconnect).toHaveBeenCalledWith('No event stream from SDK');
  });

  it('open() rejects with a handshake timeout error if subscribeEvents hangs', async () => {
    // subscribeEvents never resolves on its own — only the abort signal can
    // end it, mirroring a kilo server that accepts the SSE connection but
    // never writes a response.
    const kiloClient: WrapperKiloClient = {
      ...createMockKiloClient(),
      subscribeEvents: vi.fn().mockImplementation(
        ({ signal }: { signal?: AbortSignal }) =>
          new Promise((_, reject) => {
            signal?.addEventListener('abort', () => {
              reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
            });
          })
      ),
    };
    const manager = createConnectionManager(state, { kiloClient }, callbacks);

    const openPromise = manager.open();
    const rejection = expect(openPromise).rejects.toThrow(/handshake timed out after 5000ms/);
    MockWebSocket.latest!.simulateOpen();

    // Advance just under the handshake timeout — open() is still pending.
    await vi.advanceTimersByTimeAsync(4_999);
    let settled = false;
    void openPromise.catch(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    // Cross the threshold — open() rejects with the handshake timeout error.
    await vi.advanceTimersByTimeAsync(1);
    await rejection;

    expect(manager.isConnected()).toBe(false);
    expect(state.isConnected).toBe(false);
    expect(state.sseAbortController).toBeNull();
  });
});
