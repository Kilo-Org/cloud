import {
  createCloudAgentSession,
  type CloudAgentSession,
  type CloudAgentSessionTransport,
} from './session';
import { kiloId, cloudAgentId } from './test-helpers';

// ---------------------------------------------------------------------------
// WebSocket mock — needed because connect() → resolveSession → transport → WS
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
  // @ts-expect-error -- minimal WebSocket mock
  global.WebSocket = jest.fn(() => mockWs);
  (global.WebSocket as unknown as Record<string, number>).OPEN = 1;
});

afterEach(() => {
  // @ts-expect-error -- cleanup
  delete global.WebSocket;
});

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const kiloSessionId = kiloId('ses_transport-tests');
const cloudAgentSessionId = cloudAgentId('agent_12345678-1234-1234-1234-123456789abc');

function createResolvedSession(transport: CloudAgentSessionTransport): CloudAgentSession {
  return createCloudAgentSession({
    kiloSessionId,
    resolveSession: async () => ({
      kiloSessionId,
      cloudAgentSessionId,
      isLive: true,
    }),
    transport,
    websocketBaseUrl: 'ws://localhost:9999',
  });
}

async function connectSession(session: CloudAgentSession): Promise<void> {
  session.connect();
  // Allow resolveAndConnect to resolve + transport to be created
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, 0));
  // Simulate WebSocket open
  mockWs.onopen?.(new Event('open'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('session transport delegation', () => {
  it('session.send() delegates to transport.send with resolved cloudAgentSessionId', async () => {
    const send = jest.fn((_payload: Record<string, unknown>) => Promise.resolve('ok'));
    const session = createResolvedSession({ getTicket: () => 'ticket', send });

    await connectSession(session);
    await Promise.resolve(session.send({ message: 'hello', mode: 'auto' }));

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      sessionId: cloudAgentSessionId,
      message: 'hello',
      mode: 'auto',
    });

    session.destroy();
  });

  it('session.interrupt() delegates to transport.interrupt with resolved cloudAgentSessionId', async () => {
    const interrupt = jest.fn((_payload: { sessionId: string }) => Promise.resolve('ok'));
    const session = createResolvedSession({
      getTicket: () => 'ticket',
      interrupt,
    });

    await connectSession(session);
    await Promise.resolve(session.interrupt());

    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(interrupt).toHaveBeenCalledWith({ sessionId: cloudAgentSessionId });

    session.destroy();
  });

  it('session.answer() delegates to transport.answer with resolved cloudAgentSessionId', async () => {
    const answer = jest.fn(
      (_payload: { sessionId: string; requestId: string; answers: string[][] }) =>
        Promise.resolve('ok')
    );
    const session = createResolvedSession({
      getTicket: () => 'ticket',
      answer,
    });

    await connectSession(session);
    await Promise.resolve(session.answer({ requestId: 'req-1', answers: [['yes']] }));

    expect(answer).toHaveBeenCalledTimes(1);
    expect(answer).toHaveBeenCalledWith({
      sessionId: cloudAgentSessionId,
      requestId: 'req-1',
      answers: [['yes']],
    });

    session.destroy();
  });

  it('session.reject() delegates to transport.reject with resolved cloudAgentSessionId', async () => {
    const reject = jest.fn((_payload: { sessionId: string; requestId: string }) =>
      Promise.resolve('ok')
    );
    const session = createResolvedSession({
      getTicket: () => 'ticket',
      reject,
    });

    await connectSession(session);
    await Promise.resolve(session.reject({ requestId: 'req-2' }));

    expect(reject).toHaveBeenCalledTimes(1);
    expect(reject).toHaveBeenCalledWith({
      sessionId: cloudAgentSessionId,
      requestId: 'req-2',
    });

    session.destroy();
  });

  it('session.respondToPermission() delegates with resolved cloudAgentSessionId', async () => {
    const respondToPermission = jest.fn(
      (_payload: { sessionId: string; requestId: string; response: string }) =>
        Promise.resolve('ok')
    );
    const session = createResolvedSession({
      getTicket: () => 'ticket',
      respondToPermission,
    });

    await connectSession(session);
    await Promise.resolve(session.respondToPermission({ requestId: 'req-3', response: 'once' }));

    expect(respondToPermission).toHaveBeenCalledTimes(1);
    expect(respondToPermission).toHaveBeenCalledWith({
      sessionId: cloudAgentSessionId,
      requestId: 'req-3',
      response: 'once',
    });

    session.destroy();
  });
});

describe('commands throw before session is resolved', () => {
  it('session.send() throws if called before connect()', () => {
    const session = createResolvedSession({
      getTicket: () => 'ticket',
      send: jest.fn(),
    });

    expect(() => session.send({ message: 'hello' })).toThrow('Session not resolved yet');

    session.destroy();
  });

  it('session.interrupt() throws if called before connect()', () => {
    const session = createResolvedSession({
      getTicket: () => 'ticket',
      interrupt: jest.fn(),
    });

    expect(() => session.interrupt()).toThrow('Session not resolved yet');

    session.destroy();
  });
});

describe('session transport missing command methods', () => {
  it('session.send() throws when transport.send is missing', async () => {
    const session = createResolvedSession({ getTicket: () => 'ticket' });
    await connectSession(session);

    expect(() => session.send({ message: 'hello' })).toThrow(
      'CloudAgentSession transport.send is not configured'
    );

    session.destroy();
  });

  it('session.interrupt() throws when transport.interrupt is missing', async () => {
    const session = createResolvedSession({ getTicket: () => 'ticket' });
    await connectSession(session);

    expect(() => session.interrupt()).toThrow(
      'CloudAgentSession transport.interrupt is not configured'
    );

    session.destroy();
  });

  it('session.answer() throws when transport.answer is missing', async () => {
    const session = createResolvedSession({ getTicket: () => 'ticket' });
    await connectSession(session);

    expect(() => session.answer({ requestId: 'req-3', answers: [[]] })).toThrow(
      'CloudAgentSession transport.answer is not configured'
    );

    session.destroy();
  });

  it('session.reject() throws when transport.reject is missing', async () => {
    const session = createResolvedSession({ getTicket: () => 'ticket' });
    await connectSession(session);

    expect(() => session.reject({ requestId: 'req-4' })).toThrow(
      'CloudAgentSession transport.reject is not configured'
    );

    session.destroy();
  });
});

describe('CLI live session send via sendCommand', () => {
  // Simulates the CLI live transport path where cloudAgentSessionId is null.
  // The session should send commands using kiloSessionId, not cloudAgentSessionId.
  const cliKiloSessionId = kiloId('ses_cli-live-session');

  it('session.send() uses kiloSessionId (not cloudAgentSessionId) for sendCommand path', async () => {
    // Create a session that resolves as CLI live (cloudAgentSessionId = null)
    const session = createCloudAgentSession({
      kiloSessionId: cliKiloSessionId,
      resolveSession: async () => ({
        kiloSessionId: cliKiloSessionId,
        cloudAgentSessionId: null,
        isLive: true,
      }),
      transport: {
        cliWebsocketUrl: 'wss://localhost:9999/api/user/web',
        getAuthToken: () => 'test-token',
      },
      websocketBaseUrl: 'ws://localhost:9999',
    });

    session.connect();

    // Allow resolveAndConnect to resolve + transport to be created
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    // Open the WebSocket
    mockWs.onopen?.(new Event('open'));

    // Now send a message. This should use transport.sendCommand with
    // kiloSessionId as the sessionID, NOT throw "Session not resolved yet".
    const sendPromise = session.send({
      prompt: 'Hello world',
      mode: 'code',
      model: 'test/model-1',
    });

    // The sendCommand sends a JSON message over the WebSocket.
    // Verify it was sent with the correct sessionID.
    const lastCall = mockWs.send.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    const sentPayload = JSON.parse(lastCall![0]) as {
      type: string;
      command: string;
      data: {
        sessionID: string;
        parts: unknown[];
        model: string;
        agent: string;
      };
    };
    expect(sentPayload.type).toBe('command');
    expect(sentPayload.command).toBe('send_message');
    expect(sentPayload.data.sessionID).toBe(cliKiloSessionId);
    expect(sentPayload.data.parts).toEqual([{ type: 'text', text: 'Hello world' }]);
    expect(sentPayload.data.model).toBe('test/model-1');
    expect(sentPayload.data.agent).toBe('code');

    // Resolve the pending command so the promise completes
    const cmdId = (JSON.parse(lastCall![0]) as { id: string }).id;
    mockWs.onmessage?.({
      data: JSON.stringify({
        type: 'response',
        id: cmdId,
        result: { ok: true },
      }),
    } as MessageEvent);

    await sendPromise;
    session.destroy();
  });
});

describe('session capabilities', () => {
  it('canSend is true when transport.send is configured', () => {
    const session = createResolvedSession({
      getTicket: () => 'ticket',
      send: jest.fn(),
    });
    expect(session.canSend).toBe(true);
    session.destroy();
  });

  it('canSend is false when transport.send is NOT configured', () => {
    const session = createResolvedSession({ getTicket: () => 'ticket' });
    expect(session.canSend).toBe(false);
    session.destroy();
  });

  it('canInterrupt is true when transport.interrupt is configured', () => {
    const session = createResolvedSession({
      getTicket: () => 'ticket',
      interrupt: jest.fn(),
    });
    expect(session.canInterrupt).toBe(true);
    session.destroy();
  });

  it('canInterrupt is false when transport.interrupt is NOT configured', () => {
    const session = createResolvedSession({ getTicket: () => 'ticket' });
    expect(session.canInterrupt).toBe(false);
    session.destroy();
  });

  it('canSend is false when only getTicket is configured (no send, no sendCommand)', () => {
    const session = createResolvedSession({});
    expect(session.canSend).toBe(false);
    session.destroy();
  });
});
