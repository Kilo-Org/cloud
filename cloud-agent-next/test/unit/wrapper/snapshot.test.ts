/**
 * Unit tests for sendKiloSnapshot behavior in createConnectionManager.
 *
 * Verifies that sendKiloSnapshot sends regular kilocode events (session.status,
 * question.asked, permission.asked) instead of a kilo_snapshot event.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  createConnectionManager,
  type ConnectionCallbacks,
} from '../../../wrapper/src/connection.js';
import { WrapperState, type JobContext } from '../../../wrapper/src/state.js';
import type { WrapperKiloClient } from '../../../wrapper/src/kilo-api.js';

// ---------------------------------------------------------------------------
// Polyfills for Node.js test environment
// ---------------------------------------------------------------------------

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
  kiloSessionId: 'kilo_sess_456',
  ingestUrl: 'wss://ingest.example.com/ingest',
  ingestToken: 'token_secret',
  workerAuthToken: 'kilo_token_789',
});

const createCallbacks = (): ConnectionCallbacks => ({
  onMessageComplete: vi.fn(),
  onTerminalError: vi.fn(),
  onCommand: vi.fn(),
  onDisconnect: vi.fn(),
  onCompletionSignal: vi.fn(),
  onReconnecting: vi.fn(),
  onReconnected: vi.fn(),
});

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
    generateCommitMessage: vi.fn().mockResolvedValue({ message: 'test commit' }),
    getSessionStatuses: vi.fn().mockResolvedValue({}),
    getQuestions: vi.fn().mockResolvedValue([]),
    getPermissions: vi.fn().mockResolvedValue([]),
    sdkClient: {
      event: {
        subscribe: vi.fn().mockResolvedValue({
          stream: (async function* () {
            await new Promise(() => {});
          })(),
        }),
      },
    } as unknown as WrapperKiloClient['sdkClient'],
    serverUrl: 'http://127.0.0.1:0',
    ...overrides,
  };
}

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

/** Parse all messages sent through the WS and return them typed. */
function parseSentMessages(ws: MockWebSocket): ParsedEvent[] {
  return ws.sent.map(msg => JSON.parse(msg) as ParsedEvent);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sendKiloSnapshot → sendKiloState', () => {
  let state: WrapperState;
  let callbacks: ConnectionCallbacks;

  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.reset();
    vi.stubGlobal('WebSocket', MockWebSocket);
    stubFetch();

    state = new WrapperState();
    callbacks = createCallbacks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // -----------------------------------------------------------------------
  // 1. session.status sent as kilocode event (not kilo_snapshot)
  // -----------------------------------------------------------------------

  it('sends session.status as kilocode event (not kilo_snapshot)', async () => {
    const kiloClient = createMockKiloClient({
      getSessionStatuses: vi.fn().mockResolvedValue({
        kilo_sess_456: { type: 'idle' },
      }),
    });

    state.startJob(createJobContext());
    const manager = createConnectionManager(state, { kiloClient }, callbacks);
    const ws = await openConnection(manager);

    const messages = parseSentMessages(ws);

    // Must NOT contain a kilo_snapshot event
    const snapshotEvents = messages.filter(m => m.streamEventType === 'kilo_snapshot');
    expect(snapshotEvents).toHaveLength(0);

    // Must contain a kilocode event with event: 'session.status'
    const statusEvents = messages.filter(
      m => m.streamEventType === 'kilocode' && m.data.event === 'session.status'
    );
    expect(statusEvents).toHaveLength(1);
    expect(statusEvents[0].data).toMatchObject({
      event: 'session.status',
      sessionID: 'kilo_sess_456',
      status: { type: 'idle' },
    });
  });

  // -----------------------------------------------------------------------
  // 2. session.status with busy status from kilo server
  // -----------------------------------------------------------------------

  it('sends session.status with busy status from kilo server', async () => {
    const kiloClient = createMockKiloClient({
      getSessionStatuses: vi.fn().mockResolvedValue({
        kilo_sess_456: { type: 'busy' },
      }),
    });

    state.startJob(createJobContext());
    const manager = createConnectionManager(state, { kiloClient }, callbacks);
    const ws = await openConnection(manager);

    const messages = parseSentMessages(ws);
    const statusEvents = messages.filter(
      m => m.streamEventType === 'kilocode' && m.data.event === 'session.status'
    );

    expect(statusEvents).toHaveLength(1);
    expect(statusEvents[0].data).toMatchObject({
      event: 'session.status',
      sessionID: 'kilo_sess_456',
      status: { type: 'busy' },
    });
  });

  // -----------------------------------------------------------------------
  // 3. defaults session status to idle when not present
  // -----------------------------------------------------------------------

  it('defaults session status to idle when not present', async () => {
    const kiloClient = createMockKiloClient({
      getSessionStatuses: vi.fn().mockResolvedValue({}),
    });

    state.startJob(createJobContext());
    const manager = createConnectionManager(state, { kiloClient }, callbacks);
    const ws = await openConnection(manager);

    const messages = parseSentMessages(ws);
    const statusEvents = messages.filter(
      m => m.streamEventType === 'kilocode' && m.data.event === 'session.status'
    );

    expect(statusEvents).toHaveLength(1);
    expect(statusEvents[0].data).toMatchObject({
      event: 'session.status',
      sessionID: 'kilo_sess_456',
      status: { type: 'idle' },
    });
  });

  // -----------------------------------------------------------------------
  // 4. replays pending question as kilocode event
  // -----------------------------------------------------------------------

  it('replays pending question as kilocode event', async () => {
    const pendingQuestion = {
      id: 'q_123',
      sessionID: 'kilo_sess_456',
      tool: { messageID: 'msg_1', callID: 'call_1' },
      questions: [
        { question: 'Pick a color', header: 'Color', options: [{ label: 'Red', description: '' }] },
      ],
    };

    const kiloClient = createMockKiloClient({
      getQuestions: vi.fn().mockResolvedValue([pendingQuestion]),
    });

    state.startJob(createJobContext());
    const manager = createConnectionManager(state, { kiloClient }, callbacks);
    const ws = await openConnection(manager);

    const messages = parseSentMessages(ws);
    const questionEvents = messages.filter(
      m => m.streamEventType === 'kilocode' && m.data.event === 'question.asked'
    );

    expect(questionEvents).toHaveLength(1);
    expect(questionEvents[0].data).toMatchObject({
      event: 'question.asked',
      properties: pendingQuestion,
    });
  });

  // -----------------------------------------------------------------------
  // 5. replays pending permission as kilocode event
  // -----------------------------------------------------------------------

  it('replays pending permission as kilocode event', async () => {
    const pendingPermission = {
      id: 'p_456',
      sessionID: 'kilo_sess_456',
      permission: 'file_write',
      patterns: ['**/*.ts'],
      metadata: {},
      always: [],
      tool: { messageID: 'msg_2', callID: 'call_2' },
    };

    const kiloClient = createMockKiloClient({
      getPermissions: vi.fn().mockResolvedValue([pendingPermission]),
    });

    state.startJob(createJobContext());
    const manager = createConnectionManager(state, { kiloClient }, callbacks);
    const ws = await openConnection(manager);

    const messages = parseSentMessages(ws);
    const permissionEvents = messages.filter(
      m => m.streamEventType === 'kilocode' && m.data.event === 'permission.asked'
    );

    expect(permissionEvents).toHaveLength(1);
    expect(permissionEvents[0].data).toMatchObject({
      event: 'permission.asked',
      properties: pendingPermission,
    });
  });

  // -----------------------------------------------------------------------
  // 6. does not send question event when no question is pending
  // -----------------------------------------------------------------------

  it('does not send question event when no question is pending', async () => {
    const kiloClient = createMockKiloClient({
      getQuestions: vi.fn().mockResolvedValue([]),
    });

    state.startJob(createJobContext());
    const manager = createConnectionManager(state, { kiloClient }, callbacks);
    const ws = await openConnection(manager);

    const messages = parseSentMessages(ws);
    const questionEvents = messages.filter(
      m => m.streamEventType === 'kilocode' && m.data.event === 'question.asked'
    );

    expect(questionEvents).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // 7. does not send permission event when no permission is pending
  // -----------------------------------------------------------------------

  it('does not send permission event when no permission is pending', async () => {
    const kiloClient = createMockKiloClient({
      getPermissions: vi.fn().mockResolvedValue([]),
    });

    state.startJob(createJobContext());
    const manager = createConnectionManager(state, { kiloClient }, callbacks);
    const ws = await openConnection(manager);

    const messages = parseSentMessages(ws);
    const permissionEvents = messages.filter(
      m => m.streamEventType === 'kilocode' && m.data.event === 'permission.asked'
    );

    expect(permissionEvents).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // 8. skips when no kiloSessionId is available
  // -----------------------------------------------------------------------

  it('skips when no kiloSessionId is available', async () => {
    const kiloClient = createMockKiloClient();

    // Don't start a job — no kiloSessionId will be available
    state = new WrapperState();
    // Start a job without kiloSessionId by providing an empty string
    // Actually, we need ingestUrl/token for the WS to open, so start a job
    // but with no kiloSessionId set. The simplest way: don't call startJob
    // at all, but then openIngestWs will throw "no job context".
    // Instead, set a job with empty kiloSessionId.
    state.startJob({
      executionId: 'exec_test',
      kiloSessionId: '',
      ingestUrl: 'wss://ingest.example.com/ingest',
      ingestToken: 'token_secret',
      workerAuthToken: 'kilo_token_789',
    });

    const manager = createConnectionManager(state, { kiloClient }, callbacks);
    const ws = await openConnection(manager);

    const messages = parseSentMessages(ws);

    // No kilo_snapshot or kilocode session.status events should be sent
    const snapshotEvents = messages.filter(m => m.streamEventType === 'kilo_snapshot');
    const statusEvents = messages.filter(
      m => m.streamEventType === 'kilocode' && m.data.event === 'session.status'
    );

    expect(snapshotEvents).toHaveLength(0);
    expect(statusEvents).toHaveLength(0);

    // API methods should not have been called
    expect(kiloClient.getSessionStatuses).not.toHaveBeenCalled();
    expect(kiloClient.getQuestions).not.toHaveBeenCalled();
    expect(kiloClient.getPermissions).not.toHaveBeenCalled();
  });
});
