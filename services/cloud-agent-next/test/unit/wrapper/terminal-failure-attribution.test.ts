/**
 * Unit tests for Tier-1 failure attribution in createConnectionManager:
 * output-limit termination (finish === "length" / MessageOutputLengthError).
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  createConnectionManager,
  type ConnectionCallbacks,
} from '../../../wrapper/src/connection.js';
import { WrapperState, type SessionContext } from '../../../wrapper/src/state.js';
import type { KiloEvent, WrapperKiloClient } from '../../../wrapper/src/kilo-api.js';

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

const ROOT_SESSION_ID = 'kilo_sess_456';
const CHILD_SESSION_ID = 'kilo_sess_child';
const ASSISTANT_MESSAGE_ID = 'assistant_msg_root_123';

const createSessionContext = (overrides: Partial<SessionContext> = {}): SessionContext => ({
  kiloSessionId: ROOT_SESSION_ID,
  ingestUrl: 'wss://ingest.example.com/ingest',
  ingestToken: 'token_secret',
  workerAuthToken: 'kilo_token_789',
  wrapperRunId: 'run_test',
  wrapperGeneration: 7,
  wrapperConnectionId: 'conn_test',
  ...overrides,
});

const createCallbacks = (): ConnectionCallbacks & {
  onTerminalError: ReturnType<typeof vi.fn>;
  onCompletionSignal: ReturnType<typeof vi.fn>;
  onSessionIdle: ReturnType<typeof vi.fn>;
  onDisconnect: ReturnType<typeof vi.fn>;
} => ({
  onTerminalError: vi.fn(),
  onCommand: vi.fn(),
  onDisconnect: vi.fn(),
  onCompletionSignal: vi.fn(),
  onSessionIdle: vi.fn(),
  onSseEvent: vi.fn(),
});

const createMockKiloClient = (overrides: Partial<WrapperKiloClient> = {}): WrapperKiloClient => ({
  createSession: vi.fn().mockResolvedValue({ id: 'kilo_sess' }),
  getSession: vi.fn().mockResolvedValue({ id: 'kilo_sess' }),
  sendPromptAsync: vi.fn().mockResolvedValue(undefined),
  abortSession: vi.fn().mockResolvedValue(true),
  summarizeSession: vi.fn().mockResolvedValue(true),
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
  listEffectiveModels: vi.fn().mockResolvedValue([]),
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

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(() => {
      const stream = new ReadableStream({
        start() {},
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

function rootAssistantUpdated(overrides: {
  finish?: string;
  sessionID?: string;
  error?: { name: string };
}): KiloEvent {
  return {
    type: 'message.updated',
    properties: {
      info: {
        id: ASSISTANT_MESSAGE_ID,
        role: 'assistant',
        sessionID: overrides.sessionID ?? ROOT_SESSION_ID,
        finish: overrides.finish,
        time: { completed: 1_716_200_000_000 },
        ...(overrides.error ? { error: overrides.error } : {}),
      },
    },
  };
}

function rootIdle(): KiloEvent {
  return { type: 'session.idle', properties: { sessionID: ROOT_SESSION_ID } };
}

describe('terminal failure attribution', () => {
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

  async function runEvents(events: KiloEvent[], session: SessionContext = createSessionContext()) {
    state = new WrapperState();
    state.bindSession(session);
    const kiloClient = createMockKiloClient({
      subscribeEvents: vi.fn().mockResolvedValue({
        stream: createEventStream(events),
      }),
    });
    const manager = createConnectionManager(state, { kiloClient }, callbacks);
    await openConnection(manager);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
  }

  it('raises kilo_output_limit for finish=length on the root session', async () => {
    await runEvents([rootAssistantUpdated({ finish: 'length' })]);

    expect(callbacks.onTerminalError).toHaveBeenCalledWith({
      code: 'kilo_output_limit',
      message: 'Assistant response hit the output length limit',
      errorSource: 'assistant',
    });
    expect(callbacks.onCompletionSignal).not.toHaveBeenCalled();
  });

  it('raises kilo_output_limit for MessageOutputLengthError on the root session', async () => {
    await runEvents([rootAssistantUpdated({ error: { name: 'MessageOutputLengthError' } })]);

    expect(callbacks.onTerminalError).toHaveBeenCalledWith({
      code: 'kilo_output_limit',
      message: 'Assistant response hit the output length limit',
      errorSource: 'assistant',
    });
    expect(callbacks.onCompletionSignal).not.toHaveBeenCalled();
  });

  it('does not raise kilo_output_limit for finish=length on a child session', async () => {
    await runEvents([
      rootAssistantUpdated({ finish: 'length', sessionID: CHILD_SESSION_ID }),
      rootIdle(),
    ]);

    expect(callbacks.onTerminalError).not.toHaveBeenCalled();
    expect(callbacks.onCompletionSignal).toHaveBeenCalled();
  });

  it('completes finish=stop with no visible text as success', async () => {
    await runEvents([rootAssistantUpdated({ finish: 'stop' }), rootIdle()]);

    expect(callbacks.onTerminalError).not.toHaveBeenCalled();
    expect(callbacks.onCompletionSignal).toHaveBeenCalled();
    expect(callbacks.onSessionIdle).toHaveBeenCalled();
  });

  it('skips output-limit detection while finalizing', async () => {
    state = new WrapperState();
    state.bindSession(createSessionContext());
    state.acceptMessage('msg_1', {
      autoCommit: false,
      condenseOnComplete: true,
    });
    expect(state.beginFinalizing()).toBe(true);

    const kiloClient = createMockKiloClient({
      subscribeEvents: vi.fn().mockResolvedValue({
        stream: createEventStream([rootAssistantUpdated({ finish: 'length' }), rootIdle()]),
      }),
    });
    const manager = createConnectionManager(state, { kiloClient }, callbacks);
    await openConnection(manager);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(callbacks.onTerminalError).not.toHaveBeenCalled();
    expect(callbacks.onCompletionSignal).toHaveBeenCalled();
    expect(callbacks.onSessionIdle).toHaveBeenCalled();
  });
});
