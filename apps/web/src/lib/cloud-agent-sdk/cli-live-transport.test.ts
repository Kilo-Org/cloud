/**
 * Tests for CliLiveTransport — verifies WebSocket subscribe/unsubscribe,
 * event routing, session filtering, system events, and snapshot preload.
 */
import type { ChatEvent, ServiceEvent } from './normalizer';
import { createCliLiveTransport } from './cli-live-transport';
import { configureCloudAgentSdkRuntime, resetCloudAgentSdkRuntime } from './runtime';
import type { KiloSessionId, SessionSnapshot } from './types';
import { kiloId, makeSnapshot, stubUserMessage, stubTextPart } from './test-helpers';

// ---------------------------------------------------------------------------
// WebSocket mock
// ---------------------------------------------------------------------------

type MockWebSocket = {
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  close: jest.Mock;
  send: jest.Mock;
  readyState: number;
};

let mockWs: MockWebSocket;
let webSocketConstructor: jest.Mock;

beforeEach(() => {
  mockWs = {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    close: jest.fn(),
    send: jest.fn(),
    readyState: 1,
  };

  configureCloudAgentSdkRuntime({ randomUUID: () => 'mock-uuid-1234' });

  webSocketConstructor = jest.fn(() => mockWs);

  // @ts-expect-error -- minimal WebSocket mock for testing
  global.WebSocket = webSocketConstructor;
  // Provide OPEN constant used by readyState check
  (global.WebSocket as unknown as Record<string, number>).OPEN = 1;
});

afterEach(() => {
  // @ts-expect-error -- cleanup global mock
  delete global.WebSocket;
  resetCloudAgentSdkRuntime();
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const KILO_SESSION_ID = kiloId('kilo-ses-1');
const WS_URL = 'wss://localhost:9999/api/user/web';

function sendInbound(msg: Record<string, unknown>): void {
  mockWs.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent);
}

function openConnection(): void {
  mockWs.onopen?.({} as Event);
}

function createTransportWithSinks(opts?: {
  getAuthToken?: () => string | Promise<string>;
  fetchSnapshot?: (kiloSessionId: KiloSessionId) => Promise<SessionSnapshot>;
  onError?: (message: string) => void;
}) {
  const chatEvents: ChatEvent[] = [];
  const serviceEvents: ServiceEvent[] = [];

  const factory = createCliLiveTransport({
    kiloSessionId: KILO_SESSION_ID,
    websocketUrl: WS_URL,
    getAuthToken: opts?.getAuthToken ?? (() => 'test-token'),
    fetchSnapshot: opts?.fetchSnapshot,
    onError: opts?.onError,
  });

  const transport = factory({
    onChatEvent: event => chatEvents.push(event),
    onServiceEvent: event => serviceEvents.push(event),
  });

  return { transport, chatEvents, serviceEvents };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CliLiveTransport subscribe/unsubscribe', () => {
  it('sends subscribe message on connect', () => {
    const { transport } = createTransportWithSinks();

    transport.connect();
    openConnection();

    expect(mockWs.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'subscribe', sessionId: KILO_SESSION_ID })
    );

    transport.destroy();
  });

  it('sends unsubscribe on disconnect', () => {
    const { transport } = createTransportWithSinks();

    transport.connect();
    openConnection();
    mockWs.send.mockClear();

    transport.disconnect();

    expect(mockWs.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'unsubscribe', sessionId: KILO_SESSION_ID })
    );
  });
});

describe('CliLiveTransport event routing', () => {
  it('routes CLI chat events to onChatEvent', () => {
    const { transport, chatEvents, serviceEvents } = createTransportWithSinks();

    transport.connect();
    openConnection();

    sendInbound({
      type: 'event',
      sessionId: KILO_SESSION_ID,
      event: 'message.updated',
      data: {
        info: {
          id: 'msg-1',
          sessionID: 'ses-1',
          role: 'assistant',
          time: { created: 1 },
        },
      },
    });

    expect(chatEvents).toHaveLength(1);
    expect(chatEvents[0]).toEqual(expect.objectContaining({ type: 'message.updated' }));
    expect(serviceEvents).toHaveLength(0);

    transport.destroy();
  });

  it('routes CLI service events to onServiceEvent', () => {
    const { transport, chatEvents, serviceEvents } = createTransportWithSinks();

    transport.connect();
    openConnection();

    sendInbound({
      type: 'event',
      sessionId: KILO_SESSION_ID,
      event: 'session.status',
      data: { sessionID: KILO_SESSION_ID, status: { type: 'busy' } },
    });

    expect(serviceEvents).toHaveLength(1);
    expect(serviceEvents[0]).toEqual(expect.objectContaining({ type: 'session.status' }));
    expect(chatEvents).toHaveLength(0);

    transport.destroy();
  });

  it('filters events for wrong sessionId', () => {
    const { transport, chatEvents, serviceEvents } = createTransportWithSinks();

    transport.connect();
    openConnection();

    sendInbound({
      type: 'event',
      sessionId: 'other-session-id',
      event: 'message.updated',
      data: {
        info: {
          id: 'msg-1',
          sessionID: 'ses-1',
          role: 'assistant',
          time: { created: 1 },
        },
      },
    });

    expect(chatEvents).toHaveLength(0);
    expect(serviceEvents).toHaveLength(0);

    transport.destroy();
  });

  it('accepts child session events with parentSessionId matching root', () => {
    const { transport, chatEvents, serviceEvents } = createTransportWithSinks();

    transport.connect();
    openConnection();

    sendInbound({
      type: 'event',
      sessionId: 'child-session-1',
      parentSessionId: KILO_SESSION_ID,
      event: 'message.updated',
      data: {
        info: {
          id: 'msg-child-1',
          sessionID: 'child-session-1',
          role: 'assistant',
          time: { created: 1 },
        },
      },
    });

    expect(chatEvents).toHaveLength(1);
    expect(chatEvents[0]).toEqual(expect.objectContaining({ type: 'message.updated' }));
    expect(serviceEvents).toHaveLength(0);

    transport.destroy();
  });

  it('accepts child service events with parentSessionId matching root', () => {
    const { transport, chatEvents, serviceEvents } = createTransportWithSinks();

    transport.connect();
    openConnection();

    sendInbound({
      type: 'event',
      sessionId: 'child-session-1',
      parentSessionId: KILO_SESSION_ID,
      event: 'session.created',
      data: { info: { id: 'child-session-1', parentID: KILO_SESSION_ID } },
    });

    expect(serviceEvents).toHaveLength(1);
    expect(serviceEvents[0]).toEqual(expect.objectContaining({ type: 'session.created' }));
    expect(chatEvents).toHaveLength(0);

    transport.destroy();
  });

  it('drops events where neither sessionId nor parentSessionId matches root', () => {
    const { transport, chatEvents, serviceEvents } = createTransportWithSinks();

    transport.connect();
    openConnection();

    sendInbound({
      type: 'event',
      sessionId: 'child-session-1',
      parentSessionId: 'some-other-parent',
      event: 'message.updated',
      data: {
        info: {
          id: 'msg-1',
          sessionID: 'ses-1',
          role: 'assistant',
          time: { created: 1 },
        },
      },
    });

    expect(chatEvents).toHaveLength(0);
    expect(serviceEvents).toHaveLength(0);

    transport.destroy();
  });

  it('events without parentSessionId still work (backward compat)', () => {
    const { transport, chatEvents } = createTransportWithSinks();

    transport.connect();
    openConnection();

    sendInbound({
      type: 'event',
      sessionId: KILO_SESSION_ID,
      event: 'message.updated',
      data: {
        info: {
          id: 'msg-1',
          sessionID: 'ses-1',
          role: 'assistant',
          time: { created: 1 },
        },
      },
    });

    expect(chatEvents).toHaveLength(1);

    transport.destroy();
  });
});

describe('CliLiveTransport system events', () => {
  it('cli.disconnected fires stopped event', () => {
    const { transport, serviceEvents } = createTransportWithSinks();

    transport.connect();
    openConnection();

    sendInbound({
      type: 'system',
      event: 'cli.disconnected',
      data: { connectionId: 'conn-1' },
    });

    expect(serviceEvents).toHaveLength(1);
    expect(serviceEvents[0]).toEqual({
      type: 'stopped',
      reason: 'disconnected',
    });

    transport.destroy();
  });

  it('session disappearing from heartbeat fires stopped event', () => {
    const { transport, serviceEvents } = createTransportWithSinks();

    transport.connect();
    openConnection();

    sendInbound({
      type: 'system',
      event: 'sessions.heartbeat',
      data: {
        connectionId: 'c1',
        sessions: [{ id: 'other-session', status: 'active', title: 'Other' }],
      },
    });

    expect(serviceEvents).toHaveLength(1);
    expect(serviceEvents[0]).toEqual({
      type: 'stopped',
      reason: 'disconnected',
    });

    transport.destroy();
  });

  it('session present in heartbeat does not fire stopped event', () => {
    const { transport, serviceEvents } = createTransportWithSinks();

    transport.connect();
    openConnection();

    sendInbound({
      type: 'system',
      event: 'sessions.heartbeat',
      data: {
        connectionId: 'c1',
        sessions: [{ id: KILO_SESSION_ID, status: 'active', title: 'My Session' }],
      },
    });

    expect(serviceEvents).toHaveLength(0);

    transport.destroy();
  });

  it('sessions.list with missing session fires stopped event', () => {
    const { transport, serviceEvents } = createTransportWithSinks();

    transport.connect();
    openConnection();

    sendInbound({
      type: 'system',
      event: 'sessions.list',
      data: {
        connectionId: 'c1',
        sessions: [],
      },
    });

    expect(serviceEvents).toHaveLength(1);
    expect(serviceEvents[0]).toEqual({
      type: 'stopped',
      reason: 'disconnected',
    });

    transport.destroy();
  });

  it('heartbeat from non-owner connection does not fire stopped', () => {
    const { transport, serviceEvents } = createTransportWithSinks();

    transport.connect();
    openConnection();

    // First heartbeat establishes owner as 'owner-conn'
    sendInbound({
      type: 'system',
      event: 'sessions.heartbeat',
      data: {
        connectionId: 'owner-conn',
        sessions: [
          {
            id: KILO_SESSION_ID,
            status: 'active',
            title: 'My Session',
            connectionId: 'owner-conn',
          },
        ],
      },
    });

    // Heartbeat from a different connection that doesn't list our session
    sendInbound({
      type: 'system',
      event: 'sessions.heartbeat',
      data: {
        connectionId: 'other-conn',
        sessions: [{ id: 'other-session', status: 'active', title: 'Other' }],
      },
    });

    expect(serviceEvents.filter(e => e.type === 'stopped')).toHaveLength(0);

    transport.destroy();
  });

  it('heartbeat from owner connection without session fires stopped', () => {
    const { transport, serviceEvents } = createTransportWithSinks();

    transport.connect();
    openConnection();

    // First heartbeat establishes owner as 'owner-conn'
    sendInbound({
      type: 'system',
      event: 'sessions.heartbeat',
      data: {
        connectionId: 'owner-conn',
        sessions: [
          {
            id: KILO_SESSION_ID,
            status: 'active',
            title: 'My Session',
            connectionId: 'owner-conn',
          },
        ],
      },
    });

    // Owner connection heartbeat no longer lists our session
    sendInbound({
      type: 'system',
      event: 'sessions.heartbeat',
      data: {
        connectionId: 'owner-conn',
        sessions: [],
      },
    });

    expect(serviceEvents.filter(e => e.type === 'stopped')).toHaveLength(1);
    expect(serviceEvents.at(-1)).toEqual({ type: 'stopped', reason: 'disconnected' });

    transport.destroy();
  });
});

describe('CliLiveTransport snapshot preload', () => {
  it('replays snapshot history before WebSocket events', async () => {
    const snapshot: SessionSnapshot = makeSnapshot({ id: KILO_SESSION_ID }, [
      {
        info: stubUserMessage({ id: 'msg-1', sessionID: KILO_SESSION_ID }),
        parts: [stubTextPart({ id: 'part-1', sessionID: KILO_SESSION_ID, messageID: 'msg-1' })],
      },
    ]);

    const fetchSnapshot = jest.fn(() => Promise.resolve(snapshot));
    const { transport, chatEvents, serviceEvents } = createTransportWithSinks({
      fetchSnapshot,
    });

    transport.connect();

    // Wait for snapshot promise to resolve
    await Promise.resolve();
    await Promise.resolve();

    // Snapshot should have been replayed: session.created + message.updated + message.part.updated
    expect(serviceEvents).toHaveLength(1);
    expect(serviceEvents[0]).toEqual(expect.objectContaining({ type: 'session.created' }));
    expect(chatEvents).toHaveLength(2);
    expect(chatEvents[0]).toEqual(expect.objectContaining({ type: 'message.updated' }));
    expect(chatEvents[1]).toEqual(expect.objectContaining({ type: 'message.part.updated' }));

    // No stopped event — this is live, not historical
    const stoppedEvents = serviceEvents.filter(e => e.type === 'stopped');
    expect(stoppedEvents).toHaveLength(0);

    // WebSocket should now be connected
    expect(webSocketConstructor).toHaveBeenCalled();

    // Open the WS and send a live event
    openConnection();
    sendInbound({
      type: 'event',
      sessionId: KILO_SESSION_ID,
      event: 'message.updated',
      data: {
        info: {
          id: 'msg-2',
          sessionID: KILO_SESSION_ID,
          role: 'assistant',
          time: { created: 2 },
        },
      },
    });

    expect(chatEvents).toHaveLength(3);
    expect(chatEvents[2]).toEqual(expect.objectContaining({ type: 'message.updated' }));

    transport.destroy();
  });
});

describe('CliLiveTransport lifecycle', () => {
  it('disconnect during snapshot preload cancels connection', async () => {
    let resolveSnapshot: ((val: SessionSnapshot) => void) | undefined;
    const fetchSnapshot = jest.fn(
      () =>
        new Promise<SessionSnapshot>(resolve => {
          resolveSnapshot = resolve;
        })
    );
    const { transport, chatEvents, serviceEvents } = createTransportWithSinks({
      fetchSnapshot,
    });

    transport.connect();

    // Disconnect before snapshot resolves
    transport.disconnect();

    // Now resolve snapshot — should be ignored due to generation mismatch
    resolveSnapshot?.(makeSnapshot({ id: KILO_SESSION_ID }));
    await Promise.resolve();
    await Promise.resolve();

    expect(chatEvents).toHaveLength(0);
    expect(serviceEvents).toHaveLength(0);
    expect(webSocketConstructor).not.toHaveBeenCalled();
  });

  it('includes auth token in WebSocket URL', () => {
    const { transport } = createTransportWithSinks({
      getAuthToken: () => 'my-secret-token',
    });

    transport.connect();

    expect(webSocketConstructor).toHaveBeenCalledWith(`${WS_URL}?token=my-secret-token`);

    transport.destroy();
  });

  it('handles async getAuthToken', async () => {
    const { transport } = createTransportWithSinks({
      getAuthToken: () => Promise.resolve('async-token'),
    });

    transport.connect();
    await Promise.resolve();

    expect(webSocketConstructor).toHaveBeenCalledWith(`${WS_URL}?token=async-token`);

    transport.destroy();
  });
});

describe('CliLiveTransport typed command methods', () => {
  it('send() formats and sends command message over WebSocket', () => {
    const { transport } = createTransportWithSinks();

    transport.connect();
    openConnection();
    mockWs.send.mockClear();

    const promise = transport.send!({ prompt: 'hello', mode: 'code', model: 'test-model' });

    expect(mockWs.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'command',
        id: 'mock-uuid-1234',
        command: 'send_message',
        sessionId: KILO_SESSION_ID,
        data: {
          sessionID: KILO_SESSION_ID,
          parts: [{ type: 'text', text: 'hello' }],
          agent: 'code',
          model: 'test-model',
        },
      })
    );

    // Resolve the pending promise so it doesn't leak
    sendInbound({ type: 'response', id: 'mock-uuid-1234', result: {} });
    return promise;
  });

  it('send() omits agent and model when not provided', () => {
    const { transport } = createTransportWithSinks();

    transport.connect();
    openConnection();
    mockWs.send.mockClear();

    const promise = transport.send!({ prompt: 'hi' });

    const sent = JSON.parse(mockWs.send.mock.calls[0][0]) as { data: Record<string, unknown> };
    expect(sent.data).toEqual({
      sessionID: KILO_SESSION_ID,
      parts: [{ type: 'text', text: 'hi' }],
    });
    // agent and model should not be in the payload
    expect(sent.data).not.toHaveProperty('agent');
    expect(sent.data).not.toHaveProperty('model');

    sendInbound({ type: 'response', id: 'mock-uuid-1234', result: {} });
    return promise;
  });

  it('interrupt() sends interrupt command', () => {
    const { transport } = createTransportWithSinks();

    transport.connect();
    openConnection();
    mockWs.send.mockClear();

    const promise = transport.interrupt!();

    const sent = JSON.parse(mockWs.send.mock.calls[0][0]) as { command: string };
    expect(sent.command).toBe('interrupt');

    sendInbound({ type: 'response', id: 'mock-uuid-1234', result: {} });
    return promise;
  });

  it('answer() sends question_reply command', () => {
    const { transport } = createTransportWithSinks();

    transport.connect();
    openConnection();
    mockWs.send.mockClear();

    const promise = transport.answer!({ requestId: 'req-1', answers: [['yes']] });

    const sent = JSON.parse(mockWs.send.mock.calls[0][0]) as {
      command: string;
      data: Record<string, unknown>;
    };
    expect(sent.command).toBe('question_reply');
    expect(sent.data).toEqual({ requestID: 'req-1', answers: [['yes']] });

    sendInbound({ type: 'response', id: 'mock-uuid-1234', result: {} });
    return promise;
  });

  it('reject() sends question_reject command', () => {
    const { transport } = createTransportWithSinks();

    transport.connect();
    openConnection();
    mockWs.send.mockClear();

    const promise = transport.reject!({ requestId: 'req-2' });

    const sent = JSON.parse(mockWs.send.mock.calls[0][0]) as {
      command: string;
      data: Record<string, unknown>;
    };
    expect(sent.command).toBe('question_reject');
    expect(sent.data).toEqual({ requestID: 'req-2' });

    sendInbound({ type: 'response', id: 'mock-uuid-1234', result: {} });
    return promise;
  });

  it('respondToPermission() sends permission_respond command', () => {
    const { transport } = createTransportWithSinks();

    transport.connect();
    openConnection();
    mockWs.send.mockClear();

    const promise = transport.respondToPermission!({ requestId: 'req-3', response: 'always' });

    const sent = JSON.parse(mockWs.send.mock.calls[0][0]) as {
      command: string;
      data: Record<string, unknown>;
    };
    expect(sent.command).toBe('permission_respond');
    expect(sent.data).toEqual({ requestID: 'req-3', reply: 'always' });

    sendInbound({ type: 'response', id: 'mock-uuid-1234', result: {} });
    return promise;
  });

  it('resolves when response arrives', async () => {
    const { transport } = createTransportWithSinks();

    transport.connect();
    openConnection();

    const promise = transport.send!({ prompt: 'hello' });

    const sentPayload = JSON.parse(mockWs.send.mock.calls.at(-1)[0]) as { id: string };
    sendInbound({ type: 'response', id: sentPayload.id, result: { ok: true } });

    await expect(promise).resolves.toEqual({ ok: true });

    transport.destroy();
  });

  it('rejects when error response arrives', async () => {
    const { transport } = createTransportWithSinks();

    transport.connect();
    openConnection();

    const promise = transport.send!({ prompt: 'fail' });

    const sentPayload = JSON.parse(mockWs.send.mock.calls.at(-1)[0]) as { id: string };
    sendInbound({ type: 'response', id: sentPayload.id, error: 'bad request' });

    await expect(promise).rejects.toThrow('bad request');

    transport.destroy();
  });

  it('rejects with "WebSocket is not connected" when not connected', async () => {
    const { transport } = createTransportWithSinks();

    await expect(transport.send!({ prompt: 'hello' })).rejects.toThrow(
      'WebSocket is not connected'
    );
  });

  it('rejects pending commands on disconnect', async () => {
    const { transport } = createTransportWithSinks();

    transport.connect();
    openConnection();

    const promise = transport.send!({ prompt: 'hello' });

    transport.disconnect();

    await expect(promise).rejects.toThrow('Transport disconnected');
  });

  it('rejects pending commands on destroy', async () => {
    const { transport } = createTransportWithSinks();

    transport.connect();
    openConnection();

    const promise = transport.send!({ prompt: 'hello' });

    transport.destroy();

    await expect(promise).rejects.toThrow('Transport disconnected');
  });

  it('ignores responses for unknown command ids', () => {
    const { transport } = createTransportWithSinks();

    transport.connect();
    openConnection();

    // Should not throw
    sendInbound({ type: 'response', id: 'unknown-id', result: {} });

    transport.destroy();
  });

  it('command times out after 30s and rejects', async () => {
    jest.useFakeTimers();
    try {
      const { transport } = createTransportWithSinks();

      transport.connect();
      openConnection();

      const promise = transport.send!({ prompt: 'hello' });

      jest.advanceTimersByTime(30_000);

      await expect(promise).rejects.toThrow('Command timed out');

      transport.destroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('response before timeout clears timer and resolves', async () => {
    jest.useFakeTimers();
    try {
      const { transport } = createTransportWithSinks();

      transport.connect();
      openConnection();

      const promise = transport.send!({ prompt: 'hello' });

      const sentPayload = JSON.parse(mockWs.send.mock.calls.at(-1)[0]) as { id: string };
      sendInbound({
        type: 'response',
        id: sentPayload.id,
        result: { ok: true },
      });

      // Advance well past timeout — should not reject
      jest.advanceTimersByTime(30_000);

      await expect(promise).resolves.toEqual({ ok: true });

      transport.destroy();
    } finally {
      jest.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Stopped event deduplication (Phase 2a)
// ---------------------------------------------------------------------------

describe('CliLiveTransport stopped event deduplication', () => {
  it('multiple heartbeats with missing session fire only one stopped event', () => {
    const { transport, serviceEvents } = createTransportWithSinks();

    transport.connect();
    openConnection();

    // First heartbeat without our session → stopped
    sendInbound({
      type: 'system',
      event: 'sessions.heartbeat',
      data: {
        connectionId: 'c1',
        sessions: [{ id: 'other-session', status: 'active', title: 'Other' }],
      },
    });

    // Second heartbeat without our session → no second stopped
    sendInbound({
      type: 'system',
      event: 'sessions.heartbeat',
      data: {
        connectionId: 'c1',
        sessions: [],
      },
    });

    const stoppedEvents = serviceEvents.filter(e => e.type === 'stopped');
    expect(stoppedEvents).toHaveLength(1);

    transport.destroy();
  });

  it('cli.disconnected after heartbeat-stopped does not fire again', () => {
    const { transport, serviceEvents } = createTransportWithSinks();

    transport.connect();
    openConnection();

    // Session absent from heartbeat → stopped
    sendInbound({
      type: 'system',
      event: 'sessions.heartbeat',
      data: {
        connectionId: 'c1',
        sessions: [],
      },
    });

    expect(serviceEvents.filter(e => e.type === 'stopped')).toHaveLength(1);

    // cli.disconnected arrives → no second stopped
    sendInbound({
      type: 'system',
      event: 'cli.disconnected',
      data: { connectionId: 'c1' },
    });

    expect(serviceEvents.filter(e => e.type === 'stopped')).toHaveLength(1);

    transport.destroy();
  });

  it('sessionStopped flag resets on reconnect', () => {
    jest.useFakeTimers();
    try {
      const { transport, serviceEvents } = createTransportWithSinks();

      transport.connect();
      openConnection();

      // Session absent from heartbeat → stopped
      sendInbound({
        type: 'system',
        event: 'sessions.heartbeat',
        data: {
          connectionId: 'c1',
          sessions: [],
        },
      });

      expect(serviceEvents.filter(e => e.type === 'stopped')).toHaveLength(1);

      // Simulate unexpected close → triggers reconnect
      mockWs.onclose?.({ code: 1006 } as CloseEvent);

      // Advance past backoff delay
      jest.advanceTimersByTime(60_000);

      // Get reference to the new WebSocket
      const newMockWs = webSocketConstructor.mock.results.at(-1)?.value as MockWebSocket;
      // Open the new connection
      newMockWs.onopen?.({} as Event);

      // Session absent from heartbeat again → second stopped fires (flag was reset)
      newMockWs.onmessage?.({
        data: JSON.stringify({
          type: 'system',
          event: 'sessions.heartbeat',
          data: {
            connectionId: 'c2',
            sessions: [],
          },
        }),
      } as MessageEvent);

      expect(serviceEvents.filter(e => e.type === 'stopped')).toHaveLength(2);

      transport.destroy();
    } finally {
      jest.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Destroy sends unsubscribe (Phase 2b)
// ---------------------------------------------------------------------------

describe('CliLiveTransport subscribe/unsubscribe — destroy', () => {
  it('sends unsubscribe on destroy when connected', () => {
    const { transport } = createTransportWithSinks();

    transport.connect();
    openConnection();
    mockWs.send.mockClear();

    transport.destroy();

    expect(mockWs.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'unsubscribe', sessionId: KILO_SESSION_ID })
    );
  });

  it('does not send unsubscribe on destroy when not connected', () => {
    const { transport } = createTransportWithSinks();

    // Don't connect — just destroy
    transport.destroy();

    expect(mockWs.send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Auth failure handling (Phase 2c)
// ---------------------------------------------------------------------------

describe('CliLiveTransport auth failure', () => {
  it('close code 4001 triggers auth refresh and reconnect', async () => {
    let tokenCallCount = 0;
    const getAuthToken = jest.fn(() => {
      tokenCallCount++;
      return `token-${tokenCallCount}`;
    });

    const { transport } = createTransportWithSinks({ getAuthToken });
    transport.connect();
    openConnection();

    // Simulate auth failure close
    mockWs.onclose?.({ code: 4001 } as CloseEvent);

    // refreshAuth is async, so wait for microtasks
    await Promise.resolve();
    await Promise.resolve();

    // Should have created a new WebSocket with refreshed token
    expect(getAuthToken).toHaveBeenCalledTimes(2); // initial + refresh
    expect(webSocketConstructor).toHaveBeenCalledTimes(2);
    expect(webSocketConstructor).toHaveBeenLastCalledWith(expect.stringContaining('token-2'));

    transport.destroy();
  });

  it('close code 1008 triggers auth refresh and reconnect', async () => {
    let tokenCallCount = 0;
    const getAuthToken = jest.fn(() => {
      tokenCallCount++;
      return `token-${tokenCallCount}`;
    });

    const { transport } = createTransportWithSinks({ getAuthToken });
    transport.connect();
    openConnection();

    // Simulate auth failure close with 1008
    mockWs.onclose?.({ code: 1008 } as CloseEvent);

    await Promise.resolve();
    await Promise.resolve();

    expect(getAuthToken).toHaveBeenCalledTimes(2);
    expect(webSocketConstructor).toHaveBeenCalledTimes(2);
    expect(webSocketConstructor).toHaveBeenLastCalledWith(expect.stringContaining('token-2'));

    transport.destroy();
  });

  it('auth refresh failure stops retrying', async () => {
    const onError = jest.fn();
    let callCount = 0;
    const getAuthToken = jest.fn(() => {
      callCount++;
      if (callCount === 1) return 'initial-token';
      throw new Error('token fetch failed');
    });

    const { transport } = createTransportWithSinks({ getAuthToken, onError });
    transport.connect();
    openConnection();

    // Simulate auth failure close
    mockWs.onclose?.({ code: 4001 } as CloseEvent);

    // refreshAuth calls getAuthToken which throws — wait for async handling
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Should not have created a second WebSocket (refresh failed)
    expect(webSocketConstructor).toHaveBeenCalledTimes(1);

    transport.destroy();
  });
});

// ---------------------------------------------------------------------------
// cli.disconnected connectionId filtering (Phase 3a)
// ---------------------------------------------------------------------------

describe('CliLiveTransport cli.disconnected filtering', () => {
  it('fires stopped when disconnected connectionId matches session owner', () => {
    const { transport, serviceEvents } = createTransportWithSinks();

    transport.connect();
    openConnection();

    // Send heartbeat with our session + connectionId 'conn-1'
    sendInbound({
      type: 'system',
      event: 'sessions.heartbeat',
      data: {
        connectionId: 'conn-1',
        sessions: [
          {
            id: KILO_SESSION_ID,
            status: 'active',
            title: 'My Session',
            connectionId: 'conn-1',
          },
        ],
      },
    });

    // Send cli.disconnected with matching connectionId
    sendInbound({
      type: 'system',
      event: 'cli.disconnected',
      data: { connectionId: 'conn-1' },
    });

    expect(serviceEvents.filter(e => e.type === 'stopped')).toHaveLength(1);
    expect(serviceEvents.at(-1)).toEqual({
      type: 'stopped',
      reason: 'disconnected',
    });

    transport.destroy();
  });

  it('does not fire stopped when disconnected connectionId differs from owner', () => {
    const { transport, serviceEvents } = createTransportWithSinks();

    transport.connect();
    openConnection();

    // Send heartbeat with our session + connectionId 'conn-1'
    sendInbound({
      type: 'system',
      event: 'sessions.heartbeat',
      data: {
        connectionId: 'conn-1',
        sessions: [
          {
            id: KILO_SESSION_ID,
            status: 'active',
            title: 'My Session',
            connectionId: 'conn-1',
          },
        ],
      },
    });

    // Send cli.disconnected with different connectionId
    sendInbound({
      type: 'system',
      event: 'cli.disconnected',
      data: { connectionId: 'conn-OTHER' },
    });

    expect(serviceEvents.filter(e => e.type === 'stopped')).toHaveLength(0);

    transport.destroy();
  });

  it('fires stopped when no ownerConnectionId tracked yet (safe default)', () => {
    const { transport, serviceEvents } = createTransportWithSinks();

    transport.connect();
    openConnection();

    // Send cli.disconnected without any prior heartbeat (ownerConnectionId is null)
    sendInbound({
      type: 'system',
      event: 'cli.disconnected',
      data: { connectionId: 'conn-X' },
    });

    expect(serviceEvents.filter(e => e.type === 'stopped')).toHaveLength(1);

    transport.destroy();
  });

  it('ownerConnectionId resets on reconnect', () => {
    jest.useFakeTimers();
    try {
      const { transport, serviceEvents } = createTransportWithSinks();

      transport.connect();
      openConnection();

      // Send heartbeat with our session + connectionId 'conn-1'
      sendInbound({
        type: 'system',
        event: 'sessions.heartbeat',
        data: {
          connectionId: 'conn-1',
          sessions: [
            {
              id: KILO_SESSION_ID,
              status: 'active',
              title: 'My Session',
              connectionId: 'conn-1',
            },
          ],
        },
      });

      // Simulate unexpected close → triggers reconnect
      mockWs.onclose?.({ code: 1006 } as CloseEvent);

      // Advance past backoff delay
      jest.advanceTimersByTime(60_000);

      // Get reference to the new WebSocket
      const newMockWs = webSocketConstructor.mock.results.at(-1)?.value as MockWebSocket;
      newMockWs.onopen?.({} as Event);

      // Send cli.disconnected with a different connectionId
      // Since ownerConnectionId was reset to null on reconnect, this should fire stopped
      newMockWs.onmessage?.({
        data: JSON.stringify({
          type: 'system',
          event: 'cli.disconnected',
          data: { connectionId: 'conn-OTHER' },
        }),
      } as MessageEvent);

      expect(serviceEvents.filter(e => e.type === 'stopped')).toHaveLength(1);

      transport.destroy();
    } finally {
      jest.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// onError callback
// ---------------------------------------------------------------------------

describe('CliLiveTransport onError callback', () => {
  it('calls onError when auth token fetch fails synchronously', () => {
    const onError = jest.fn();
    const getAuthToken = jest.fn(() => {
      throw new Error('sync token error');
    });

    const { transport } = createTransportWithSinks({ getAuthToken, onError });

    transport.connect();

    expect(onError).toHaveBeenCalledWith('Failed to get auth token');
  });

  it('calls onError when auth token fetch fails asynchronously', async () => {
    const onError = jest.fn();
    const getAuthToken = jest.fn(() => Promise.reject(new Error('async token error')));

    const { transport } = createTransportWithSinks({ getAuthToken, onError });

    transport.connect();

    // Wait for the rejected promise to settle
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith('Failed to get auth token');
  });

  it('calls onError when snapshot fetch fails', async () => {
    const onError = jest.fn();
    const fetchSnapshot = jest.fn(() => Promise.reject(new Error('snapshot fetch failed')));

    const { transport } = createTransportWithSinks({ fetchSnapshot, onError });

    transport.connect();

    // Wait for snapshot promise to settle
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith('snapshot fetch failed');
  });
});

// ---------------------------------------------------------------------------
// Snapshot refetch on reconnect
// ---------------------------------------------------------------------------

describe('CliLiveTransport snapshot refetch on reconnect', () => {
  const validInboundMessage = {
    type: 'event',
    sessionId: KILO_SESSION_ID,
    event: 'session.status',
    data: { sessionID: KILO_SESSION_ID, status: { type: 'busy' } },
  };

  function triggerReconnect(ws: MockWebSocket): void {
    ws.onclose?.({ code: 1006 } as CloseEvent);
    jest.advanceTimersByTime(60_000);
  }

  function getLatestMockWs(): MockWebSocket {
    return webSocketConstructor.mock.results.at(-1)?.value as MockWebSocket;
  }

  function sendInboundOn(ws: MockWebSocket, msg: Record<string, unknown>): void {
    ws.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent);
  }

  it('refetches snapshot on reconnect and replays into sinks', async () => {
    jest.useFakeTimers();
    try {
      const snapshot: SessionSnapshot = makeSnapshot({ id: KILO_SESSION_ID }, [
        {
          info: stubUserMessage({ id: 'msg-1', sessionID: KILO_SESSION_ID }),
          parts: [stubTextPart({ id: 'part-1', sessionID: KILO_SESSION_ID, messageID: 'msg-1' })],
        },
      ]);

      const fetchSnapshot = jest.fn(() => Promise.resolve(snapshot));
      const { transport, chatEvents, serviceEvents } = createTransportWithSinks({ fetchSnapshot });

      transport.connect();

      // Wait for initial snapshot fetch to resolve
      await jest.advanceTimersByTimeAsync(0);

      // Open WS and mark connection as established with a valid message
      openConnection();
      sendInbound(validInboundMessage);

      // Record event counts after initial snapshot + establishment message
      const chatCountAfterInit = chatEvents.length;
      const serviceCountAfterInit = serviceEvents.length;

      // Trigger reconnect: close with non-auth code, advance past backoff
      triggerReconnect(mockWs);

      // Open new WS and send valid message to trigger onReconnected
      const newMockWs = getLatestMockWs();
      newMockWs.onopen?.({} as Event);
      sendInboundOn(newMockWs, validInboundMessage);

      // Flush promises for the async snapshot refetch
      await jest.advanceTimersByTimeAsync(0);

      expect(fetchSnapshot).toHaveBeenCalledTimes(2);
      expect(fetchSnapshot).toHaveBeenCalledWith(KILO_SESSION_ID);

      // Snapshot replay adds: 1 session.created + 1 message.updated + 1 message.part.updated
      // The valid inbound message also adds 1 session.status service event
      expect(serviceEvents.length).toBeGreaterThan(serviceCountAfterInit);
      expect(chatEvents.length).toBeGreaterThan(chatCountAfterInit);

      // Verify the replayed snapshot events are present
      const sessionCreatedEvents = serviceEvents.filter(e => e.type === 'session.created');
      expect(sessionCreatedEvents).toHaveLength(2); // initial + reconnect

      const messageUpdatedEvents = chatEvents.filter(e => e.type === 'message.updated');
      expect(messageUpdatedEvents).toHaveLength(2); // initial + reconnect

      const partUpdatedEvents = chatEvents.filter(e => e.type === 'message.part.updated');
      expect(partUpdatedEvents).toHaveLength(2); // initial + reconnect

      transport.destroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('reconnect works without fetchSnapshot configured (no replay)', async () => {
    jest.useFakeTimers();
    try {
      const { transport, serviceEvents } = createTransportWithSinks();

      transport.connect();
      openConnection();
      sendInbound(validInboundMessage);

      const serviceCountAfterInit = serviceEvents.length;

      triggerReconnect(mockWs);

      const newMockWs = getLatestMockWs();
      newMockWs.onopen?.({} as Event);
      sendInboundOn(newMockWs, validInboundMessage);

      await jest.advanceTimersByTimeAsync(0);

      // No snapshot replay, but the valid inbound message on the new WS still routes
      const sessionStatusEvents = serviceEvents.filter(e => e.type === 'session.status');
      expect(sessionStatusEvents.length).toBeGreaterThan(0);

      // No session.created events (no snapshot)
      const sessionCreatedEvents = serviceEvents.filter(e => e.type === 'session.created');
      expect(sessionCreatedEvents).toHaveLength(0);

      // Verify no errors — service events grew from the reconnected inbound message
      expect(serviceEvents.length).toBeGreaterThan(serviceCountAfterInit);

      transport.destroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('snapshot fetch failure on reconnect is non-fatal', async () => {
    jest.useFakeTimers();
    try {
      let callCount = 0;
      const snapshot: SessionSnapshot = makeSnapshot({ id: KILO_SESSION_ID });
      const fetchSnapshot = jest.fn(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve(snapshot);
        return Promise.reject(new Error('network error'));
      });
      const onError = jest.fn();

      const { transport, serviceEvents } = createTransportWithSinks({ fetchSnapshot, onError });

      transport.connect();
      await jest.advanceTimersByTimeAsync(0);

      openConnection();
      sendInbound(validInboundMessage);

      // Trigger reconnect
      triggerReconnect(mockWs);

      const newMockWs = getLatestMockWs();
      newMockWs.onopen?.({} as Event);
      sendInboundOn(newMockWs, validInboundMessage);

      // Flush promises — snapshot refetch rejects
      await jest.advanceTimersByTimeAsync(0);

      expect(fetchSnapshot).toHaveBeenCalledTimes(2);

      // No error propagated to onError (reconnect snapshot failure is silently swallowed)
      expect(onError).not.toHaveBeenCalled();

      // Transport still works — send another event on the new WS
      sendInboundOn(newMockWs, {
        type: 'event',
        sessionId: KILO_SESSION_ID,
        event: 'session.status',
        data: { sessionID: KILO_SESSION_ID, status: { type: 'idle' } },
      });

      const statusEvents = serviceEvents.filter(e => e.type === 'session.status');
      expect(statusEvents.length).toBeGreaterThanOrEqual(2);

      transport.destroy();
    } finally {
      jest.useRealTimers();
    }
  });
});
