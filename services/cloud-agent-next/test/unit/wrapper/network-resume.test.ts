/**
 * Unit tests for automatic Kilo network resume handling in createConnectionManager.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../wrapper/src/utils.js', async () => {
  const actual = await vi.importActual<typeof import('../../../wrapper/src/utils.js')>(
    '../../../wrapper/src/utils.js'
  );
  return {
    ...actual,
    logToFile: vi.fn(),
  };
});

import {
  createConnectionManager,
  type ConnectionCallbacks,
} from '../../../wrapper/src/connection.js';
import { WrapperState, type SessionContext } from '../../../wrapper/src/state.js';
import type { WrapperKiloClient } from '../../../wrapper/src/kilo-api.js';
import { logToFile } from '../../../wrapper/src/utils.js';

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

  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  static reset(): void {
    MockWebSocket.instances = [];
  }

  static get latest(): MockWebSocket | undefined {
    return MockWebSocket.instances[MockWebSocket.instances.length - 1];
  }
}

const createSessionContext = (): SessionContext => ({
  kiloSessionId: 'kilo_sess_456',
  ingestUrl: 'wss://ingest.example.com/ingest',
  ingestToken: 'token_secret',
  workerAuthToken: 'kilo_token_789',
});

const createCallbacks = (): ConnectionCallbacks & {
  onDisconnect: ReturnType<typeof vi.fn>;
  onTerminalError: ReturnType<typeof vi.fn>;
} => ({
  onMessageComplete: vi.fn(),
  onTerminalError: vi.fn(),
  onCommand: vi.fn(),
  onDisconnect: vi.fn(),
  onCompletionSignal: vi.fn(),
  onSseEvent: vi.fn(),
  onReconnecting: vi.fn(),
  onReconnected: vi.fn(),
});

type KiloEvent = { type: string; properties?: Record<string, unknown> };

function createEventStream(events: KiloEvent[]): AsyncIterable<KiloEvent> {
  return (async function* () {
    for (const event of events) {
      yield event;
    }
    await new Promise(() => {});
  })();
}

function createDeferredFirstEventStream(): {
  stream: AsyncIterable<KiloEvent>;
  emitFirstEvent: (event: KiloEvent) => void;
} {
  let emitFirstEvent: (event: KiloEvent) => void = () => {};
  const firstEvent = new Promise<KiloEvent>(resolve => {
    emitFirstEvent = resolve;
  });

  return {
    stream: (async function* () {
      yield await firstEvent;
      await new Promise(() => {});
    })(),
    emitFirstEvent,
  };
}

function createMockKiloClient(overrides?: Partial<WrapperKiloClient>): WrapperKiloClient {
  return {
    createSession: vi.fn().mockResolvedValue({ id: 'kilo_sess' }),
    getSession: vi.fn().mockResolvedValue({ id: 'kilo_sess' }),
    sendPromptAsync: vi.fn().mockResolvedValue(undefined),
    abortSession: vi.fn().mockResolvedValue(true),
    sendCommand: vi.fn().mockResolvedValue(undefined),
    answerPermission: vi.fn().mockResolvedValue(true),
    answerQuestion: vi.fn().mockResolvedValue(true),
    rejectQuestion: vi.fn().mockResolvedValue(true),
    getSessionStatuses: vi.fn().mockResolvedValue({}),
    getQuestions: vi.fn().mockResolvedValue([]),
    getPermissions: vi.fn().mockResolvedValue([]),
    getNetworkWaits: vi.fn().mockResolvedValue([]),
    resumeNetworkWait: vi.fn().mockResolvedValue(true),
    generateCommitMessage: vi.fn().mockResolvedValue({ message: 'test commit' }),
    subscribeEvents: vi.fn().mockResolvedValue({
      stream: createEventStream([]),
    }),
    serverUrl: 'http://127.0.0.1:0',
    ...overrides,
  };
}

async function openConnection(
  manager: ReturnType<typeof createConnectionManager>
): Promise<MockWebSocket> {
  const openPromise = manager.open();
  const ws = MockWebSocket.latest!;
  ws.simulateOpen();
  await openPromise;
  return ws;
}

type ParsedEvent = { streamEventType: string; data: Record<string, unknown>; timestamp: string };

function parseSentMessages(ws: MockWebSocket): ParsedEvent[] {
  return ws.sent.map(msg => JSON.parse(msg) as ParsedEvent);
}

describe('network resume', () => {
  let state: WrapperState;
  let callbacks: ReturnType<typeof createCallbacks>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    MockWebSocket.reset();
    vi.stubGlobal('WebSocket', MockWebSocket);

    state = new WrapperState();
    state.bindSession(createSessionContext());
    callbacks = createCallbacks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('resumes a restored network wait for the current root session', async () => {
    const resumeNetworkWait = vi.fn().mockResolvedValue(true);
    const kiloClient = createMockKiloClient({
      resumeNetworkWait,
      subscribeEvents: vi.fn().mockResolvedValue({
        stream: createEventStream([
          {
            type: 'session.network.restored',
            properties: { sessionID: 'kilo_sess_456', requestID: 'net_req_123' },
          },
        ]),
      }),
    });

    const manager = createConnectionManager(state, { kiloClient }, callbacks);
    const ws = await openConnection(manager);
    await vi.advanceTimersByTimeAsync(0);

    expect(resumeNetworkWait).toHaveBeenCalledWith('net_req_123');
    expect(callbacks.onTerminalError).not.toHaveBeenCalled();

    const networkEvents = parseSentMessages(ws).filter(
      event =>
        event.streamEventType === 'kilocode' && event.data.event === 'session.network.restored'
    );
    expect(networkEvents).toHaveLength(1);
  });

  it('ignores a restored network wait for another session', async () => {
    const resumeNetworkWait = vi.fn().mockResolvedValue(true);
    const kiloClient = createMockKiloClient({
      resumeNetworkWait,
      subscribeEvents: vi.fn().mockResolvedValue({
        stream: createEventStream([
          {
            type: 'session.network.restored',
            properties: { sessionID: 'child_sess_789', requestID: 'net_req_123' },
          },
        ]),
      }),
    });

    const manager = createConnectionManager(state, { kiloClient }, callbacks);
    await openConnection(manager);
    await vi.advanceTimersByTimeAsync(0);

    expect(resumeNetworkWait).not.toHaveBeenCalled();
    expect(callbacks.onTerminalError).not.toHaveBeenCalled();
  });

  it('logs resume failures without reporting a terminal error', async () => {
    const resumeNetworkWait = vi.fn().mockRejectedValue(new Error('network wait disappeared'));
    const kiloClient = createMockKiloClient({
      resumeNetworkWait,
      subscribeEvents: vi.fn().mockResolvedValue({
        stream: createEventStream([
          {
            type: 'session.network.restored',
            properties: { sessionID: 'kilo_sess_456', requestID: 'net_req_123' },
          },
        ]),
      }),
    });

    const manager = createConnectionManager(state, { kiloClient }, callbacks);
    await openConnection(manager);
    await vi.advanceTimersByTimeAsync(0);

    expect(resumeNetworkWait).toHaveBeenCalledWith('net_req_123');
    expect(callbacks.onTerminalError).not.toHaveBeenCalled();
    expect(logToFile).toHaveBeenCalledWith(
      'failed to resume network wait net_req_123: network wait disappeared'
    );
  });

  it('resumes restored network waits after the event subscription handshake', async () => {
    const resumeNetworkWait = vi.fn().mockResolvedValue(true);
    const eventStream = createDeferredFirstEventStream();
    const subscribe = vi.fn().mockResolvedValue({
      stream: eventStream.stream,
    });
    const kiloClient = createMockKiloClient({
      resumeNetworkWait,
      getNetworkWaits: vi.fn().mockResolvedValue([
        {
          id: 'net_req_restored',
          sessionID: 'kilo_sess_456',
          message: 'Network restored',
          restored: true,
        },
        {
          id: 'net_req_child',
          sessionID: 'child_sess_789',
          message: 'Network restored',
          restored: true,
        },
      ]),
      subscribeEvents: subscribe,
    });

    const manager = createConnectionManager(state, { kiloClient }, callbacks);
    await openConnection(manager);
    await vi.advanceTimersByTimeAsync(0);

    expect(manager.isConnected()).toBe(true);
    expect(resumeNetworkWait).toHaveBeenCalledTimes(1);
    expect(resumeNetworkWait).toHaveBeenCalledWith('net_req_restored');

    eventStream.emitFirstEvent({ type: 'server.connected' });
    await vi.advanceTimersByTimeAsync(0);

    expect(manager.isConnected()).toBe(true);
    expect(resumeNetworkWait).toHaveBeenCalledTimes(1);
    expect(resumeNetworkWait).toHaveBeenCalledWith('net_req_restored');
    expect(subscribe.mock.invocationCallOrder[0]).toBeLessThan(
      resumeNetworkWait.mock.invocationCallOrder[0]
    );
    expect(callbacks.onTerminalError).not.toHaveBeenCalled();
  });

  it('resumes restored network waits after an event-subscription-only reconnect', async () => {
    const resumeNetworkWait = vi.fn().mockResolvedValue(true);
    const subscribe = vi.fn().mockImplementation(() =>
      Promise.resolve({
        stream: createEventStream([{ type: 'server.connected' }]),
      })
    );
    const getNetworkWaits = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'net_req_restored_after_sse_reconnect',
          sessionID: 'kilo_sess_456',
          message: 'Network restored',
          restored: true,
        },
      ]);
    const kiloClient = createMockKiloClient({
      resumeNetworkWait,
      getNetworkWaits,
      subscribeEvents: subscribe,
    });

    const manager = createConnectionManager(state, { kiloClient }, callbacks);
    await openConnection(manager);
    await vi.advanceTimersByTimeAsync(0);
    resumeNetworkWait.mockClear();

    manager.reconnectEventSubscription();
    await vi.advanceTimersByTimeAsync(0);

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(resumeNetworkWait).toHaveBeenCalledTimes(1);
    expect(resumeNetworkWait).toHaveBeenCalledWith('net_req_restored_after_sse_reconnect');
    expect(callbacks.onTerminalError).not.toHaveBeenCalled();
  });

  it('forwards an unrestored network wait from the kilo snapshot', async () => {
    const pendingWait = {
      id: 'net_req_pending',
      sessionID: 'kilo_sess_456',
      message: 'Waiting for network',
      restored: false,
    };
    const kiloClient = createMockKiloClient({
      getNetworkWaits: vi.fn().mockResolvedValue([pendingWait]),
    });

    const manager = createConnectionManager(state, { kiloClient }, callbacks);
    const ws = await openConnection(manager);

    const networkEvents = parseSentMessages(ws).filter(
      event => event.streamEventType === 'kilocode' && event.data.event === 'session.network.asked'
    );

    expect(networkEvents).toHaveLength(1);
    expect(networkEvents[0].data).toMatchObject({
      event: 'session.network.asked',
      type: 'session.network.asked',
      properties: pendingWait,
    });
  });
});
