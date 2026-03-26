import { createCloudAgentSession, type CloudAgentSession } from './session';
import type { CloudAgentApi } from './transport';
import { kiloId, cloudAgentId, makeSnapshot } from './test-helpers';

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

function createMockApi(): CloudAgentApi & {
  send: jest.Mock;
  interrupt: jest.Mock;
  answer: jest.Mock;
  reject: jest.Mock;
  respondToPermission: jest.Mock;
} {
  return {
    send: jest.fn(() => Promise.resolve('sent')),
    interrupt: jest.fn(() => Promise.resolve('interrupted')),
    answer: jest.fn(() => Promise.resolve('answered')),
    reject: jest.fn(() => Promise.resolve('rejected')),
    respondToPermission: jest.fn(() => Promise.resolve('responded')),
  };
}

function createCloudAgentResolvedSession(api: CloudAgentApi): CloudAgentSession {
  return createCloudAgentSession({
    kiloSessionId,
    resolveSession: async () => ({
      kiloSessionId,
      cloudAgentSessionId,
      isLive: true,
    }),
    transport: {
      getTicket: () => 'ticket',
      api,
      fetchSnapshot: () => Promise.resolve(makeSnapshot({ id: 'ses_transport-tests' })),
    },
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

describe('session transport delegation (cloud agent)', () => {
  it('session.send() delegates to api.send with resolved cloudAgentSessionId', async () => {
    const api = createMockApi();
    const session = createCloudAgentResolvedSession(api);

    await connectSession(session);
    await session.send({ prompt: 'hello', mode: 'auto' });

    expect(api.send).toHaveBeenCalledTimes(1);
    expect(api.send).toHaveBeenCalledWith({
      sessionId: cloudAgentSessionId,
      prompt: 'hello',
      mode: 'auto',
    });

    session.destroy();
  });

  it('session.interrupt() delegates to api.interrupt with resolved cloudAgentSessionId', async () => {
    const api = createMockApi();
    const session = createCloudAgentResolvedSession(api);

    await connectSession(session);
    await session.interrupt();

    expect(api.interrupt).toHaveBeenCalledTimes(1);
    expect(api.interrupt).toHaveBeenCalledWith({ sessionId: cloudAgentSessionId });

    session.destroy();
  });

  it('session.answer() delegates to api.answer with resolved cloudAgentSessionId', async () => {
    const api = createMockApi();
    const session = createCloudAgentResolvedSession(api);

    await connectSession(session);
    await session.answer({ requestId: 'req-1', answers: [['yes']] });

    expect(api.answer).toHaveBeenCalledTimes(1);
    expect(api.answer).toHaveBeenCalledWith({
      sessionId: cloudAgentSessionId,
      requestId: 'req-1',
      answers: [['yes']],
    });

    session.destroy();
  });

  it('session.reject() delegates to api.reject with resolved cloudAgentSessionId', async () => {
    const api = createMockApi();
    const session = createCloudAgentResolvedSession(api);

    await connectSession(session);
    await session.reject({ requestId: 'req-2' });

    expect(api.reject).toHaveBeenCalledTimes(1);
    expect(api.reject).toHaveBeenCalledWith({
      sessionId: cloudAgentSessionId,
      requestId: 'req-2',
    });

    session.destroy();
  });

  it('session.respondToPermission() delegates to api.respondToPermission', async () => {
    const api = createMockApi();
    const session = createCloudAgentResolvedSession(api);

    await connectSession(session);
    await session.respondToPermission({ requestId: 'req-3', response: 'once' });

    expect(api.respondToPermission).toHaveBeenCalledTimes(1);
    expect(api.respondToPermission).toHaveBeenCalledWith({
      sessionId: cloudAgentSessionId,
      requestId: 'req-3',
      response: 'once',
    });

    session.destroy();
  });
});

describe('commands throw before transport is connected', () => {
  it('session.send() throws if called before connect()', () => {
    const api = createMockApi();
    const session = createCloudAgentResolvedSession(api);

    expect(() => session.send({ prompt: 'hello' })).toThrow(
      'CloudAgentSession transport.send is not configured'
    );

    session.destroy();
  });

  it('session.interrupt() throws if called before connect()', () => {
    const api = createMockApi();
    const session = createCloudAgentResolvedSession(api);

    expect(() => session.interrupt()).toThrow(
      'CloudAgentSession transport.interrupt is not configured'
    );

    session.destroy();
  });
});

describe('session transport missing command methods (historical session)', () => {
  function createHistoricalSession(): CloudAgentSession {
    return createCloudAgentSession({
      kiloSessionId: kiloId('ses_historical'),
      resolveSession: async () => ({
        kiloSessionId: kiloId('ses_historical'),
        cloudAgentSessionId: null,
        isLive: false,
      }),
      transport: {
        fetchSnapshot: () => Promise.resolve(makeSnapshot({ id: 'ses_historical' })),
      },
    });
  }

  async function connectHistorical(session: CloudAgentSession): Promise<void> {
    session.connect();
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
  }

  it('session.send() throws for historical session', async () => {
    const session = createHistoricalSession();
    await connectHistorical(session);

    expect(() => session.send({ prompt: 'hello' })).toThrow(
      'CloudAgentSession transport.send is not configured'
    );

    session.destroy();
  });

  it('session.interrupt() throws for historical session', async () => {
    const session = createHistoricalSession();
    await connectHistorical(session);

    expect(() => session.interrupt()).toThrow(
      'CloudAgentSession transport.interrupt is not configured'
    );

    session.destroy();
  });

  it('session.answer() throws for historical session', async () => {
    const session = createHistoricalSession();
    await connectHistorical(session);

    expect(() => session.answer({ requestId: 'req-3', answers: [[]] })).toThrow(
      'CloudAgentSession transport.answer is not configured'
    );

    session.destroy();
  });

  it('session.reject() throws for historical session', async () => {
    const session = createHistoricalSession();
    await connectHistorical(session);

    expect(() => session.reject({ requestId: 'req-4' })).toThrow(
      'CloudAgentSession transport.reject is not configured'
    );

    session.destroy();
  });
});

describe('CLI live session send via typed transport methods', () => {
  const cliKiloSessionId = kiloId('ses_cli-live-session');

  it('session.send() uses kiloSessionId for CLI live sessions', async () => {
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

    // Now send a message via the typed send method
    const sendPromise = session.send({
      prompt: 'Hello world',
      mode: 'code',
      model: 'test/model-1',
    });

    // The transport wraps this into a WebSocket command
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
  it('canSend is true after connecting a cloud agent session', async () => {
    const api = createMockApi();
    const session = createCloudAgentResolvedSession(api);
    await connectSession(session);
    expect(session.canSend).toBe(true);
    session.destroy();
  });

  it('canSend is false before connect()', () => {
    const api = createMockApi();
    const session = createCloudAgentResolvedSession(api);
    expect(session.canSend).toBe(false);
    session.destroy();
  });

  it('canSend is true after connecting a CLI live session', async () => {
    const session = createCloudAgentSession({
      kiloSessionId: kiloId('ses_cli-live'),
      resolveSession: async () => ({
        kiloSessionId: kiloId('ses_cli-live'),
        cloudAgentSessionId: null,
        isLive: true,
      }),
      transport: {
        cliWebsocketUrl: 'wss://localhost:9999/api/user/web',
        getAuthToken: () => 'test-token',
      },
    });

    session.connect();
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    expect(session.canSend).toBe(true);
    session.destroy();
  });

  it('canSend is false after connecting a historical session', async () => {
    const session = createCloudAgentSession({
      kiloSessionId: kiloId('ses_historical'),
      resolveSession: async () => ({
        kiloSessionId: kiloId('ses_historical'),
        cloudAgentSessionId: null,
        isLive: false,
      }),
      transport: {
        fetchSnapshot: () => Promise.resolve(makeSnapshot({ id: 'ses_historical' })),
      },
    });

    session.connect();
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    expect(session.canSend).toBe(false);
    session.destroy();
  });

  it('canInterrupt is true after connecting a cloud agent session', async () => {
    const api = createMockApi();
    const session = createCloudAgentResolvedSession(api);
    await connectSession(session);
    expect(session.canInterrupt).toBe(true);
    session.destroy();
  });

  it('canInterrupt is false before connect()', () => {
    const api = createMockApi();
    const session = createCloudAgentResolvedSession(api);
    expect(session.canInterrupt).toBe(false);
    session.destroy();
  });

  it('canInterrupt is false for historical sessions', async () => {
    const session = createCloudAgentSession({
      kiloSessionId: kiloId('ses_historical'),
      resolveSession: async () => ({
        kiloSessionId: kiloId('ses_historical'),
        cloudAgentSessionId: null,
        isLive: false,
      }),
      transport: {
        fetchSnapshot: () => Promise.resolve(makeSnapshot({ id: 'ses_historical' })),
      },
    });

    session.connect();
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    expect(session.canInterrupt).toBe(false);
    session.destroy();
  });
});

describe('disconnect during resolution', () => {
  it('disconnect() before resolveSession settles prevents transport from attaching', async () => {
    const api = createMockApi();
    let resolveSession!: (value: {
      kiloSessionId: typeof kiloSessionId;
      cloudAgentSessionId: typeof cloudAgentSessionId;
      isLive: boolean;
    }) => void;
    const resolvePromise = new Promise<{
      kiloSessionId: typeof kiloSessionId;
      cloudAgentSessionId: typeof cloudAgentSessionId;
      isLive: boolean;
    }>(r => {
      resolveSession = r;
    });

    const session = createCloudAgentSession({
      kiloSessionId,
      resolveSession: () => resolvePromise,
      transport: {
        getTicket: () => 'ticket',
        api,
        fetchSnapshot: () => Promise.resolve(makeSnapshot({ id: 'ses_transport-tests' })),
      },
      websocketBaseUrl: 'ws://localhost:9999',
    });

    session.connect();
    // disconnect while resolveSession is still pending
    session.disconnect();

    // Now let the resolution complete
    resolveSession({ kiloSessionId, cloudAgentSessionId, isLive: true });
    await resolvePromise;
    // Flush microtasks so resolveAndConnect can run its post-resolve code
    await new Promise(r => setTimeout(r, 0));

    // No WebSocket should have been created — the stale generation bailed out
    expect(jest.mocked(global.WebSocket).mock.calls.length).toBe(0);
    session.destroy();
  });
});
