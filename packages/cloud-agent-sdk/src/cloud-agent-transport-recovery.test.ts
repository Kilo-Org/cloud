import { createCloudAgentTransport } from './cloud-agent-transport';
import { createServiceState } from './service-state';
import { createEventHelpers } from './__fixtures__/helpers';
import type { ChatEvent, ServiceEvent } from './normalizer';
import type { CloudAgentApi, TransportSendInput } from './transport';
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
  const state = createServiceState({ rootSessionId: 'ses-1' });
  const send = jest.fn<ReturnType<CloudAgentApi['send']>, Parameters<CloudAgentApi['send']>>(
    async () => ({ accepted: true })
  );
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
    api: {
      send,
      interrupt: jest.fn(),
      answer: jest.fn(),
      reject: jest.fn(),
      respondToPermission: jest.fn(),
    },
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
    send,
    getTicket,
    fetchSnapshot,
    chatEvents,
    serviceEvents,
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

  it('coalesces accepted sends while renewing the stream ticket and keeps retries bounded', async () => {
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
});
