import { createCloudAgentTransport } from './cloud-agent-transport';
import { createServiceState } from './service-state';
import { createEventHelpers } from './__fixtures__/helpers';
import type { ChatEvent, ServiceEvent } from './normalizer';
import type { CloudAgentApi, Transport, TransportSendInput } from './transport';
import { cloudAgentId, kiloId, makeSnapshot } from './test-helpers';

type TestSocket = {
  url: string;
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  close: jest.Mock;
};

const sockets: TestSocket[] = [];
const originalWebSocket = globalThis.WebSocket;
const { createEvent, kilocode, resetCounter } = createEventHelpers();
const input = {
  messageId: 'fresh-message',
  payload: {
    type: 'prompt',
    prompt: 'fresh demand',
    mode: 'code',
    model: { providerID: 'kilo', modelID: 'fake-deterministic' },
  },
} satisfies TransportSendInput;

beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(Math, 'random').mockReturnValue(0);
  resetCounter();
  sockets.length = 0;
  const constructor = Object.assign(
    jest.fn((url: string) => {
      const socket: TestSocket = {
        url,
        readyState: 0,
        onopen: null,
        onmessage: null,
        onclose: null,
        close: jest.fn(),
      };
      sockets.push(socket);
      return socket;
    }),
    { OPEN: 1, CLOSED: 3 }
  );
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: constructor });
});

afterEach(() => {
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    value: originalWebSocket,
  });
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function latestSocket(): TestSocket {
  const socket = sockets.at(-1);
  if (!socket) throw new Error('Expected a stream socket');
  return socket;
}

function closeSocket(code = 1006): void {
  const socket = latestSocket();
  socket.readyState = 3;
  socket.onclose?.({ code, reason: '', wasClean: false } as CloseEvent);
}

function receive(event: ReturnType<typeof createEvent>, socket = latestSocket()): void {
  socket.readyState = 1;
  socket.onmessage?.({ data: JSON.stringify(event) } as MessageEvent);
}

function createHarness() {
  const chatEvents: ChatEvent[] = [];
  const serviceEvents: ServiceEvent[] = [];
  const onError = jest.fn();
  const state = createServiceState({ rootSessionId: 'ses-1', onError });
  const send = jest.fn<ReturnType<CloudAgentApi['send']>, Parameters<CloudAgentApi['send']>>(
    async () => ({ accepted: true })
  );
  const api = {
    send,
    interrupt: jest.fn(async () => ({ success: true })),
    cancelQueuedMessage: jest.fn(async () => ({ dropped: true })),
    answer: jest.fn(async () => ({ success: true })),
    reject: jest.fn(async () => ({ success: true })),
    respondToPermission: jest.fn(async () => ({ success: true })),
  } satisfies CloudAgentApi;
  const getTicket = jest.fn(async () => ({
    ticket: 'local-stream-ticket',
    expiresAt: Math.floor(Date.now() / 1000) + 60,
  }));
  const fetchSnapshot = jest.fn(async () => makeSnapshot({ id: 'ses-1' }));
  const transport = createCloudAgentTransport({
    sessionId: cloudAgentId('ses-1'),
    kiloSessionId: kiloId('ses-1'),
    websocketBaseUrl: 'ws://localhost:9999',
    getTicket,
    fetchSnapshot,
    api,
  })({
    onChatEvent: event => chatEvents.push(event),
    onServiceEvent: event => {
      serviceEvents.push(event);
      state.process(event);
    },
  });
  return {
    transport,
    state,
    api,
    send,
    getTicket,
    fetchSnapshot,
    chatEvents,
    serviceEvents,
    onError,
    async submit() {
      if (!transport.send) throw new Error('Expected send support');
      return transport.send(input);
    },
  };
}

async function connect(harness: ReturnType<typeof createHarness>): Promise<void> {
  harness.transport.connect();
  await jest.advanceTimersByTimeAsync(0);
  receive({ ...createEvent('connected', {}), eventId: 7 });
}

type MutationName = 'interrupt' | 'dropQueuedMessage' | 'answer' | 'reject' | 'permission';

async function performMutation(transport: Transport, mutation: MutationName): Promise<unknown> {
  switch (mutation) {
    case 'interrupt':
      return transport.interrupt?.();
    case 'dropQueuedMessage':
      return transport.dropQueuedMessage?.('queued-message');
    case 'answer':
      return transport.answer?.({ requestId: 'question-1', answers: [['yes']] });
    case 'reject':
      return transport.reject?.({ requestId: 'question-1' });
    case 'permission':
      return transport.respondToPermission?.({ requestId: 'permission-1', response: 'once' });
  }
}

async function exhaustRetries(): Promise<void> {
  const startingCount = sockets.length;
  closeSocket();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await jest.advanceTimersByTimeAsync(Math.min(30_000, 1000 * 2 ** attempt) / 2);
    closeSocket();
  }
  expect(sockets).toHaveLength(startingCount + 8);
  await jest.advanceTimersByTimeAsync(600_000);
  expect(sockets).toHaveLength(startingCount + 8);
}

describe('Cloud Agent stream recovery after a backend outage', () => {
  it('reopens an exhausted stream after an accepted send and replays from its cursor', async () => {
    const harness = createHarness();
    await connect(harness);
    const oldSocket = latestSocket();
    await exhaustRetries();
    expect(harness.state.getStatus()).toEqual({ type: 'disconnected' });
    expect(harness.serviceEvents).toContainEqual({
      type: 'stopped',
      reason: 'transport-disconnected',
    });
    const ticketCount = harness.getTicket.mock.calls.length;

    await expect(harness.submit()).resolves.toEqual({ accepted: true });
    await jest.advanceTimersByTimeAsync(0);

    expect(sockets).toHaveLength(10);
    expect(harness.getTicket).toHaveBeenCalledTimes(ticketCount + 1);
    expect(new URL(latestSocket().url).searchParams.get('fromId')).toBe('7');
    expect(harness.fetchSnapshot).toHaveBeenCalledTimes(1);
    expect(harness.send).toHaveBeenCalledTimes(1);
    expect(harness.send).toHaveBeenCalledWith({
      sessionId: 'ses-1',
      messageId: input.messageId,
      payload: {
        type: 'prompt',
        prompt: 'fresh demand',
        mode: 'code',
        model: 'fake-deterministic',
      },
    });

    const reply = {
      ...kilocode('message.part.updated', {
        part: {
          id: 'reply-part',
          messageID: 'reply',
          sessionID: 'ses-1',
          type: 'text',
          text: 'canonical reply',
        },
      }),
      eventId: 8,
    };
    receive(reply, oldSocket);
    receive({ ...reply, sessionId: 'other-session' });
    expect(harness.chatEvents).toEqual([]);
    receive({
      ...createEvent('connected', {
        sessionStatus: { type: 'idle' },
        cloudStatus: { type: 'ready' },
      }),
      eventId: 0,
    });
    expect(harness.state.getStatus()).toEqual({ type: 'idle' });
    receive(reply);
    expect(harness.chatEvents).toEqual([
      expect.objectContaining({
        type: 'message.part.updated',
        part: expect.objectContaining({ text: 'canonical reply', sessionID: 'ses-1' }),
      }),
    ]);
    harness.transport.destroy();
  });

  it.each(['interrupt', 'dropQueuedMessage', 'answer', 'reject', 'permission'] as const)(
    'reopens an exhausted stream after a successful %s mutation',
    async mutation => {
      const harness = createHarness();
      await connect(harness);
      await exhaustRetries();
      const ticketCount = harness.getTicket.mock.calls.length;

      await performMutation(harness.transport, mutation);
      await jest.advanceTimersByTimeAsync(0);

      expect(sockets).toHaveLength(10);
      expect(harness.getTicket).toHaveBeenCalledTimes(ticketCount + 1);
      expect(new URL(latestSocket().url).searchParams.get('fromId')).toBe('7');
      harness.transport.destroy();
    }
  );

  it('reserves one recovery budget when a mutation succeeds before retries exhaust', async () => {
    const harness = createHarness();
    await connect(harness);
    closeSocket();
    for (let attempt = 0; attempt < 7; attempt += 1) {
      await jest.advanceTimersByTimeAsync(Math.min(30_000, 1000 * 2 ** attempt) / 2);
      closeSocket();
    }
    expect(sockets).toHaveLength(8);

    await performMutation(harness.transport, 'interrupt');
    await jest.advanceTimersByTimeAsync(15_000);
    closeSocket();
    await jest.advanceTimersByTimeAsync(0);

    expect(sockets).toHaveLength(10);
    expect(new URL(latestSocket().url).searchParams.get('fromId')).toBe('7');
    receive(createEvent('connected', {}));
    await jest.advanceTimersByTimeAsync(600_000);
    expect(sockets).toHaveLength(10);
    harness.transport.destroy();
  });

  it('recovers established closure and failed handshakes within the existing retry budget', async () => {
    const harness = createHarness();
    await connect(harness);
    closeSocket();
    await jest.advanceTimersByTimeAsync(500);
    closeSocket();
    await jest.advanceTimersByTimeAsync(1000);
    receive(createEvent('connected', {}));
    receive(kilocode('session.status', { sessionID: 'ses-1', status: { type: 'idle' } }));
    expect(harness.serviceEvents.at(-1)).toEqual({
      type: 'session.status',
      sessionId: 'ses-1',
      status: { type: 'idle' },
    });
    expect(sockets).toHaveLength(3);
    expect(harness.send).not.toHaveBeenCalled();
    harness.transport.destroy();
  });

  it.each([403, 404, 503])(
    'does not restart observation when send fails with HTTP %s',
    async status => {
      const harness = createHarness();
      await connect(harness);
      await exhaustRetries();
      const ticketCount = harness.getTicket.mock.calls.length;
      harness.send.mockRejectedValueOnce(new Error(`HTTP ${status}`));
      await expect(harness.submit()).rejects.toThrow(`HTTP ${status}`);
      await jest.advanceTimersByTimeAsync(600_000);
      expect(sockets).toHaveLength(9);
      expect(harness.getTicket).toHaveBeenCalledTimes(ticketCount);
      harness.transport.destroy();
    }
  );

  it.each(['connected', 'retrying'] as const)(
    'does not replace a %s stream after send',
    async state => {
      const harness = createHarness();
      await connect(harness);
      if (state === 'retrying') closeSocket();
      await harness.submit();
      await jest.advanceTimersByTimeAsync(0);
      expect(sockets).toHaveLength(1);
      expect(harness.getTicket).toHaveBeenCalledTimes(1);
      harness.transport.destroy();
    }
  );

  it.each(['disconnect', 'destroy', 'connect'] as const)(
    'fences an accepted send that settles after %s',
    async action => {
      const harness = createHarness();
      await connect(harness);
      await exhaustRetries();
      let resolveSend: (value: unknown) => void = () => {};
      harness.send.mockImplementationOnce(() => new Promise(resolve => (resolveSend = resolve)));
      const pending = harness.submit();
      harness.transport[action]();
      await jest.advanceTimersByTimeAsync(0);
      if (action === 'connect') await exhaustRetries();
      const socketCount = sockets.length;
      const ticketCount = harness.getTicket.mock.calls.length;
      resolveSend({ accepted: true });
      await pending;
      await jest.advanceTimersByTimeAsync(600_000);
      expect(sockets).toHaveLength(socketCount);
      expect(harness.getTicket).toHaveBeenCalledTimes(ticketCount);
      harness.transport.destroy();
    }
  );

  it('does not revive a stream stopped by terminal authentication failure', async () => {
    const harness = createHarness();
    await connect(harness);
    closeSocket(4001);
    await jest.advanceTimersByTimeAsync(0);
    closeSocket(4001);
    const ticketCount = harness.getTicket.mock.calls.length;
    await harness.submit();
    await jest.advanceTimersByTimeAsync(600_000);
    expect(sockets).toHaveLength(2);
    expect(harness.getTicket).toHaveBeenCalledTimes(ticketCount);
    harness.transport.destroy();
  });

  it('coalesces concurrent sends and requires a new mutation after recovery exhausts', async () => {
    const harness = createHarness();
    await connect(harness);
    await exhaustRetries();
    let resolveTicket: (value: { ticket: string; expiresAt: number }) => void = () => {};
    harness.getTicket.mockImplementationOnce(
      () => new Promise(resolve => (resolveTicket = resolve))
    );
    const ticketCount = harness.getTicket.mock.calls.length;
    await Promise.all([harness.submit(), harness.submit()]);
    expect(harness.getTicket).toHaveBeenCalledTimes(ticketCount + 1);
    resolveTicket({ ticket: 'renewed-ticket', expiresAt: Math.floor(Date.now() / 1000) + 60 });
    await jest.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(10);
    expect(new URL(latestSocket().url).searchParams.get('ticket')).toBe('renewed-ticket');
    await exhaustRetries();
    expect(harness.send).toHaveBeenCalledTimes(2);

    const exhaustedSocketCount = sockets.length;
    await harness.submit();
    await jest.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(exhaustedSocketCount + 1);
    expect(harness.send).toHaveBeenCalledTimes(3);
    harness.transport.destroy();
  });

  it.each(['disconnect', 'destroy'] as const)('fences ticket renewal after %s', async action => {
    const harness = createHarness();
    await connect(harness);
    await exhaustRetries();
    let resolveTicket: (value: { ticket: string; expiresAt: number }) => void = () => {};
    harness.getTicket.mockImplementationOnce(
      () => new Promise(resolve => (resolveTicket = resolve))
    );
    await harness.submit();
    harness.transport[action]();
    resolveTicket({ ticket: 'late-ticket', expiresAt: Math.floor(Date.now() / 1000) + 60 });
    await jest.advanceTimersByTimeAsync(600_000);
    expect(sockets).toHaveLength(9);
    harness.transport.destroy();
  });

  it('shows reconnecting on the first close and the transport stop only at exhaustion', async () => {
    const harness = createHarness();
    await connect(harness);

    closeSocket();
    expect(harness.serviceEvents).toContainEqual({ type: 'reconnecting' });
    expect(harness.serviceEvents.filter(e => e.type === 'stopped')).toHaveLength(0);
    expect(harness.state.getActivity()).toEqual({ type: 'reconnecting' });

    await exhaustRetries();

    const stopped = harness.serviceEvents.filter(e => e.type === 'stopped');
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toEqual({ type: 'stopped', reason: 'transport-disconnected' });
    expect(harness.state.getStatus()).toEqual({ type: 'disconnected' });
    harness.transport.destroy();
  });

  it('treats a repeated auth close as terminal without a reconnecting event', async () => {
    const harness = createHarness();
    await connect(harness);

    closeSocket(4001);
    await jest.advanceTimersByTimeAsync(0);
    expect(harness.serviceEvents).not.toContainEqual({ type: 'reconnecting' });
    expect(harness.serviceEvents.filter(e => e.type === 'stopped')).toHaveLength(0);

    closeSocket(4001);
    await jest.advanceTimersByTimeAsync(0);
    const stopped = harness.serviceEvents.filter(e => e.type === 'stopped');
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toEqual({ type: 'stopped', reason: 'transport-disconnected' });
    expect(harness.serviceEvents).not.toContainEqual({ type: 'reconnecting' });

    harness.transport.destroy();
  });

  it('bounds a rejected ticket refresh through the existing retry budget', async () => {
    const harness = createHarness();
    await connect(harness);

    harness.getTicket.mockRejectedValue(new Error('ticket rejected'));

    closeSocket(4001);
    await jest.advanceTimersByTimeAsync(0);
    expect(harness.serviceEvents).toContainEqual({ type: 'reconnecting' });
    expect(harness.serviceEvents.filter(e => e.type === 'stopped')).toHaveLength(0);

    // Each close re-enters the rejected-refresh path; the attempt budget
    // advances until the cap. The delays mirror scheduleReconnect's backoff
    // with Math.random pinned to 0.
    const delays = [500, 1000, 2000, 4000, 8000, 15000, 15000, 15000];
    for (const [index, delay] of delays.entries()) {
      await jest.advanceTimersByTimeAsync(delay);
      closeSocket(4001);
      await jest.advanceTimersByTimeAsync(0);
      if (index < delays.length - 1) {
        expect(harness.serviceEvents.filter(e => e.type === 'stopped')).toHaveLength(0);
      }
    }

    const stopped = harness.serviceEvents.filter(e => e.type === 'stopped');
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toEqual({ type: 'stopped', reason: 'transport-disconnected' });

    const socketsAtExhaustion = sockets.length;
    await jest.advanceTimersByTimeAsync(600_000);
    expect(sockets).toHaveLength(socketsAtExhaustion);

    harness.transport.destroy();
  });

  it('keeps the wrapper terminal through a reconnect and the transport exhaustion', async () => {
    const harness = createHarness();
    await connect(harness);

    receive(createEvent('wrapper_disconnected', {}));
    expect(harness.state.getStatus()).toEqual({ type: 'disconnected' });
    expect(harness.state.getActivity()).toEqual({ type: 'idle' });
    expect(harness.onError).toHaveBeenCalledTimes(1);

    // The wire stop set the per-socket guard, so this close is silent.
    closeSocket();
    expect(harness.serviceEvents.filter(e => e.type === 'reconnecting')).toHaveLength(0);

    await jest.advanceTimersByTimeAsync(600);
    // A non-root-status message on the recovery socket fires onReconnected,
    // which clears the transport guard, without clearing the wrapper terminal.
    receive(createEvent('commands.available', { commands: [] }));

    // Close before a normalized `connected`: the transport now emits
    // reconnecting, but the wrapper terminal outranks the projection.
    closeSocket();
    expect(harness.serviceEvents).toContainEqual({ type: 'reconnecting' });
    expect(harness.state.getStatus()).toEqual({ type: 'disconnected' });
    expect(harness.state.getActivity()).toEqual({ type: 'idle' });

    await exhaustRetries();
    expect(harness.state.getStatus()).toEqual({ type: 'disconnected' });
    expect(harness.onError).toHaveBeenCalledTimes(1);

    harness.transport.destroy();
  });

  it('releases the wrapper terminal on a root busy status replay', async () => {
    const harness = createHarness();
    await connect(harness);

    receive(createEvent('wrapper_disconnected', {}));
    closeSocket();
    await jest.advanceTimersByTimeAsync(600);
    receive(kilocode('session.status', { sessionID: 'ses-1', status: { type: 'busy' } }));
    receive(createEvent('connected', {}));

    expect(harness.state.getStatus()).toEqual({ type: 'idle' });

    closeSocket();
    expect(harness.serviceEvents).toContainEqual({ type: 'reconnecting' });
    expect(harness.state.getActivity()).toEqual({ type: 'reconnecting' });

    await exhaustRetries();
    expect(harness.state.getStatus()).toEqual({ type: 'disconnected' });
    expect(harness.onError).toHaveBeenCalledTimes(2);

    harness.transport.destroy();
  });

  it('does not release the wrapper terminal on a child status replay', async () => {
    const harness = createHarness();
    await connect(harness);

    receive(createEvent('wrapper_disconnected', {}));
    closeSocket();
    await jest.advanceTimersByTimeAsync(600);
    receive(kilocode('session.status', { sessionID: 'child-1', status: { type: 'busy' } }));

    expect(harness.state.getStatus()).toEqual({ type: 'disconnected' });

    closeSocket();
    // The close still emits reconnecting (onReconnected cleared the guard), but
    // the projection preserves the wrapper terminal.
    expect(harness.serviceEvents).toContainEqual({ type: 'reconnecting' });
    expect(harness.state.getStatus()).toEqual({ type: 'disconnected' });
    expect(harness.state.getActivity()).toEqual({ type: 'idle' });

    await exhaustRetries();
    expect(harness.state.getStatus()).toEqual({ type: 'disconnected' });
    expect(harness.onError).toHaveBeenCalledTimes(1);

    harness.transport.destroy();
  });

  it('clears the wrapper terminal and the transport guard when connected arrives', async () => {
    const harness = createHarness();
    await connect(harness);

    closeSocket();
    await jest.advanceTimersByTimeAsync(600);
    receive(createEvent('wrapper_disconnected', {}));

    expect(harness.state.getStatus()).toEqual({ type: 'disconnected' });
    expect(harness.onError).toHaveBeenCalledTimes(1);

    receive({ ...createEvent('connected', { sessionStatus: { type: 'idle' } }), eventId: 0 });
    expect(harness.state.getStatus()).toEqual({ type: 'idle' });

    const reconnectingBefore = harness.serviceEvents.filter(e => e.type === 'reconnecting').length;
    closeSocket();
    expect(harness.serviceEvents.filter(e => e.type === 'reconnecting').length).toBe(
      reconnectingBefore + 1
    );
    expect(harness.state.getStatus()).toEqual({ type: 'idle' });

    await exhaustRetries();
    expect(harness.serviceEvents).toContainEqual({
      type: 'stopped',
      reason: 'transport-disconnected',
    });
    expect(harness.state.getStatus()).toEqual({ type: 'disconnected' });
    // The wrapper stop already called onError once; exhaustion calls it again.
    expect(harness.onError).toHaveBeenCalledTimes(2);

    harness.transport.destroy();
  });

  it('clears the exhaustion guard on the first connected of a recovered socket', async () => {
    const harness = createHarness();
    harness.transport.connect();
    await jest.advanceTimersByTimeAsync(0);

    closeSocket();
    await exhaustRetries();
    expect(harness.state.getStatus()).toEqual({ type: 'disconnected' });

    await harness.submit();
    await jest.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(10);

    receive({ ...createEvent('connected', { sessionStatus: { type: 'idle' } }), eventId: 0 });
    expect(harness.state.getStatus()).toEqual({ type: 'idle' });

    const reconnectingBefore = harness.serviceEvents.filter(e => e.type === 'reconnecting').length;
    closeSocket();
    expect(harness.serviceEvents.filter(e => e.type === 'reconnecting').length).toBe(
      reconnectingBefore + 1
    );

    harness.transport.destroy();
  });

  it('clears the transport guard on a same-socket root idle status', async () => {
    const harness = createHarness();
    await connect(harness);

    receive(createEvent('wrapper_disconnected', {}));
    expect(harness.state.getStatus()).toEqual({ type: 'disconnected' });

    receive(kilocode('session.status', { sessionID: 'ses-1', status: { type: 'idle' } }));
    expect(harness.state.getStatus()).toEqual({ type: 'idle' });

    const reconnectingBefore = harness.serviceEvents.filter(e => e.type === 'reconnecting').length;
    closeSocket();
    expect(harness.serviceEvents.filter(e => e.type === 'reconnecting').length).toBe(
      reconnectingBefore + 1
    );
    expect(harness.state.getStatus()).toEqual({ type: 'idle' });

    harness.transport.destroy();
  });

  it('does not clear the transport guard on a same-socket child idle status', async () => {
    const harness = createHarness();
    await connect(harness);

    receive(createEvent('wrapper_disconnected', {}));
    expect(harness.state.getStatus()).toEqual({ type: 'disconnected' });

    receive(kilocode('session.status', { sessionID: 'child-1', status: { type: 'idle' } }));
    expect(harness.state.getStatus()).toEqual({ type: 'disconnected' });

    const reconnectingBefore = harness.serviceEvents.filter(e => e.type === 'reconnecting').length;
    closeSocket();
    expect(harness.serviceEvents.filter(e => e.type === 'reconnecting')).toHaveLength(
      reconnectingBefore
    );
    expect(harness.state.getStatus()).toEqual({ type: 'disconnected' });

    harness.transport.destroy();
  });
});
