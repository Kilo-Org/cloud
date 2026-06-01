import type { ChatEvent, ServiceEvent } from './normalizer';
import { createCliLiveTransport } from './cli-live-transport';
import type { UserWebCliEvent, UserWebConnection, UserWebSystemEvent } from './user-web-connection';
import type { KiloSessionId, SessionSnapshot } from './types';
import { kiloId, makeSnapshot, stubTextPart, stubUserMessage } from './test-helpers';

const KILO_SESSION_ID = kiloId('kilo-ses-1');

type FakeUserWebConnection = UserWebConnection & {
  emitCli: (event: UserWebCliEvent) => void;
  emitSystem: (event: UserWebSystemEvent) => void;
  emitReconnect: () => void;
  release: jest.Mock;
};

function createConnection(): FakeUserWebConnection {
  const cliListeners: Array<(event: UserWebCliEvent) => void> = [];
  const systemListeners: Array<(event: UserWebSystemEvent) => void> = [];
  const reconnectListeners: Array<() => void> = [];
  const release = jest.fn();
  return {
    retain: jest.fn(() => jest.fn()),
    connect: jest.fn(),
    disconnect: jest.fn(),
    destroy: jest.fn(),
    subscribeToCliSession: jest.fn(() => release),
    sendCommand: jest.fn(() => Promise.resolve({ ok: true })),
    onCliEvent: jest.fn((_sessionId, listener) => {
      cliListeners.push(listener);
      return jest.fn();
    }),
    onSystemEvent: jest.fn(listener => {
      systemListeners.push(listener);
      return jest.fn();
    }),
    onReconnect: jest.fn(listener => {
      reconnectListeners.push(listener);
      return jest.fn();
    }),
    onSessionEvent: jest.fn(() => jest.fn()),
    emitCli: (event: UserWebCliEvent) => cliListeners.forEach(listener => listener(event)),
    emitSystem: (event: UserWebSystemEvent) => systemListeners.forEach(listener => listener(event)),
    emitReconnect: () => reconnectListeners.forEach(listener => listener()),
    release,
  } as unknown as FakeUserWebConnection;
}

function createTransportWithSinks(opts?: {
  connection?: FakeUserWebConnection;
  fetchSnapshot?: (kiloSessionId: KiloSessionId) => Promise<SessionSnapshot>;
  onError?: (message: string) => void;
}) {
  const userWebConnection = opts?.connection ?? createConnection();
  const chatEvents: ChatEvent[] = [];
  const serviceEvents: ServiceEvent[] = [];
  const transport = createCliLiveTransport({
    kiloSessionId: KILO_SESSION_ID,
    userWebConnection,
    fetchSnapshot: opts?.fetchSnapshot,
    onError: opts?.onError,
  })({
    onChatEvent: event => chatEvents.push(event),
    onServiceEvent: event => serviceEvents.push(event),
  });
  return { userWebConnection, transport, chatEvents, serviceEvents };
}

function emitMessageUpdated(connection: FakeUserWebConnection, sessionId = KILO_SESSION_ID): void {
  connection.emitCli({
    sessionId,
    event: 'message.updated',
    data: {
      info: { id: 'msg-live', sessionID: sessionId, role: 'assistant', time: { created: 1 } },
    },
  });
}

describe('CliLiveTransport unified user web connection', () => {
  it('takes a session subscription lease without starting or destroying the injected connection', () => {
    const { userWebConnection, transport } = createTransportWithSinks();

    transport.connect();
    transport.destroy();
    transport.destroy();

    expect(userWebConnection.connect).not.toHaveBeenCalled();
    expect(userWebConnection.subscribeToCliSession).toHaveBeenCalledWith(KILO_SESSION_ID);
    expect(userWebConnection.release).toHaveBeenCalledTimes(1);
    expect(userWebConnection.destroy).not.toHaveBeenCalled();
  });

  it('routes root and child CLI events while dropping unrelated sessions', () => {
    const { userWebConnection, transport, chatEvents, serviceEvents } = createTransportWithSinks();
    transport.connect();

    emitMessageUpdated(userWebConnection);
    userWebConnection.emitCli({
      sessionId: 'child-session',
      parentSessionId: KILO_SESSION_ID,
      event: 'session.status',
      data: { sessionID: 'child-session', status: { type: 'busy' } },
    });
    emitMessageUpdated(userWebConnection, kiloId('unrelated'));

    expect(chatEvents).toHaveLength(1);
    expect(chatEvents[0]).toEqual(expect.objectContaining({ type: 'message.updated' }));
    expect(serviceEvents).toEqual([expect.objectContaining({ type: 'session.status' })]);
    transport.destroy();
  });

  it('stops only when the known owner disconnects or drops the tracked session', () => {
    const { userWebConnection, transport, serviceEvents } = createTransportWithSinks();
    transport.connect();

    userWebConnection.emitSystem({
      event: 'sessions.list',
      data: {
        sessions: [
          { id: KILO_SESSION_ID, status: 'active', title: 'Tracked', connectionId: 'owner' },
        ],
      },
    });
    userWebConnection.emitSystem({ event: 'cli.disconnected', data: { connectionId: 'other' } });
    expect(serviceEvents).toHaveLength(0);

    userWebConnection.emitSystem({ event: 'cli.disconnected', data: { connectionId: 'owner' } });
    userWebConnection.emitSystem({ event: 'cli.disconnected', data: { connectionId: 'owner' } });
    expect(serviceEvents).toEqual([{ type: 'stopped', reason: 'disconnected' }]);

    userWebConnection.emitSystem({
      event: 'sessions.heartbeat',
      data: {
        connectionId: 'owner',
        sessions: [{ id: KILO_SESSION_ID, status: 'active', title: 'Tracked' }],
      },
    });
    userWebConnection.emitSystem({
      event: 'sessions.heartbeat',
      data: { connectionId: 'owner', sessions: [] },
    });
    expect(serviceEvents.filter(event => event.type === 'stopped')).toHaveLength(2);
    transport.destroy();
  });

  it('buffers chat during initial snapshot replay but does not delay service events', async () => {
    let resolveSnapshot: ((snapshot: SessionSnapshot) => void) | undefined;
    const fetchSnapshot = jest.fn(
      () =>
        new Promise<SessionSnapshot>(resolve => {
          resolveSnapshot = resolve;
        })
    );
    const { userWebConnection, transport, chatEvents, serviceEvents } = createTransportWithSinks({
      fetchSnapshot,
    });
    transport.connect();

    emitMessageUpdated(userWebConnection);
    userWebConnection.emitCli({
      sessionId: KILO_SESSION_ID,
      event: 'session.status',
      data: { sessionID: KILO_SESSION_ID, status: { type: 'busy' } },
    });
    expect(chatEvents).toHaveLength(0);
    expect(serviceEvents).toEqual([expect.objectContaining({ type: 'session.status' })]);

    resolveSnapshot?.(
      makeSnapshot({ id: KILO_SESSION_ID }, [
        {
          info: stubUserMessage({ id: 'msg-snapshot', sessionID: KILO_SESSION_ID }),
          parts: [
            stubTextPart({
              id: 'part-snapshot',
              sessionID: KILO_SESSION_ID,
              messageID: 'msg-snapshot',
              text: 'snapshot',
            }),
          ],
        },
      ])
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(chatEvents.map(event => event.type)).toEqual([
      'message.updated',
      'message.part.updated',
      'message.updated',
    ]);
    transport.destroy();
  });

  it('reports initial snapshot failure, drains buffered chat, and stays subscribed', async () => {
    const onError = jest.fn();
    const { userWebConnection, transport, chatEvents } = createTransportWithSinks({
      fetchSnapshot: () => Promise.reject(new Error('snapshot unavailable')),
      onError,
    });
    transport.connect();
    emitMessageUpdated(userWebConnection);

    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith('snapshot unavailable');
    expect(chatEvents).toHaveLength(1);
    expect(userWebConnection.subscribeToCliSession).toHaveBeenCalledWith(KILO_SESSION_ID);
    transport.destroy();
  });

  it('replays a new snapshot after reconnect and drains pre-reconnect buffered chat on failure', async () => {
    const firstSnapshot = new Promise<SessionSnapshot>(() => {});
    const fetchSnapshot = jest
      .fn()
      .mockReturnValueOnce(firstSnapshot)
      .mockRejectedValueOnce(new Error('replacement unavailable'))
      .mockResolvedValueOnce(makeSnapshot({ id: KILO_SESSION_ID }));
    const onError = jest.fn();
    const { userWebConnection, transport, chatEvents, serviceEvents } = createTransportWithSinks({
      fetchSnapshot,
      onError,
    });
    transport.connect();
    emitMessageUpdated(userWebConnection);

    userWebConnection.emitReconnect();
    await Promise.resolve();
    await Promise.resolve();
    expect(chatEvents).toHaveLength(1);
    expect(onError).not.toHaveBeenCalled();

    userWebConnection.emitReconnect();
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchSnapshot).toHaveBeenCalledTimes(3);
    expect(serviceEvents).toContainEqual(expect.objectContaining({ type: 'session.created' }));
    transport.destroy();
  });

  it.each([
    [
      'send',
      () => ({
        payload: {
          type: 'prompt' as const,
          prompt: 'hello',
          mode: 'code',
          model: 'm',
          variant: 'v',
        },
      }),
      'send_message',
      {
        sessionID: KILO_SESSION_ID,
        parts: [{ type: 'text', text: 'hello' }],
        agent: 'code',
        model: 'm',
        variant: 'v',
      },
    ],
    ['interrupt', () => undefined, 'interrupt', {}],
    [
      'answer',
      () => ({ requestId: 'q-1', answers: [['yes']] }),
      'question_reply',
      { requestID: 'q-1', answers: [['yes']] },
    ],
    ['reject', () => ({ requestId: 'q-2' }), 'question_reject', { requestID: 'q-2' }],
    [
      'respondToPermission',
      () => ({ requestId: 'p-1', response: 'always' }),
      'permission_respond',
      { requestID: 'p-1', reply: 'always' },
    ],
    [
      'acceptSuggestion',
      () => ({ requestId: 's-1', index: 2 }),
      'suggestion_accept',
      { requestID: 's-1', index: 2 },
    ],
    ['dismissSuggestion', () => ({ requestId: 's-2' }), 'suggestion_dismiss', { requestID: 's-2' }],
  ])(
    'delegates %s commands through the injected connection',
    async (method, input, command, data) => {
      const { userWebConnection, transport } = createTransportWithSinks();
      const invoke = transport[method as keyof typeof transport] as (
        value?: unknown
      ) => Promise<unknown>;

      await invoke(input());

      expect(userWebConnection.sendCommand).toHaveBeenCalledWith(KILO_SESSION_ID, command, data);
      transport.destroy();
    }
  );

  it('rejects structured slash commands without sending a viewer command', async () => {
    const { userWebConnection, transport } = createTransportWithSinks();

    await expect(
      transport.send!({ payload: { type: 'command', command: 'review', arguments: '' } })
    ).rejects.toThrow('Slash commands are not supported on the CLI live transport yet');
    expect(userWebConnection.sendCommand).not.toHaveBeenCalled();
    transport.destroy();
  });
});
