/**
 * Tests for CloudAgentTransport — verifies event normalization, routing to
 * chat/service sinks, and lifecycle generation tracking.
 */
import type { CloudAgentEvent } from '@/lib/cloud-agent-next/event-types';
import { createEventHelpers } from './__fixtures__/helpers';
import type { ChatEvent, ServiceEvent } from './normalizer';
import { createCloudAgentTransport } from './cloud-agent-transport';
import { kiloId, cloudAgentId, makeSnapshot } from './test-helpers';

// ---------------------------------------------------------------------------
// WebSocket mock
// ---------------------------------------------------------------------------

type MockWebSocket = {
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  close: jest.Mock;
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
    readyState: 1,
  };

  webSocketConstructor = jest.fn(() => mockWs);

  // @ts-expect-error -- minimal WebSocket mock for testing
  global.WebSocket = webSocketConstructor;
});

afterEach(() => {
  // @ts-expect-error -- cleanup global mock
  delete global.WebSocket;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flush microtask queue so Promise.all + .then in connect() settles. */
async function flushPromises(): Promise<void> {
  await new Promise(r => setTimeout(r, 0));
}

const emptySnapshot = makeSnapshot({ id: 'ses-1' });

function sendRaw(event: CloudAgentEvent): void {
  mockWs.onmessage?.({ data: JSON.stringify(event) } as MessageEvent);
}

function createMockApi() {
  return {
    send: jest.fn(() => Promise.resolve('sent')),
    interrupt: jest.fn(() => Promise.resolve('interrupted')),
    answer: jest.fn(() => Promise.resolve('answered')),
    reject: jest.fn(() => Promise.resolve('rejected')),
    respondToPermission: jest.fn(() => Promise.resolve('responded')),
  };
}

function createTransportWithSinks(
  getTicket: (sessionId: string) => string | Promise<string> = () => 'test-ticket',
  onError?: (message: string) => void,
  api = createMockApi()
) {
  const chatEvents: ChatEvent[] = [];
  const serviceEvents: ServiceEvent[] = [];

  const factory = createCloudAgentTransport({
    sessionId: cloudAgentId('ses-1'),
    kiloSessionId: kiloId('ses-1'),
    api,
    getTicket,
    fetchSnapshot: () => Promise.resolve(emptySnapshot),
    websocketBaseUrl: 'ws://localhost:9999',
    onError,
  });

  const transport = factory({
    onChatEvent: event => chatEvents.push(event),
    onServiceEvent: event => serviceEvents.push(event),
  });

  return { transport, chatEvents, serviceEvents, api };
}

const { createEvent, kilocode, resetCounter } = createEventHelpers();

beforeEach(() => {
  resetCounter();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CloudAgentTransport event routing', () => {
  it('routes chat events to onChatEvent', async () => {
    const { transport, chatEvents, serviceEvents } = createTransportWithSinks();

    transport.connect();
    await flushPromises();
    sendRaw(
      kilocode('message.updated', {
        info: { id: 'msg-1', sessionID: 'ses-1', role: 'assistant', time: { created: 1 } },
      })
    );

    expect(chatEvents).toHaveLength(1);
    expect(chatEvents[0]).toEqual(expect.objectContaining({ type: 'message.updated' }));
    // session.created from snapshot replay
    expect(serviceEvents).toHaveLength(1);
    expect(serviceEvents[0]).toEqual(expect.objectContaining({ type: 'session.created' }));

    transport.destroy();
  });

  it('routes service events to onServiceEvent', async () => {
    const { transport, chatEvents, serviceEvents } = createTransportWithSinks();

    transport.connect();
    await flushPromises();
    sendRaw(kilocode('session.status', { sessionID: 'ses-1', status: { type: 'busy' } }));

    // session.created from snapshot replay + session.status from sendRaw
    expect(serviceEvents).toHaveLength(2);
    expect(serviceEvents[0]).toEqual(expect.objectContaining({ type: 'session.created' }));
    expect(serviceEvents[1]).toEqual(expect.objectContaining({ type: 'session.status' }));
    expect(chatEvents).toHaveLength(0);

    transport.destroy();
  });

  it('routes mixed events to correct sinks', async () => {
    const { transport, chatEvents, serviceEvents } = createTransportWithSinks();

    transport.connect();
    await flushPromises();

    // Chat event
    sendRaw(
      kilocode('message.updated', {
        info: { id: 'msg-1', sessionID: 'ses-1', role: 'assistant', time: { created: 1 } },
      })
    );

    // Service event
    sendRaw(kilocode('session.status', { sessionID: 'ses-1', status: { type: 'busy' } }));

    // Chat event (delta)
    sendRaw(
      kilocode('message.part.delta', {
        sessionID: 'ses-1',
        messageID: 'msg-1',
        partID: 'part-1',
        field: 'text',
        delta: 'hello',
      })
    );

    expect(chatEvents).toHaveLength(2);
    expect(chatEvents[0]).toEqual(expect.objectContaining({ type: 'message.updated' }));
    expect(chatEvents[1]).toEqual(expect.objectContaining({ type: 'message.part.delta' }));

    // session.created from snapshot replay + session.status from sendRaw
    expect(serviceEvents).toHaveLength(2);
    expect(serviceEvents[0]).toEqual(expect.objectContaining({ type: 'session.created' }));
    expect(serviceEvents[1]).toEqual(expect.objectContaining({ type: 'session.status' }));

    transport.destroy();
  });

  it('ignores invalid events', () => {
    const { transport, chatEvents, serviceEvents } = createTransportWithSinks();

    transport.connect();
    mockWs.onmessage?.({ data: 'not json at all' } as MessageEvent);

    expect(chatEvents).toHaveLength(0);
    expect(serviceEvents).toHaveLength(0);

    transport.destroy();
  });

  it('drops suggestion events since cloud-agent has no accept/dismiss command path', async () => {
    const { transport, chatEvents, serviceEvents } = createTransportWithSinks();

    transport.connect();
    await flushPromises();

    const serviceCountBefore = serviceEvents.length;

    sendRaw(
      kilocode('suggestion.shown', {
        id: 'sug-1',
        text: 'review your changes',
        actions: [{ label: 'review', prompt: '/review' }],
      })
    );
    sendRaw(kilocode('suggestion.accepted', { requestID: 'sug-1', index: 0 }));
    sendRaw(kilocode('suggestion.dismissed', { requestID: 'sug-1' }));

    expect(serviceEvents).toHaveLength(serviceCountBefore);
    expect(chatEvents).toHaveLength(0);

    transport.destroy();
  });
});

describe('CloudAgentTransport unexpected disconnect', () => {
  it('synthesizes stopped event on unexpected disconnect', async () => {
    const { transport, serviceEvents } = createTransportWithSinks();

    transport.connect();
    await flushPromises();
    sendRaw(kilocode('session.status', { sessionID: 'ses-1', status: { type: 'busy' } }));

    // Non-auth close triggers onUnexpectedDisconnect in connection.ts
    mockWs.onclose?.({ code: 1011, reason: 'network dropped', wasClean: false } as CloseEvent);

    const stoppedEvents = serviceEvents.filter(e => e.type === 'stopped');
    expect(stoppedEvents).toHaveLength(1);
    expect(stoppedEvents[0]).toEqual({ type: 'stopped', reason: 'disconnected' });

    transport.destroy();
  });

  it('suppresses synthetic stopped if already received via event pipeline', () => {
    const { transport, serviceEvents } = createTransportWithSinks();

    transport.connect();
    sendRaw(kilocode('session.status', { sessionID: 'ses-1', status: { type: 'busy' } }));

    // complete → stopped(complete) through normal pipeline
    sendRaw(createEvent('complete', { currentBranch: 'main' }));

    const stoppedBefore = serviceEvents.filter(e => e.type === 'stopped').length;

    // Now close unexpectedly — should NOT generate another stopped
    mockWs.onclose?.({ code: 1011, reason: 'network dropped', wasClean: false } as CloseEvent);

    const stoppedAfter = serviceEvents.filter(e => e.type === 'stopped').length;
    expect(stoppedAfter).toBe(stoppedBefore);

    transport.destroy();
  });
});

describe('CloudAgentTransport ticket handling', () => {
  it('calls getTicket with sessionId', () => {
    const getTicket = jest.fn((_sessionId: string) => 'ticket-abc');
    const { transport } = createTransportWithSinks(getTicket);

    transport.connect();

    expect(getTicket).toHaveBeenCalledWith('ses-1');

    transport.destroy();
  });

  it('handles async getTicket', async () => {
    const getTicket = jest.fn((_sessionId: string) => Promise.resolve('async-ticket'));
    const { transport, serviceEvents } = createTransportWithSinks(getTicket);

    transport.connect();
    await flushPromises();

    // WebSocket was constructed (ticket resolved)
    expect(webSocketConstructor).toHaveBeenCalled();

    // Events still route correctly (session.created from replay + session.status from sendRaw)
    sendRaw(kilocode('session.status', { sessionID: 'ses-1', status: { type: 'busy' } }));
    expect(serviceEvents).toHaveLength(2);

    transport.destroy();
  });

  it('refreshes an expiring ticket before opening the websocket', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const getTicket = jest
      .fn()
      .mockResolvedValueOnce({
        ticket: 'expiring-ticket',
        expiresAt: nowSeconds + 5,
      })
      .mockResolvedValueOnce({
        ticket: 'fresh-ticket',
        expiresAt: nowSeconds + 60,
      });
    const { transport } = createTransportWithSinks(getTicket);

    transport.connect();
    await flushPromises();
    await Promise.resolve();
    await Promise.resolve();

    expect(getTicket).toHaveBeenCalledTimes(2);
    expect(webSocketConstructor).toHaveBeenCalledTimes(1);
    expect(webSocketConstructor.mock.calls[0]?.[0]).toContain('ticket=fresh-ticket');

    transport.destroy();
  });
});

describe('CloudAgentTransport lifecycle', () => {
  it('disconnect() closes connection', async () => {
    const { transport } = createTransportWithSinks();

    transport.connect();
    await flushPromises();
    transport.disconnect();

    expect(mockWs.close).toHaveBeenCalled();
  });

  it('destroy() closes connection', async () => {
    const { transport } = createTransportWithSinks();

    transport.connect();
    await flushPromises();
    transport.destroy();

    expect(mockWs.close).toHaveBeenCalled();
  });

  it('stale generation after disconnect prevents connection creation', async () => {
    const resolveTicket: { resolve?: (value: string) => void } = {};
    const getTicket = jest.fn(
      () =>
        new Promise<string>(resolve => {
          resolveTicket.resolve = resolve;
        })
    );
    const { transport } = createTransportWithSinks(getTicket);

    transport.connect();

    // disconnect before ticket resolves — bumps generation
    transport.disconnect();

    // Now resolve the ticket — should be stale
    resolveTicket.resolve?.('late-ticket');
    await flushPromises();

    // Only the first WebSocket (from disconnect closing) should exist;
    // no new WebSocket created from the stale ticket resolution
    const constructorCallsAfterDisconnect = webSocketConstructor.mock.calls.length;

    // The initial connect() didn't create a WS (ticket was async and unresolved),
    // so no WS should have been constructed at all.
    expect(constructorCallsAfterDisconnect).toBe(0);
  });
});

describe('CloudAgentTransport command delegation', () => {
  it('send() delegates to api.send with bound sessionId', () => {
    const api = createMockApi();
    const { transport } = createTransportWithSinks(undefined, undefined, api);

    void transport.send!({ prompt: 'hello', mode: 'code', model: 'gpt-4' });

    expect(api.send).toHaveBeenCalledWith({
      sessionId: 'ses-1',
      prompt: 'hello',
      mode: 'code',
      model: 'gpt-4',
    });

    transport.destroy();
  });

  it('interrupt() delegates to api.interrupt with bound sessionId', () => {
    const api = createMockApi();
    const { transport } = createTransportWithSinks(undefined, undefined, api);

    void transport.interrupt!();

    expect(api.interrupt).toHaveBeenCalledWith({ sessionId: 'ses-1' });

    transport.destroy();
  });

  it('answer() delegates to api.answer with bound sessionId', () => {
    const api = createMockApi();
    const { transport } = createTransportWithSinks(undefined, undefined, api);

    void transport.answer!({ requestId: 'req-1', answers: [['yes']] });

    expect(api.answer).toHaveBeenCalledWith({
      sessionId: 'ses-1',
      requestId: 'req-1',
      answers: [['yes']],
    });

    transport.destroy();
  });

  it('reject() delegates to api.reject with bound sessionId', () => {
    const api = createMockApi();
    const { transport } = createTransportWithSinks(undefined, undefined, api);

    void transport.reject!({ requestId: 'req-2' });

    expect(api.reject).toHaveBeenCalledWith({
      sessionId: 'ses-1',
      requestId: 'req-2',
    });

    transport.destroy();
  });

  it('respondToPermission() delegates to api.respondToPermission with bound sessionId', () => {
    const api = createMockApi();
    const { transport } = createTransportWithSinks(undefined, undefined, api);

    void transport.respondToPermission!({ requestId: 'req-3', response: 'once' });

    expect(api.respondToPermission).toHaveBeenCalledWith({
      sessionId: 'ses-1',
      requestId: 'req-3',
      response: 'once',
    });

    transport.destroy();
  });
});

// ---------------------------------------------------------------------------
// Snapshot refetch on reconnect
// ---------------------------------------------------------------------------

describe('CloudAgentTransport snapshot refetch on reconnect', () => {
  // Microtask-based flush that works under jest.useFakeTimers()
  // (unlike flushPromises which uses setTimeout and hangs with fake timers)
  async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
  }

  function createTransportWithControllableSnapshot(
    snapshotOverride?: ReturnType<typeof makeSnapshot>
  ) {
    const chatEvents: ChatEvent[] = [];
    const serviceEvents: ServiceEvent[] = [];
    const snapshot = snapshotOverride ?? emptySnapshot;
    const fetchSnapshot = jest.fn(() => Promise.resolve(snapshot));

    const factory = createCloudAgentTransport({
      sessionId: cloudAgentId('ses-1'),
      kiloSessionId: kiloId('ses-1'),
      api: createMockApi(),
      getTicket: () => 'test-ticket',
      fetchSnapshot,
      websocketBaseUrl: 'ws://localhost:9999',
    });

    const transport = factory({
      onChatEvent: event => chatEvents.push(event),
      onServiceEvent: event => serviceEvents.push(event),
    });

    return { transport, chatEvents, serviceEvents, fetchSnapshot };
  }

  function sendRawOn(ws: MockWebSocket, event: CloudAgentEvent): void {
    ws.onmessage?.({ data: JSON.stringify(event) } as MessageEvent);
  }

  /** Establish connection, simulate close + reconnect, return the new WS mock. */
  async function simulateReconnect(): Promise<MockWebSocket> {
    mockWs.onclose?.({ code: 1006, reason: '', wasClean: false } as CloseEvent);

    jest.advanceTimersByTime(2000);
    await flushMicrotasks();

    const newMockWs = webSocketConstructor.mock.results.at(-1)?.value as MockWebSocket;

    newMockWs.onopen?.(new Event('open'));
    sendRawOn(
      newMockWs,
      kilocode('session.status', { sessionID: 'ses-1', status: { type: 'busy' } })
    );

    return newMockWs;
  }

  it('refetches snapshot on reconnect and replays events into sinks', async () => {
    jest.useFakeTimers();
    try {
      const { transport, serviceEvents, fetchSnapshot } = createTransportWithControllableSnapshot();

      transport.connect();
      await flushMicrotasks();

      expect(fetchSnapshot).toHaveBeenCalledTimes(1);

      // Establish connection in base-connection by sending a valid event
      sendRaw(kilocode('session.status', { sessionID: 'ses-1', status: { type: 'busy' } }));

      const serviceCountBefore = serviceEvents.length;

      const newMockWs = await simulateReconnect();
      await flushMicrotasks();

      expect(fetchSnapshot).toHaveBeenCalledTimes(2);

      const replayedCreated = serviceEvents
        .slice(serviceCountBefore)
        .filter(e => e.type === 'session.created');
      expect(replayedCreated).toHaveLength(1);

      transport.destroy();
      newMockWs.onclose?.({ code: 1000, reason: '', wasClean: true } as CloseEvent);
    } finally {
      jest.useRealTimers();
    }
  });

  it('replayed snapshot with messages upserts into sinks correctly', async () => {
    jest.useFakeTimers();
    try {
      const snapshotWithMessages = makeSnapshot({ id: 'ses-1' }, [
        {
          info: {
            id: 'msg-1',
            sessionID: 'ses-1',
            role: 'user',
            time: { created: 1 },
            agent: 'build',
            model: { providerID: 'a', modelID: 'b' },
          },
          parts: [
            {
              id: 'part-1',
              sessionID: 'ses-1',
              messageID: 'msg-1',
              type: 'text',
              text: 'hello',
            },
          ],
        },
      ]);

      const { transport, chatEvents, serviceEvents, fetchSnapshot } =
        createTransportWithControllableSnapshot(snapshotWithMessages);

      transport.connect();
      await flushMicrotasks();

      expect(serviceEvents.filter(e => e.type === 'session.created')).toHaveLength(1);
      expect(chatEvents.filter(e => e.type === 'message.updated')).toHaveLength(1);
      expect(chatEvents.filter(e => e.type === 'message.part.updated')).toHaveLength(1);

      // Establish connection
      sendRaw(kilocode('session.status', { sessionID: 'ses-1', status: { type: 'busy' } }));

      const newMockWs = await simulateReconnect();
      await flushMicrotasks();

      expect(fetchSnapshot).toHaveBeenCalledTimes(2);
      expect(serviceEvents.filter(e => e.type === 'session.created')).toHaveLength(2);
      expect(chatEvents.filter(e => e.type === 'message.updated')).toHaveLength(2);
      expect(chatEvents.filter(e => e.type === 'message.part.updated')).toHaveLength(2);

      transport.destroy();
      newMockWs.onclose?.({ code: 1000, reason: '', wasClean: true } as CloseEvent);
    } finally {
      jest.useRealTimers();
    }
  });

  it('initial connect fetches snapshot once and opens WebSocket', async () => {
    const { transport, serviceEvents, fetchSnapshot } = createTransportWithControllableSnapshot();

    transport.connect();
    await flushPromises();

    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    expect(fetchSnapshot).toHaveBeenCalledWith('ses-1');
    expect(webSocketConstructor).toHaveBeenCalledTimes(1);
    expect(serviceEvents.filter(e => e.type === 'session.created')).toHaveLength(1);

    transport.destroy();
  });
});
