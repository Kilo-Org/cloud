import type { ChatEvent, ServiceEvent } from './normalizer';
import { createCliLiveTransport } from './cli-live-transport';
import type {
  RemoteModelCatalogV1,
  RemoteModelCatalogWireV1,
  RemoteModelState,
} from './remote-model-catalog';
import {
  UserWebCommandError,
  type UserWebCliEvent,
  type UserWebConnection,
  type UserWebSystemEvent,
} from './user-web-connection';
import type { KiloSessionId, SessionSnapshot } from './types';
import { kiloId, makeSnapshot, stubTextPart, stubUserMessage } from './test-helpers';

const KILO_SESSION_ID = kiloId('kilo-ses-1');
const WIRE_CATALOG = {
  all: [
    {
      id: 'anthropic',
      name: 'Anthropic',
      source: 'env',
      env: [],
      options: {},
      models: {
        'claude-sonnet-4': {
          id: 'claude-sonnet-4',
          providerID: 'anthropic',
          api: { id: 'claude-sonnet-4', url: '', npm: '' },
          name: 'Claude Sonnet 4',
          capabilities: {
            temperature: true,
            reasoning: true,
            attachment: true,
            toolcall: true,
            input: { text: true, audio: false, image: true, video: false, pdf: true },
            output: { text: true, audio: false, image: false, video: false, pdf: false },
            interleaved: false,
          },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          limit: { context: 200_000, output: 64_000 },
          status: 'active',
          options: {},
          headers: {},
          release_date: '',
          variants: { high: {} },
        },
      },
    },
  ],
  default: { anthropic: 'claude-sonnet-4' },
  connected: ['anthropic'],
  failed: [],
  protocolVersion: 1,
  currentModel: {
    model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
    variant: 'high',
  },
  defaultModel: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
  truncated: false,
} satisfies RemoteModelCatalogWireV1;
const REMOTE_CATALOG = {
  protocolVersion: 1,
  providers: [
    {
      id: 'anthropic',
      name: 'Anthropic',
      models: [
        {
          id: 'claude-sonnet-4',
          name: 'Claude Sonnet 4',
          variants: ['high'],
          capabilities: { attachment: true, reasoning: true },
          limits: { context: 200_000, output: 64_000 },
        },
      ],
    },
  ],
  currentModel: {
    model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
    variant: 'high',
  },
  defaultModel: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
  truncated: false,
} satisfies RemoteModelCatalogV1;

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
  onRemoteModelStateChange?: (state: RemoteModelState) => void;
  onCapabilityChange?: () => void;
}) {
  const userWebConnection = opts?.connection ?? createConnection();
  const chatEvents: ChatEvent[] = [];
  const serviceEvents: ServiceEvent[] = [];
  let replayCompleteCount = 0;
  const transport = createCliLiveTransport({
    kiloSessionId: KILO_SESSION_ID,
    userWebConnection,
    fetchSnapshot: opts?.fetchSnapshot,
    onError: opts?.onError,
    onRemoteModelStateChange: opts?.onRemoteModelStateChange,
    onCapabilityChange: opts?.onCapabilityChange,
  })({
    onChatEvent: event => chatEvents.push(event),
    onServiceEvent: event => serviceEvents.push(event),
    onReplayComplete: () => {
      replayCompleteCount += 1;
    },
  });
  return {
    userWebConnection,
    transport,
    chatEvents,
    serviceEvents,
    getReplayCompleteCount: () => replayCompleteCount,
  };
}

function emitOwner(connection: FakeUserWebConnection, connectionId = 'owner'): void {
  connection.emitSystem({
    event: 'sessions.list',
    data: {
      sessions: [{ id: KILO_SESSION_ID, status: 'active', title: 'Tracked', connectionId }],
    },
  });
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
  it('discovers and publishes a v1 catalog for the current owner', async () => {
    const connection = createConnection();
    jest
      .mocked(connection.sendCommand)
      .mockImplementation((_sessionId, command) =>
        Promise.resolve(command === 'list_models' ? WIRE_CATALOG : { ok: true })
      );
    const states: RemoteModelState[] = [];
    const { transport } = createTransportWithSinks({
      connection,
      onRemoteModelStateChange: state => states.push(state),
    });

    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();

    expect(connection.sendCommand).toHaveBeenCalledWith(
      KILO_SESSION_ID,
      'list_models',
      { protocolVersion: 1 },
      'owner'
    );
    expect(states.at(-1)).toEqual({
      ownerConnectionId: 'owner',
      protocol: 'v1',
      catalog: REMOTE_CATALOG,
      refresh: 'idle',
    });
    expect(transport.canSend?.()).toBe(true);
    transport.destroy();
  });

  it('classifies any unknown-command error as legacy, but surfaces unrelated errors', async () => {
    const connection = createConnection();
    jest
      .mocked(connection.sendCommand)
      .mockRejectedValueOnce(new Error('unknown command: list_models'));
    const states: RemoteModelState[] = [];
    const { transport } = createTransportWithSinks({
      connection,
      onRemoteModelStateChange: state => states.push(state),
    });

    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();

    expect(states.at(-1)).toEqual({
      ownerConnectionId: 'owner',
      protocol: 'legacy',
      refresh: 'idle',
    });

    // A prefixed/reworded variant of the same "unknown command" text (e.g. a
    // slightly different old-CLI build) should still classify as legacy.
    jest
      .mocked(connection.sendCommand)
      .mockRejectedValueOnce(new Error('prefix: unknown command: list_models'));
    transport.retryRemoteModels?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(states.at(-1)).toEqual({
      ownerConnectionId: 'owner',
      protocol: 'legacy',
      refresh: 'idle',
    });

    // An unrelated failure must still surface as an error, not be swallowed.
    jest.mocked(connection.sendCommand).mockRejectedValueOnce(new Error('network error'));
    transport.retryRemoteModels?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(states.at(-1)).toEqual({
      ownerConnectionId: 'owner',
      protocol: 'legacy',
      refresh: 'error',
      error: 'network error',
    });
    transport.destroy();
  });

  it('keeps protocol unknown and owner send capability after a malformed initial catalog', async () => {
    const connection = createConnection();
    jest.mocked(connection.sendCommand).mockResolvedValueOnce({
      protocolVersion: 1,
      providers: 'invalid',
      truncated: false,
    });
    const states: RemoteModelState[] = [];
    const { transport } = createTransportWithSinks({
      connection,
      onRemoteModelStateChange: state => states.push(state),
    });

    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();

    expect(states.at(-1)).toEqual({
      ownerConnectionId: 'owner',
      protocol: 'unknown',
      refresh: 'error',
      error: 'Invalid remote model catalog',
    });
    expect(states).not.toContainEqual(expect.objectContaining({ protocol: 'legacy' }));
    expect(transport.canSend?.()).toBe(true);
    transport.destroy();
  });

  it('keeps protocol unknown and owner send capability after a transient initial catalog error', async () => {
    const connection = createConnection();
    jest.mocked(connection.sendCommand).mockRejectedValueOnce(new Error('catalog timed out'));
    const states: RemoteModelState[] = [];
    const { transport } = createTransportWithSinks({
      connection,
      onRemoteModelStateChange: state => states.push(state),
    });

    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();

    expect(states.at(-1)).toEqual({
      ownerConnectionId: 'owner',
      protocol: 'unknown',
      refresh: 'error',
      error: 'catalog timed out',
    });
    expect(states).not.toContainEqual(expect.objectContaining({ protocol: 'legacy' }));
    expect(transport.canSend?.()).toBe(true);
    transport.destroy();
  });

  it('ignores a late catalog response from a replaced owner', async () => {
    const connection = createConnection();
    let resolveFirstCatalog: ((catalog: RemoteModelCatalogWireV1) => void) | undefined;
    const firstCatalog = new Promise<RemoteModelCatalogWireV1>(resolve => {
      resolveFirstCatalog = resolve;
    });
    const sourceProvider = WIRE_CATALOG.all[0];
    const sourceModel = sourceProvider.models['claude-sonnet-4'];
    const replacementWireCatalog = {
      ...WIRE_CATALOG,
      all: [
        {
          ...sourceProvider,
          id: 'replacement-provider',
          models: {
            'claude-sonnet-4': { ...sourceModel, providerID: 'replacement-provider' },
          },
        },
      ],
      default: { 'replacement-provider': 'claude-sonnet-4' },
      connected: ['replacement-provider'],
    } satisfies RemoteModelCatalogWireV1;
    const replacementCatalog = {
      ...REMOTE_CATALOG,
      providers: [{ ...REMOTE_CATALOG.providers[0], id: 'replacement-provider' }],
    } satisfies RemoteModelCatalogV1;
    jest
      .mocked(connection.sendCommand)
      .mockReturnValueOnce(firstCatalog)
      .mockResolvedValueOnce(replacementWireCatalog);
    const states: RemoteModelState[] = [];
    const { transport } = createTransportWithSinks({
      connection,
      onRemoteModelStateChange: state => states.push(state),
    });

    transport.connect();
    emitOwner(connection, 'owner-a');
    emitOwner(connection, 'owner-b');
    await Promise.resolve();
    await Promise.resolve();

    resolveFirstCatalog?.(WIRE_CATALOG);
    await Promise.resolve();
    await Promise.resolve();

    expect(states.at(-1)).toEqual({
      ownerConnectionId: 'owner-b',
      protocol: 'v1',
      catalog: replacementCatalog,
      refresh: 'idle',
    });
    expect(states).not.toContainEqual(
      expect.objectContaining({ ownerConnectionId: 'owner-a', catalog: REMOTE_CATALOG })
    );
    transport.destroy();
  });

  it('keeps one catalog request in flight for an owner', async () => {
    const connection = createConnection();
    let resolveCatalog: ((catalog: RemoteModelCatalogWireV1) => void) | undefined;
    jest.mocked(connection.sendCommand).mockReturnValue(
      new Promise(resolve => {
        resolveCatalog = resolve;
      })
    );
    const { transport } = createTransportWithSinks({ connection });

    transport.connect();
    emitOwner(connection);
    transport.retryRemoteModels?.();
    connection.emitReconnect();

    expect(connection.sendCommand).toHaveBeenCalledTimes(1);

    resolveCatalog?.(WIRE_CATALOG);
    await Promise.resolve();
    await Promise.resolve();
    transport.destroy();
  });

  it('retains a v1 catalog when a same-owner reconnect refresh fails', async () => {
    const connection = createConnection();
    jest
      .mocked(connection.sendCommand)
      .mockResolvedValueOnce(WIRE_CATALOG)
      .mockRejectedValueOnce(new Error('catalog refresh timed out'));
    const states: RemoteModelState[] = [];
    const { transport } = createTransportWithSinks({
      connection,
      onRemoteModelStateChange: state => states.push(state),
    });

    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    connection.emitReconnect();
    await Promise.resolve();
    await Promise.resolve();

    expect(states.at(-1)).toEqual({
      ownerConnectionId: 'owner',
      protocol: 'v1',
      catalog: REMOTE_CATALOG,
      refresh: 'error',
      error: 'catalog refresh timed out',
    });
    expect(connection.sendCommand).toHaveBeenCalledTimes(2);
    transport.destroy();
  });

  it('clears owner-scoped catalog state and rediscovers after session reappearance', async () => {
    const connection = createConnection();
    jest.mocked(connection.sendCommand).mockResolvedValue(WIRE_CATALOG);
    const states: RemoteModelState[] = [];
    const { transport } = createTransportWithSinks({
      connection,
      onRemoteModelStateChange: state => states.push(state),
    });

    transport.connect();
    emitOwner(connection, 'owner-a');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    connection.emitSystem({ event: 'sessions.list', data: { sessions: [] } });
    expect(states.at(-1)).toEqual({
      ownerConnectionId: null,
      protocol: 'unknown',
      refresh: 'idle',
    });

    emitOwner(connection, 'owner-b');
    await Promise.resolve();
    await Promise.resolve();

    expect(connection.sendCommand).toHaveBeenLastCalledWith(
      KILO_SESSION_ID,
      'list_models',
      { protocolVersion: 1 },
      'owner-b'
    );
    expect(connection.sendCommand).toHaveBeenCalledTimes(2);
    transport.destroy();
  });

  it('changes send readiness with owner presence and owner-fence failures', async () => {
    const connection = createConnection();
    jest
      .mocked(connection.sendCommand)
      .mockImplementation((_sessionId, command) =>
        Promise.resolve(command === 'list_models' ? WIRE_CATALOG : { ok: true })
      );
    const capabilityChanges = jest.fn();
    const { transport } = createTransportWithSinks({
      connection,
      onCapabilityChange: capabilityChanges,
    });

    transport.connect();
    expect(transport.canSend?.()).toBe(false);

    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();
    expect(transport.canSend?.()).toBe(true);

    jest.mocked(connection.sendCommand).mockRejectedValueOnce(
      new UserWebCommandError({
        code: 'SESSION_OWNER_CHANGED',
        message: 'Session owner changed',
      })
    );
    await expect(transport.interrupt?.()).rejects.toMatchObject({
      code: 'SESSION_OWNER_CHANGED',
    });
    expect(transport.canSend?.()).toBe(false);

    emitOwner(connection, 'replacement-owner');
    await Promise.resolve();
    await Promise.resolve();
    expect(transport.canSend?.()).toBe(true);
    expect(capabilityChanges).toHaveBeenCalled();

    connection.emitSystem({
      event: 'sessions.list',
      data: { sessions: [] },
    });
    expect(transport.canSend?.()).toBe(false);
    transport.destroy();
  });

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

  it('re-forwards an unchanged heartbeat status after a disconnect', () => {
    const { userWebConnection, transport, serviceEvents } = createTransportWithSinks();
    transport.connect();

    const heartbeat = (sessions: Array<{ id: string; status: string; title: string }>) => {
      userWebConnection.emitSystem({
        event: 'sessions.heartbeat',
        data: { connectionId: 'owner', sessions },
      });
    };

    heartbeat([{ id: KILO_SESSION_ID, status: 'idle', title: 'Tracked' }]);
    heartbeat([]);
    heartbeat([{ id: KILO_SESSION_ID, status: 'idle', title: 'Tracked' }]);

    // idle → stopped(disconnected) → idle again: the post-reconnect status must
    // be forwarded even though it matches the pre-disconnect one, because only
    // a session.status event clears the disconnected UI state.
    expect(serviceEvents).toEqual([
      { type: 'session.status', sessionId: KILO_SESSION_ID, status: { type: 'idle' } },
      { type: 'stopped', reason: 'disconnected' },
      { type: 'session.status', sessionId: KILO_SESSION_ID, status: { type: 'idle' } },
    ]);
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

  it('signals replay completion only after the snapshot has been drained', async () => {
    let resolveSnapshot: ((snapshot: SessionSnapshot) => void) | undefined;
    const fetchSnapshot = jest.fn(
      () =>
        new Promise<SessionSnapshot>(resolve => {
          resolveSnapshot = resolve;
        })
    );
    const { transport, getReplayCompleteCount } = createTransportWithSinks({ fetchSnapshot });
    transport.connect();

    expect(getReplayCompleteCount()).toBe(0);

    resolveSnapshot?.(makeSnapshot({ id: KILO_SESSION_ID }, []));
    await Promise.resolve();
    await Promise.resolve();

    expect(getReplayCompleteCount()).toBe(1);
    transport.destroy();
  });

  it('applies a live session.updated after stale snapshot metadata', async () => {
    let resolveSnapshot: ((snapshot: SessionSnapshot) => void) | undefined;
    const fetchSnapshot = jest.fn(
      () =>
        new Promise<SessionSnapshot>(resolve => {
          resolveSnapshot = resolve;
        })
    );
    const { userWebConnection, transport, serviceEvents } = createTransportWithSinks({
      fetchSnapshot,
    });
    transport.connect();
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);

    userWebConnection.emitCli({
      sessionId: KILO_SESSION_ID,
      event: 'session.updated',
      data: {
        info: {
          id: KILO_SESSION_ID,
          model: { providerID: 'anthropic', id: 'live-model', variant: 'high' },
        },
      },
    });
    expect(serviceEvents).toHaveLength(0);

    resolveSnapshot?.({
      info: {
        id: KILO_SESSION_ID,
        model: { providerID: 'openai', id: 'stale-snapshot-model' },
      },
      messages: [],
    });
    await Promise.resolve();
    await Promise.resolve();

    const observedModels = serviceEvents.flatMap(event => {
      if (
        (event.type === 'session.created' || event.type === 'session.updated') &&
        event.info.model
      ) {
        return [event.info.model];
      }
      return [];
    });
    expect(serviceEvents.map(event => event.type)).toEqual(['session.created', 'session.updated']);
    expect(observedModels).toEqual([
      { providerID: 'openai', id: 'stale-snapshot-model' },
      { providerID: 'anthropic', id: 'live-model', variant: 'high' },
    ]);
    expect(observedModels.at(-1)).toEqual({
      providerID: 'anthropic',
      id: 'live-model',
      variant: 'high',
    });
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

  it('sends a v1 CLI-catalog override as a structured model with a catalog-valid variant', async () => {
    const connection = createConnection();
    jest
      .mocked(connection.sendCommand)
      .mockImplementation((_sessionId, command) =>
        Promise.resolve(command === 'list_models' ? WIRE_CATALOG : { ok: true })
      );
    const { transport } = createTransportWithSinks({ connection });

    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    jest.mocked(connection.sendCommand).mockClear();

    await transport.send?.({
      payload: {
        type: 'prompt',
        prompt: 'hello',
        model: { providerID: 'kilo', modelID: 'stale-model' },
        variant: 'stale-variant',
      },
      remoteModelOverride: {
        source: 'cli-catalog',
        selection: {
          model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
          variant: 'high',
        },
      },
    });

    expect(connection.sendCommand).toHaveBeenCalledWith(
      KILO_SESSION_ID,
      'send_message',
      {
        sessionID: KILO_SESSION_ID,
        parts: [{ type: 'text', text: 'hello' }],
        model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
        variant: 'high',
      },
      'owner'
    );
    transport.destroy();
  });

  it('rejects a CLI-catalog variant that is not advertised for the selected model', async () => {
    const connection = createConnection();
    jest
      .mocked(connection.sendCommand)
      .mockImplementation((_sessionId, command) =>
        Promise.resolve(command === 'list_models' ? WIRE_CATALOG : { ok: true })
      );
    const { transport } = createTransportWithSinks({ connection });

    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    jest.mocked(connection.sendCommand).mockClear();

    await expect(
      transport.send?.({
        payload: { type: 'prompt', prompt: 'hello' },
        remoteModelOverride: {
          source: 'cli-catalog',
          selection: {
            model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
            variant: 'not-advertised',
          },
        },
      })
    ).rejects.toThrow('Selected remote model variant is not available in the current CLI catalog');

    expect(connection.sendCommand).not.toHaveBeenCalled();
    transport.destroy();
  });

  it('rejects a CLI-catalog override whose model is absent from the current catalog', async () => {
    const connection = createConnection();
    jest
      .mocked(connection.sendCommand)
      .mockImplementation((_sessionId, command) =>
        Promise.resolve(command === 'list_models' ? WIRE_CATALOG : { ok: true })
      );
    const { transport } = createTransportWithSinks({ connection });

    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();
    jest.mocked(connection.sendCommand).mockClear();

    await expect(
      transport.send?.({
        payload: { type: 'prompt', prompt: 'hello' },
        remoteModelOverride: {
          source: 'cli-catalog',
          selection: { model: { providerID: 'anthropic', modelID: 'removed-model' } },
        },
      })
    ).rejects.toThrow('Selected remote model is not available in the current CLI catalog');

    expect(connection.sendCommand).not.toHaveBeenCalled();
    transport.destroy();
  });

  it('rejects an explicit override while catalog protocol is unknown', async () => {
    const connection = createConnection();
    jest
      .mocked(connection.sendCommand)
      .mockImplementation((_sessionId, command) =>
        command === 'list_models' ? new Promise(() => {}) : Promise.resolve({ ok: true })
      );
    const { transport } = createTransportWithSinks({ connection });

    transport.connect();
    emitOwner(connection);
    jest.mocked(connection.sendCommand).mockClear();

    await expect(
      transport.send?.({
        payload: { type: 'prompt', prompt: 'hello' },
        remoteModelOverride: {
          source: 'cli-catalog',
          selection: {
            model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
            variant: 'high',
          },
        },
      })
    ).rejects.toThrow(
      'Selected remote model override is incompatible with the connected CLI model protocol'
    );

    expect(connection.sendCommand).not.toHaveBeenCalled();
    transport.destroy();
  });

  it('rejects a legacy Gateway override while the connected CLI uses v1 catalogs', async () => {
    const connection = createConnection();
    jest
      .mocked(connection.sendCommand)
      .mockImplementation((_sessionId, command) =>
        Promise.resolve(command === 'list_models' ? WIRE_CATALOG : { ok: true })
      );
    const { transport } = createTransportWithSinks({ connection });

    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();
    jest.mocked(connection.sendCommand).mockClear();

    await expect(
      transport.send?.({
        payload: { type: 'prompt', prompt: 'hello' },
        remoteModelOverride: {
          source: 'legacy-gateway',
          selection: { model: { providerID: 'kilo', modelID: 'anthropic/claude-sonnet-4' } },
        },
      })
    ).rejects.toThrow(
      'Selected remote model override is incompatible with the connected CLI model protocol'
    );

    expect(connection.sendCommand).not.toHaveBeenCalled();
    transport.destroy();
  });

  it('omits model and variant when no explicit override is provided', async () => {
    const connection = createConnection();
    jest
      .mocked(connection.sendCommand)
      .mockImplementation((_sessionId, command) =>
        Promise.resolve(command === 'list_models' ? WIRE_CATALOG : { ok: true })
      );
    const { transport } = createTransportWithSinks({ connection });

    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    jest.mocked(connection.sendCommand).mockClear();

    await transport.send?.({
      payload: {
        type: 'prompt',
        prompt: 'use session precedence',
        model: { providerID: 'kilo', modelID: 'observed-only' },
        variant: 'stale',
      },
    });

    expect(connection.sendCommand).toHaveBeenCalledWith(
      KILO_SESSION_ID,
      'send_message',
      {
        sessionID: KILO_SESSION_ID,
        parts: [{ type: 'text', text: 'use session precedence' }],
      },
      'owner'
    );
    transport.destroy();
  });

  it.each([
    ['Kilo', { providerID: 'kilo', modelID: 'anthropic/claude-sonnet-4' }],
    ['non-Kilo', { providerID: 'anthropic', modelID: 'claude-sonnet-4' }],
  ])(
    'omits an observed %s model for a legacy CLI when no override exists',
    async (_label, model) => {
      const connection = createConnection();
      jest
        .mocked(connection.sendCommand)
        .mockImplementation((_sessionId, command) =>
          command === 'list_models'
            ? Promise.reject(new Error('unknown command: list_models'))
            : Promise.resolve({ ok: true })
        );
      const { transport } = createTransportWithSinks({ connection });

      transport.connect();
      emitOwner(connection);
      await Promise.resolve();
      await Promise.resolve();
      jest.mocked(connection.sendCommand).mockClear();

      await transport.send?.({
        payload: {
          type: 'prompt',
          prompt: 'use the session model',
          model,
          variant: 'observed-variant',
        },
      });

      expect(connection.sendCommand).toHaveBeenCalledWith(
        KILO_SESSION_ID,
        'send_message',
        {
          sessionID: KILO_SESSION_ID,
          parts: [{ type: 'text', text: 'use the session model' }],
        },
        'owner'
      );
      transport.destroy();
    }
  );

  it('sends an explicit legacy Gateway override as a Kilo model string', async () => {
    const connection = createConnection();
    jest
      .mocked(connection.sendCommand)
      .mockImplementation((_sessionId, command) =>
        command === 'list_models'
          ? Promise.reject(new Error('unknown command: list_models'))
          : Promise.resolve({ ok: true })
      );
    const { transport } = createTransportWithSinks({ connection });

    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();
    jest.mocked(connection.sendCommand).mockClear();

    await transport.send?.({
      payload: {
        type: 'prompt',
        prompt: 'hello',
        model: { providerID: 'kilo', modelID: 'observed-model' },
      },
      remoteModelOverride: {
        source: 'legacy-gateway',
        selection: {
          model: { providerID: 'kilo', modelID: 'anthropic/claude-sonnet-4' },
          variant: 'high',
        },
      },
    });

    expect(connection.sendCommand).toHaveBeenCalledWith(
      KILO_SESSION_ID,
      'send_message',
      {
        sessionID: KILO_SESSION_ID,
        parts: [{ type: 'text', text: 'hello' }],
        model: 'anthropic/claude-sonnet-4',
        variant: 'high',
      },
      'owner'
    );
    transport.destroy();
  });

  it('rejects a legacy Gateway override that does not use the Kilo provider', async () => {
    const connection = createConnection();
    jest
      .mocked(connection.sendCommand)
      .mockImplementation((_sessionId, command) =>
        command === 'list_models'
          ? Promise.reject(new Error('unknown command: list_models'))
          : Promise.resolve({ ok: true })
      );
    const { transport } = createTransportWithSinks({ connection });

    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();
    jest.mocked(connection.sendCommand).mockClear();

    await expect(
      transport.send?.({
        payload: { type: 'prompt', prompt: 'hello' },
        remoteModelOverride: {
          source: 'legacy-gateway',
          selection: { model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' } },
        },
      })
    ).rejects.toThrow(
      'Selected remote model override is incompatible with the connected CLI model protocol'
    );
    expect(connection.sendCommand).not.toHaveBeenCalled();
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
          model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
          variant: 'high',
        },
        remoteModelOverride: {
          source: 'cli-catalog' as const,
          selection: {
            model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
            variant: 'high',
          },
        },
      }),

      'send_message',
      {
        sessionID: KILO_SESSION_ID,
        parts: [{ type: 'text', text: 'hello' }],
        agent: 'code',
        model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
        variant: 'high',
      },
    ],
    [
      'send',
      () => ({
        payload: {
          type: 'prompt' as const,
          prompt: 'hello',
          mode: 'code',
        },
      }),
      'send_message',
      {
        sessionID: KILO_SESSION_ID,
        parts: [{ type: 'text', text: 'hello' }],
        agent: 'code',
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
      const connection = createConnection();
      jest
        .mocked(connection.sendCommand)
        .mockImplementation((_sessionId, commandName) =>
          Promise.resolve(commandName === 'list_models' ? WIRE_CATALOG : { ok: true })
        );
      const { userWebConnection, transport } = createTransportWithSinks({ connection });
      const invoke = transport[method as keyof typeof transport] as (
        value?: unknown
      ) => Promise<unknown>;

      transport.connect();
      emitOwner(connection);
      await Promise.resolve();
      await Promise.resolve();
      jest.mocked(userWebConnection.sendCommand).mockClear();

      await invoke(input());

      expect(userWebConnection.sendCommand).toHaveBeenCalledWith(
        KILO_SESSION_ID,
        command,
        data,
        'owner'
      );
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
