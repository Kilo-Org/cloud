import { createStore } from 'jotai';
import { assistantMsg, toolPart } from './__fixtures__/helpers';
import { createSessionManager } from './session-manager';
import { createCloudAgentSession, REMOTE_SESSION_CREATION_NOT_SUPPORTED } from './session';
import type { CloudAgentSession } from './session';
import type { CloudAgentApi } from './transport';
import type { KiloSessionId } from './types';
import type { UserWebSystemEvent } from './user-web-connection';
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
      type: 'cloud-agent' as const,
      kiloSessionId,
      cloudAgentSessionId,
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

function createUserWebConnection() {
  let systemListener: ((event: UserWebSystemEvent) => void) | undefined;
  return {
    retain: jest.fn(() => jest.fn()),
    connect: jest.fn(),
    disconnect: jest.fn(),
    destroy: jest.fn(),
    isConnected: jest.fn(() => false),
    onConnectionChange: jest.fn(() => jest.fn()),
    isReconnectExhausted: jest.fn(() => false),
    onReconnectExhaustionChange: jest.fn(() => jest.fn()),
    retryConnection: jest.fn(),
    subscribeToCliSession: jest.fn(() => jest.fn()),
    sendCommand: jest.fn((_sessionId: string, command: string) =>
      Promise.resolve(
        command === 'list_models'
          ? { protocolVersion: 1, providers: [], truncated: false }
          : { ok: true }
      )
    ),
    sendCommandToConnection: jest.fn(),
    onCliEvent: jest.fn(() => jest.fn()),
    onSystemEvent: jest.fn((listener: (event: UserWebSystemEvent) => void) => {
      systemListener = listener;
      return jest.fn();
    }),
    onReconnect: jest.fn(() => jest.fn()),
    onSessionEvent: jest.fn(() => jest.fn()),
    emitSystem(event: UserWebSystemEvent) {
      systemListener?.(event);
    },
  };
}

function emitSessionsListOwner(
  connection: ReturnType<typeof createUserWebConnection>,
  sessionId: KiloSessionId
): void {
  connection.emitSystem({
    event: 'sessions.list',
    data: {
      sessions: [{ id: sessionId, status: 'active', title: 'Remote', connectionId: 'owner' }],
    },
  });
}

function emitHeartbeatOwner(
  connection: ReturnType<typeof createUserWebConnection>,
  sessionId: KiloSessionId
): void {
  connection.emitSystem({
    event: 'sessions.heartbeat',
    data: {
      connectionId: 'owner',
      sessions: [{ id: sessionId, status: 'active', title: 'Remote' }],
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Cloud Agent worktree refresh event pipeline', () => {
  it.each([false, true])(
    'signals every idle reconnect independently of chat replay (cursor: %p)',
    async withReplayCursor => {
      jest.useFakeTimers();
      const store = createStore();
      const fetchSnapshot = jest.fn(() => Promise.resolve(makeSnapshot({ id: kiloSessionId })));
      const pageshow = {
        handler: undefined as ((event: { persisted: boolean }) => void) | undefined,
      };
      const manager = createSessionManager({
        store,
        resolveSession: async () => ({ type: 'cloud-agent', kiloSessionId, cloudAgentSessionId }),
        getTicket: () => 'ticket',
        fetchSnapshot,
        websocketBaseUrl: 'ws://localhost:9999',
        userWebConnection: createUserWebConnection(),
        api: createMockApi(),
        prepare: jest.fn(),
        initiate: jest.fn(),
        fetchSession: async () => ({
          kiloSessionId,
          cloudAgentSessionId,
          title: null,
          organizationId: null,
          gitUrl: null,
          gitBranch: null,
          mode: null,
          model: null,
          variant: null,
          repository: null,
          isInitiated: true,
          needsLegacyPrepare: false,
          isPreparingAsync: false,
          prompt: null,
          initialMessageId: null,
          associatedPr: null,
        }),
        lifecycleHooks: {
          onPageshow: handler => {
            pageshow.handler = handler;
            return jest.fn();
          },
        },
      });
      const sendEnvelope = (streamEventType: string, data: unknown, eventId = 0) => {
        mockWs.onmessage?.({
          data: JSON.stringify({
            eventId,
            sessionId: cloudAgentSessionId,
            streamEventType,
            timestamp: '2026-09-02T00:00:00.000Z',
            data,
          }),
        } as MessageEvent);
      };
      const listener = jest.fn();
      const unsubscribe = store.sub(manager.atoms.worktreeChangesRefresh, listener);
      try {
        await manager.switchSession(kiloSessionId);
        await jest.advanceTimersByTimeAsync(0);
        expect(store.get(manager.atoms.worktreeChangesRefresh)).toBeNull();
        sendEnvelope('connected', { sessionStatus: { type: 'idle' } });
        expect(store.get(manager.atoms.worktreeChangesRefresh)).toEqual({
          cloudSessionId: cloudAgentSessionId,
          connectionVersion: 1,
        });
        expect(listener).toHaveBeenCalledTimes(1);
        if (withReplayCursor) sendEnvelope('heartbeat', {}, 12);
        fetchSnapshot.mockImplementation(() => new Promise(() => {}));

        for (let reconnect = 1; reconnect <= 2; reconnect++) {
          const previousSignal = store.get(manager.atoms.worktreeChangesRefresh);
          pageshow.handler?.({ persisted: true });
          await jest.advanceTimersByTimeAsync(0);
          expect(store.get(manager.atoms.activity)).toEqual({ type: 'idle' });
          sendEnvelope('connected', { sessionStatus: { type: 'idle' } });
          expect(store.get(manager.atoms.activity)).toEqual({ type: 'idle' });
          expect(store.get(manager.atoms.worktreeChangesRefresh)).toEqual({
            cloudSessionId: cloudAgentSessionId,
            connectionVersion: reconnect + 1,
          });
          expect(store.get(manager.atoms.worktreeChangesRefresh)).not.toBe(previousSignal);
          expect(listener).toHaveBeenCalledTimes(reconnect + 1);
          expect(fetchSnapshot).toHaveBeenCalledTimes(withReplayCursor ? 1 : reconnect + 1);
          const url = String(jest.mocked(global.WebSocket).mock.calls.at(-1)?.[0]);
          expect(url).toContain(withReplayCursor ? 'fromId=12' : 'replay=false');
        }

        sendEnvelope('kilocode', {
          type: 'message.updated',
          properties: { info: assistantMsg('msg-assistant', 'msg-user', kiloSessionId) },
        });
        sendEnvelope('kilocode', {
          type: 'message.part.updated',
          properties: { part: toolPart('part-tool', 'msg-assistant', 'bash', kiloSessionId) },
        });
        sendEnvelope('cloud.message.sent', { messageId: 'msg-user' });
        sendEnvelope('kilocode', {
          type: 'session.status',
          properties: { sessionID: kiloSessionId, status: { type: 'busy' } },
        });
        expect(store.get(manager.atoms.messagesList)).toHaveLength(1);
        expect(store.get(manager.atoms.activity)).toEqual({ type: 'busy' });
        const activity = store.get(manager.atoms.activity);
        const status = store.get(manager.atoms.agentStatus);
        const cloudStatus = store.get(manager.atoms.cloudStatus);
        const messages = store.get(manager.atoms.messagesList);
        const pending = store.get(manager.atoms.pendingMessages);
        for (const revision of [2, 2, 1, 3]) {
          const previousSignal = store.get(manager.atoms.worktreeChangesRefresh);
          sendEnvelope('cloud.worktree.changes.ready', { revision }, 13);
          expect(store.get(manager.atoms.worktreeChangesRefresh)).toEqual({
            cloudSessionId: cloudAgentSessionId,
            revision: Math.max(2, revision),
            connectionVersion: 3,
          });
          if (revision <= (previousSignal?.revision ?? 0)) {
            expect(store.get(manager.atoms.worktreeChangesRefresh)).toBe(previousSignal);
          } else {
            expect(store.get(manager.atoms.worktreeChangesRefresh)).not.toBe(previousSignal);
          }
          expect(store.get(manager.atoms.activity)).toBe(activity);
          expect(store.get(manager.atoms.agentStatus)).toBe(status);
          expect(store.get(manager.atoms.cloudStatus)).toBe(cloudStatus);
          expect(store.get(manager.atoms.messagesList)).toBe(messages);
          expect(store.get(manager.atoms.pendingMessages)).toBe(pending);
        }
        const oldOnMessage = mockWs.onmessage;
        manager.destroy();
        oldOnMessage?.({
          data: JSON.stringify({
            eventId: 14,
            sessionId: cloudAgentSessionId,
            streamEventType: 'cloud.worktree.changes.ready',
            timestamp: '2026-09-02T00:00:00.000Z',
            data: { revision: 4 },
          }),
        } as MessageEvent);
        expect(store.get(manager.atoms.worktreeChangesRefresh)).toBeNull();
      } finally {
        unsubscribe();
        manager.destroy();
        jest.useRealTimers();
      }
    }
  );
});

describe('session transport delegation (cloud agent)', () => {
  it('session.send() delegates to api.send with resolved cloudAgentSessionId', async () => {
    const api = createMockApi();
    const session = createCloudAgentResolvedSession(api);

    await connectSession(session);
    await session.send({
      payload: {
        type: 'prompt',
        prompt: 'hello',
        mode: 'auto',
        model: { providerID: 'kilo', modelID: 'test/model-1' },
      },
    });

    expect(api.send).toHaveBeenCalledTimes(1);
    expect(api.send).toHaveBeenCalledWith({
      sessionId: cloudAgentSessionId,
      payload: { type: 'prompt', prompt: 'hello', mode: 'auto', model: 'test/model-1' },
    });

    session.destroy();
  });

  it('session.send() delegates canonical attachment references', async () => {
    const api = createMockApi();
    const session = createCloudAgentResolvedSession(api);
    const attachments = {
      path: '12345678-1234-4234-9234-123456789abc',
      files: ['87654321-4321-4321-8321-cba987654321.txt'],
    };

    await connectSession(session);
    await session.send({
      payload: {
        type: 'prompt',
        prompt: 'hello',
        mode: 'auto',
        model: { providerID: 'kilo', modelID: 'test/model-1' },
      },
      attachments,
    });

    expect(api.send).toHaveBeenCalledWith({
      sessionId: cloudAgentSessionId,
      payload: { type: 'prompt', prompt: 'hello', mode: 'auto', model: 'test/model-1' },
      attachments,
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

  it('session.createRemoteSession() rejects for cloud-agent sessions', async () => {
    const api = createMockApi();
    const session = createCloudAgentResolvedSession(api);

    await connectSession(session);
    await expect(session.createRemoteSession()).rejects.toThrow(
      REMOTE_SESSION_CREATION_NOT_SUPPORTED
    );

    session.destroy();
  });
});

describe('commands throw before transport is connected', () => {
  it('session.send() throws if called before connect()', () => {
    const api = createMockApi();
    const session = createCloudAgentResolvedSession(api);

    expect(() => session.send({ payload: { type: 'prompt', prompt: 'hello' } })).toThrow(
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

describe('session transport missing command methods (read-only session)', () => {
  function createHistoricalSession(): CloudAgentSession {
    return createCloudAgentSession({
      kiloSessionId: kiloId('ses_historical'),
      resolveSession: async () => ({
        type: 'read-only' as const,
        kiloSessionId: kiloId('ses_historical'),
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

  it('session.send() throws for read-only session', async () => {
    const session = createHistoricalSession();
    await connectHistorical(session);

    expect(() => session.send({ payload: { type: 'prompt', prompt: 'hello' } })).toThrow(
      'CloudAgentSession transport.send is not configured'
    );

    session.destroy();
  });

  it('session.interrupt() throws for read-only session', async () => {
    const session = createHistoricalSession();
    await connectHistorical(session);

    expect(() => session.interrupt()).toThrow(
      'CloudAgentSession transport.interrupt is not configured'
    );

    session.destroy();
  });

  it('session.answer() throws for read-only session', async () => {
    const session = createHistoricalSession();
    await connectHistorical(session);

    expect(() => session.answer({ requestId: 'req-3', answers: [[]] })).toThrow(
      'CloudAgentSession transport.answer is not configured'
    );

    session.destroy();
  });

  it('session.reject() throws for read-only session', async () => {
    const session = createHistoricalSession();
    await connectHistorical(session);

    expect(() => session.reject({ requestId: 'req-4' })).toThrow(
      'CloudAgentSession transport.reject is not configured'
    );

    session.destroy();
  });
});

describe('remote session send via typed transport methods', () => {
  const cliKiloSessionId = kiloId('ses_cli-live-session');

  it('uses the required user web connection without constructing a viewer socket', async () => {
    const userWebConnection = createUserWebConnection();
    const session = createCloudAgentSession({
      kiloSessionId: cliKiloSessionId,
      resolveSession: async () => ({ type: 'remote' as const, kiloSessionId: cliKiloSessionId }),
      transport: { userWebConnection },
    });

    session.connect();
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    emitSessionsListOwner(userWebConnection, cliKiloSessionId);
    await Promise.resolve();

    await session.send({ payload: { type: 'prompt', prompt: 'Hello remote' } });

    expect(userWebConnection.subscribeToCliSession).toHaveBeenCalledWith(cliKiloSessionId);
    expect(userWebConnection.sendCommand).toHaveBeenCalledWith(
      cliKiloSessionId,
      'send_message',
      expect.objectContaining({ sessionID: cliKiloSessionId }),
      'owner'
    );
    expect(jest.mocked(global.WebSocket)).not.toHaveBeenCalled();
    session.destroy();
  });

  it('formats remote sends through userWebConnection using kiloSessionId', async () => {
    const userWebConnection = createUserWebConnection();
    const session = createCloudAgentSession({
      kiloSessionId: cliKiloSessionId,
      resolveSession: async () => ({
        type: 'remote' as const,
        kiloSessionId: cliKiloSessionId,
      }),
      transport: { userWebConnection },
    });

    session.connect();
    await new Promise(r => setTimeout(r, 0));
    emitHeartbeatOwner(userWebConnection, cliKiloSessionId);
    await Promise.resolve();

    await session.send({
      payload: {
        type: 'prompt',
        prompt: 'Hello world',
        mode: 'code',
        model: { providerID: 'kilo', modelID: 'test/model-1' },
      },
    });

    expect(userWebConnection.sendCommand).toHaveBeenCalledWith(
      cliKiloSessionId,
      'send_message',
      {
        sessionID: cliKiloSessionId,
        parts: [{ type: 'text', text: 'Hello world' }],
        agent: 'code',
      },
      'owner'
    );
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

  it('canSend is true after a remote session owner is observed', async () => {
    const cliKiloSessionId = kiloId('ses_cli-live');
    const userWebConnection = createUserWebConnection();
    const session = createCloudAgentSession({
      kiloSessionId: cliKiloSessionId,
      resolveSession: async () => ({
        type: 'remote' as const,
        kiloSessionId: cliKiloSessionId,
      }),
      transport: { userWebConnection },
    });

    session.connect();
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    emitSessionsListOwner(userWebConnection, cliKiloSessionId);

    expect(session.canSend).toBe(true);
    session.destroy();
  });

  it('canSend is false after connecting a read-only session', async () => {
    const session = createCloudAgentSession({
      kiloSessionId: kiloId('ses_historical'),
      resolveSession: async () => ({
        type: 'read-only' as const,
        kiloSessionId: kiloId('ses_historical'),
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

  it('canInterrupt is false for read-only sessions', async () => {
    const session = createCloudAgentSession({
      kiloSessionId: kiloId('ses_historical'),
      resolveSession: async () => ({
        type: 'read-only' as const,
        kiloSessionId: kiloId('ses_historical'),
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

describe('delivery callback plumbing', () => {
  it('forwards onMessageQueued / onMessageCompleted / onMessageFailed through to service state', async () => {
    const onMessageQueued = jest.fn();
    const onMessageCompleted = jest.fn();
    const onMessageFailed = jest.fn();

    const api = createMockApi();
    const session = createCloudAgentSession({
      kiloSessionId,
      resolveSession: async () => ({
        type: 'cloud-agent' as const,
        kiloSessionId,
        cloudAgentSessionId,
      }),
      transport: {
        getTicket: () => 'ticket',
        api,
        fetchSnapshot: () => Promise.resolve(makeSnapshot({ id: 'ses_transport-tests' })),
      },
      websocketBaseUrl: 'ws://localhost:9999',
      onMessageQueued,
      onMessageCompleted,
      onMessageFailed,
    });

    session.state.process({ type: 'cloud.message.queued', messageId: 'm1' });
    expect(onMessageQueued).toHaveBeenCalledWith('m1');

    session.state.process({ type: 'cloud.message.completed', messageId: 'm1' });
    expect(onMessageCompleted).toHaveBeenCalledWith('m1');

    session.state.process({
      type: 'cloud.message.failed',
      messageId: 'm2',
      error: 'boom',
      reason: 'exhausted',
      attempts: 5,
    });
    expect(onMessageFailed).toHaveBeenCalledWith('m2', {
      status: 'failed',
      error: 'boom',
      reason: 'exhausted',
      attempts: 5,
    });

    session.destroy();
  });
});

describe('queued message cancellation replay', () => {
  it('replays cloud.message.queued then cloud.message.canceled to a net-empty transcript', async () => {
    const api = createMockApi();
    const session = createCloudAgentResolvedSession(api);
    await connectSession(session);

    const messageId = 'msg_queued_canceled';
    const deliver = (streamEventType: string, data: unknown) => {
      mockWs.onmessage?.({
        data: JSON.stringify({
          eventId: 1,
          executionId: null,
          sessionId: cloudAgentSessionId,
          streamEventType,
          timestamp: new Date().toISOString(),
          data,
        }),
      } as MessageEvent);
    };

    deliver('cloud.message.queued', { messageId, content: 'hello' });
    expect(session.state.getPendingMessages().has(messageId)).toBe(true);
    expect(session.storage.getMessageIds()).toContain(messageId);

    deliver('cloud.message.canceled', { messageId });
    expect(session.state.getPendingMessages().has(messageId)).toBe(false);
    expect(session.storage.getMessageIds()).not.toContain(messageId);

    session.destroy();
  });
});

describe('disconnect during resolution', () => {
  it('disconnect() before resolveSession settles prevents transport from attaching', async () => {
    const api = createMockApi();
    type CloudAgentResolved = {
      type: 'cloud-agent';
      kiloSessionId: typeof kiloSessionId;
      cloudAgentSessionId: typeof cloudAgentSessionId;
    };
    let resolveSession!: (value: CloudAgentResolved) => void;
    const resolvePromise = new Promise<CloudAgentResolved>(r => {
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
    resolveSession({ type: 'cloud-agent', kiloSessionId, cloudAgentSessionId });
    await resolvePromise;
    // Flush microtasks so resolveAndConnect can run its post-resolve code
    await new Promise(r => setTimeout(r, 0));

    // No WebSocket should have been created — the stale generation bailed out
    expect(jest.mocked(global.WebSocket).mock.calls.length).toBe(0);
    session.destroy();
  });
});
