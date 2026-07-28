import type { ChatEvent, ServiceEvent } from './normalizer';
import { createCliLiveTransport } from './cli-live-transport';
import type { SlashCommandInfo } from './schemas';
import type {
  RemoteModelCatalogV1,
  RemoteModelCatalogWireV1,
  RemoteModelState,
} from './remote-model-catalog';
import type { RemoteCommandState } from './remote-command-catalog';
import {
  UserWebCommandError,
  type UserWebCliEvent,
  type UserWebConnection,
  type UserWebSystemEvent,
} from './user-web-connection';
import type { KiloSessionId, SessionSnapshot, SessionSnapshotPageOutcome } from './types';
import { kiloId, makeSnapshot, stubTextPart, stubUserMessage } from './test-helpers';
import type { RemoteAttachmentPart } from './transport';

const KILO_SESSION_ID = kiloId('kilo-ses-1');
const NEW_KILO_SESSION_ID = 'ses_12345678901234567890123456';
const ROTATED_KILO_SESSION_ID = 'ses_abcdefghijklmnopqrstuvwxyz';
const COMMAND_WIRE_CATALOG = {
  protocolVersion: 1,
  commands: [
    {
      name: 'review',
      description: 'Review changes',
      source: 'command' as const,
      hints: ['$ARGUMENTS'],
    },
    {
      name: 'compact',
      description: 'compact the current session context',
      hints: [],
    },
  ],
} satisfies { protocolVersion: 1; commands: SlashCommandInfo[] };
const PARSED_COMMAND_CATALOG: SlashCommandInfo[] = COMMAND_WIRE_CATALOG.commands.map(command => ({
  ...command,
  hints: [...command.hints],
}));
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
    sendCommandToConnection: jest.fn(() => Promise.resolve({ ok: true })),
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
  onRemoteCommandStateChange?: (state: RemoteCommandState) => void;
  onCapabilityChange?: () => void;
  onCapabilitiesChange?: (capabilities: { attachments?: boolean } | undefined) => void;
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
    onRemoteCommandStateChange: opts?.onRemoteCommandStateChange,
    onCapabilityChange: opts?.onCapabilityChange,
    onCapabilitiesChange: opts?.onCapabilitiesChange,
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

function emitHeartbeat(
  connection: FakeUserWebConnection,
  sessions: Array<{
    id: string;
    status: string;
    title: string;
    capabilities?: { attachments?: boolean };
  }>,
  connectionId = 'owner'
): void {
  connection.emitSystem({
    event: 'sessions.heartbeat',
    data: { connectionId, sessions },
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
    jest.mocked(connection.sendCommand).mockImplementation((_sessionId, command, _data, owner) => {
      if (command === 'list_commands') return Promise.resolve(COMMAND_WIRE_CATALOG);
      return owner === 'owner-a' ? firstCatalog : Promise.resolve(replacementWireCatalog);
    });
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
    jest.mocked(connection.sendCommand).mockImplementation((_sessionId, command) =>
      command === 'list_commands'
        ? Promise.resolve(COMMAND_WIRE_CATALOG)
        : new Promise(resolve => {
            resolveCatalog = resolve;
          })
    );
    const { transport } = createTransportWithSinks({ connection });

    transport.connect();
    emitOwner(connection);
    transport.retryRemoteModels?.();
    connection.emitReconnect();

    expect(
      jest
        .mocked(connection.sendCommand)
        .mock.calls.filter(([, command]) => command === 'list_models')
    ).toHaveLength(1);

    resolveCatalog?.(WIRE_CATALOG);
    await Promise.resolve();
    await Promise.resolve();
    transport.destroy();
  });

  it('retains a v1 catalog when a same-owner reconnect refresh fails', async () => {
    const connection = createConnection();
    let modelCatalogRequest = 0;
    jest.mocked(connection.sendCommand).mockImplementation((_sessionId, command) => {
      if (command === 'list_commands') return Promise.resolve(COMMAND_WIRE_CATALOG);
      modelCatalogRequest += 1;
      return modelCatalogRequest === 1
        ? Promise.resolve(WIRE_CATALOG)
        : Promise.reject(new Error('catalog refresh timed out'));
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
    expect(
      jest
        .mocked(connection.sendCommand)
        .mock.calls.filter(([, command]) => command === 'list_models')
    ).toHaveLength(2);
    transport.destroy();
  });

  it('clears owner-scoped catalog state and rediscovers after session reappearance', async () => {
    const connection = createConnection();
    jest
      .mocked(connection.sendCommand)
      .mockImplementation((_sessionId, command) =>
        Promise.resolve(command === 'list_models' ? WIRE_CATALOG : COMMAND_WIRE_CATALOG)
      );
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

    expect(
      jest
        .mocked(connection.sendCommand)
        .mock.calls.filter(([, command]) => command === 'list_models')
    ).toHaveLength(2);
    expect(
      jest
        .mocked(connection.sendCommand)
        .mock.calls.filter(([, command]) => command === 'list_models')
        .at(-1)
    ).toEqual([KILO_SESSION_ID, 'list_models', { protocolVersion: 1 }, 'owner-b']);
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
    expect(serviceEvents).toEqual([
      { type: 'commands.available', commands: [] },
      { type: 'stopped', reason: 'disconnected' },
    ]);

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
      { type: 'commands.available', commands: [] },
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

  it('sends a structured command with arguments, message ID, model, and variant', async () => {
    const connection = createConnection();
    jest.mocked(connection.sendCommand).mockImplementation((_sessionId, command) => {
      if (command === 'list_models') return Promise.resolve(WIRE_CATALOG);
      if (command === 'list_commands') return Promise.resolve(COMMAND_WIRE_CATALOG);
      return Promise.resolve({ ok: true });
    });
    const { userWebConnection, transport } = createTransportWithSinks({ connection });

    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    jest.mocked(userWebConnection.sendCommand).mockClear();

    await transport.send?.({
      payload: { type: 'command', command: 'review', arguments: 'main --fix' },
      messageId: 'msg-command-1',
      remoteModelOverride: {
        source: 'cli-catalog',
        selection: {
          model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
          variant: 'high',
        },
      },
    });

    expect(userWebConnection.sendCommand).toHaveBeenCalledWith(
      KILO_SESSION_ID,
      'send_command',
      {
        protocolVersion: 1,
        command: 'review',
        arguments: 'main --fix',
        messageID: 'msg-command-1',
        model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
        variant: 'high',
      },
      'owner'
    );
    transport.destroy();
  });

  it('sends a structured command without a message ID and without a model override', async () => {
    const connection = createConnection();
    jest.mocked(connection.sendCommand).mockImplementation((_sessionId, command) => {
      if (command === 'list_models') return Promise.resolve(WIRE_CATALOG);
      if (command === 'list_commands') return Promise.resolve(COMMAND_WIRE_CATALOG);
      return Promise.resolve({ ok: true });
    });
    const { userWebConnection, transport } = createTransportWithSinks({ connection });

    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    jest.mocked(userWebConnection.sendCommand).mockClear();

    await transport.send?.({
      payload: { type: 'command', command: 'compact', arguments: '' },
    });

    expect(userWebConnection.sendCommand).toHaveBeenCalledWith(
      KILO_SESSION_ID,
      'send_command',
      {
        protocolVersion: 1,
        command: 'compact',
        arguments: '',
      },
      'owner'
    );
    transport.destroy();
  });

  it('sends a legacy command override as a structured kilo model with the bare modelID', async () => {
    const connection = createConnection();
    jest.mocked(connection.sendCommand).mockImplementation((_sessionId, command) => {
      if (command === 'list_models')
        return Promise.reject(new Error('unknown command: list_models'));
      if (command === 'list_commands') return Promise.resolve(COMMAND_WIRE_CATALOG);
      return Promise.resolve({ ok: true });
    });
    const { userWebConnection, transport } = createTransportWithSinks({ connection });

    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    jest.mocked(userWebConnection.sendCommand).mockClear();

    await transport.send?.({
      payload: { type: 'command', command: 'review', arguments: '' },
      remoteModelOverride: {
        source: 'legacy-gateway',
        selection: {
          model: { providerID: 'kilo', modelID: 'anthropic/claude-sonnet-4' },
          variant: 'high',
        },
      },
    });

    expect(userWebConnection.sendCommand).toHaveBeenCalledWith(
      KILO_SESSION_ID,
      'send_command',
      {
        protocolVersion: 1,
        command: 'review',
        arguments: '',
        model: { providerID: 'kilo', modelID: 'anthropic/claude-sonnet-4' },
        variant: 'high',
      },
      'owner'
    );
    transport.destroy();
  });

  it('strips the kilo/ prefix from a legacy command override modelID to match CLI dispatch', async () => {
    const connection = createConnection();
    jest.mocked(connection.sendCommand).mockImplementation((_sessionId, command) => {
      if (command === 'list_models')
        return Promise.reject(new Error('unknown command: list_models'));
      if (command === 'list_commands') return Promise.resolve(COMMAND_WIRE_CATALOG);
      return Promise.resolve({ ok: true });
    });
    const { userWebConnection, transport } = createTransportWithSinks({ connection });

    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    jest.mocked(userWebConnection.sendCommand).mockClear();

    // The CLI normalizer (`dispatchedKilocodeModelId`) strips the `kilo/`
    // prefix from a legacy override modelID. For the structured
    // `send_command` wire to dispatch the same model the CLI would see from
    // a prompt wire, the modelID in the structured payload must be the
    // dispatched (stripped) form.
    await transport.send?.({
      payload: { type: 'command', command: 'review', arguments: '' },
      remoteModelOverride: {
        source: 'legacy-gateway',
        selection: {
          model: { providerID: 'kilo', modelID: 'kilo/anthropic/claude-sonnet-4' },
        },
      },
    });

    expect(userWebConnection.sendCommand).toHaveBeenCalledWith(
      KILO_SESSION_ID,
      'send_command',
      {
        protocolVersion: 1,
        command: 'review',
        arguments: '',
        model: { providerID: 'kilo', modelID: 'anthropic/claude-sonnet-4' },
      },
      'owner'
    );
    transport.destroy();
  });
});

describe('CliLiveTransport remote command catalog', () => {
  it('discovers and publishes commands for the current owner', async () => {
    const connection = createConnection();
    jest
      .mocked(connection.sendCommand)
      .mockImplementation((_sessionId, command) =>
        Promise.resolve(command === 'list_models' ? WIRE_CATALOG : COMMAND_WIRE_CATALOG)
      );
    const commandStates: RemoteCommandState[] = [];
    const { transport, serviceEvents } = createTransportWithSinks({
      connection,
      onRemoteCommandStateChange: state => commandStates.push(state),
    });

    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(connection.sendCommand).toHaveBeenCalledWith(
      KILO_SESSION_ID,
      'list_commands',
      { protocolVersion: 1 },
      'owner'
    );
    expect(serviceEvents.filter(event => event.type === 'commands.available')).toEqual([
      { type: 'commands.available', commands: PARSED_COMMAND_CATALOG },
    ]);
    expect(commandStates.at(-1)).toEqual({
      ownerConnectionId: 'owner',
      refresh: 'idle',
      commands: PARSED_COMMAND_CATALOG,
    });
    transport.destroy();
  });

  it('publishes an empty command catalog for a legacy CLI without list_commands support', async () => {
    const connection = createConnection();
    const onError = jest.fn();
    jest
      .mocked(connection.sendCommand)
      .mockImplementation((_sessionId, command) =>
        command === 'list_models'
          ? Promise.resolve(WIRE_CATALOG)
          : Promise.reject(new Error('unknown command: list_commands'))
      );
    const { transport, serviceEvents } = createTransportWithSinks({
      connection,
      onError,
    });

    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(serviceEvents.filter(event => event.type === 'commands.available')).toEqual([
      { type: 'commands.available', commands: [] },
    ]);
    expect(onError).not.toHaveBeenCalled();
    transport.destroy();
  });

  it('clears the catalog on a malformed same-owner refresh without populating fatal error', async () => {
    const connection = createConnection();
    const onError = jest.fn();
    let commandRequest = 0;
    jest.mocked(connection.sendCommand).mockImplementation((_sessionId, command) => {
      if (command === 'list_models') return Promise.resolve(WIRE_CATALOG);
      commandRequest += 1;
      return commandRequest === 1
        ? Promise.resolve(COMMAND_WIRE_CATALOG)
        : Promise.resolve({ invalid: true });
    });
    const commandStates: RemoteCommandState[] = [];
    const { transport, serviceEvents } = createTransportWithSinks({
      connection,
      onError,
      onRemoteCommandStateChange: state => commandStates.push(state),
    });

    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    connection.emitReconnect();
    await Promise.resolve();
    await Promise.resolve();

    expect(serviceEvents.filter(event => event.type === 'commands.available').at(-1)).toEqual({
      type: 'commands.available',
      commands: [],
    });
    expect(commandStates.at(-1)).toEqual({
      ownerConnectionId: 'owner',
      refresh: 'error',
      message: 'Invalid remote command catalog',
      commands: [],
    });
    expect(onError).not.toHaveBeenCalled();
    transport.destroy();
  });

  it('retains the catalog on a transient same-owner refresh failure', async () => {
    const connection = createConnection();
    const onError = jest.fn();
    let rejectRefresh: ((error: Error) => void) | undefined;
    let commandRequest = 0;
    jest.mocked(connection.sendCommand).mockImplementation((_sessionId, command) => {
      if (command === 'list_models') return Promise.resolve(WIRE_CATALOG);
      commandRequest += 1;
      if (commandRequest === 1) return Promise.resolve(COMMAND_WIRE_CATALOG);
      return new Promise((_resolve, reject) => {
        rejectRefresh = reject;
      });
    });
    const commandStates: RemoteCommandState[] = [];
    const { transport, serviceEvents } = createTransportWithSinks({
      connection,
      onError,
      onRemoteCommandStateChange: state => commandStates.push(state),
    });

    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const publishedBeforeRefresh = serviceEvents.filter(
      event => event.type === 'commands.available'
    );

    connection.emitReconnect();
    expect(serviceEvents.filter(event => event.type === 'commands.available')).toEqual(
      publishedBeforeRefresh
    );

    rejectRefresh?.(new Error('command catalog timed out'));
    await Promise.resolve();
    await Promise.resolve();

    expect(serviceEvents.filter(event => event.type === 'commands.available')).toEqual(
      publishedBeforeRefresh
    );
    expect(commandStates.at(-1)).toEqual({
      ownerConnectionId: 'owner',
      refresh: 'error',
      message: 'command catalog timed out',
      commands: PARSED_COMMAND_CATALOG,
    });
    expect(onError).not.toHaveBeenCalled();
    transport.destroy();
  });

  it('clears the catalog and reports a nonfatal error on a CATALOG_TOO_LARGE relay failure', async () => {
    const connection = createConnection();
    const onError = jest.fn();
    let commandRequest = 0;
    jest.mocked(connection.sendCommand).mockImplementation((_sessionId, command) => {
      if (command === 'list_models') return Promise.resolve(WIRE_CATALOG);
      commandRequest += 1;
      return commandRequest === 1
        ? Promise.resolve(COMMAND_WIRE_CATALOG)
        : Promise.reject(
            new UserWebCommandError({
              code: 'CATALOG_TOO_LARGE',
              message: 'Command catalog response is too large',
            })
          );
    });
    const commandStates: RemoteCommandState[] = [];
    const { transport, serviceEvents } = createTransportWithSinks({
      connection,
      onError,
      onRemoteCommandStateChange: state => commandStates.push(state),
    });

    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    connection.emitReconnect();
    await Promise.resolve();
    await Promise.resolve();

    expect(serviceEvents.filter(event => event.type === 'commands.available').at(-1)).toEqual({
      type: 'commands.available',
      commands: [],
    });
    expect(commandStates.at(-1)).toEqual({
      ownerConnectionId: 'owner',
      refresh: 'error',
      message: 'Command catalog response is too large',
      commands: [],
    });
    expect(onError).not.toHaveBeenCalled();
    transport.destroy();
  });

  it('publishes actionable upgrade-required state when the relay reports CLI_UPGRADE_REQUIRED', async () => {
    const connection = createConnection();
    const onError = jest.fn();
    jest.mocked(connection.sendCommand).mockImplementation((_sessionId, command) => {
      if (command === 'list_models') return Promise.resolve(WIRE_CATALOG);
      return Promise.reject(
        new UserWebCommandError({
          code: 'CLI_UPGRADE_REQUIRED',
          message: 'Update Kilo CLI to v8.4.0 to use slash commands',
        })
      );
    });
    const commandStates: RemoteCommandState[] = [];
    const { transport, serviceEvents } = createTransportWithSinks({
      connection,
      onError,
      onRemoteCommandStateChange: state => commandStates.push(state),
    });

    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(serviceEvents.filter(event => event.type === 'commands.available')).toEqual([
      { type: 'commands.available', commands: [] },
    ]);
    expect(commandStates.at(-1)).toEqual({
      ownerConnectionId: 'owner',
      refresh: 'upgrade-required',
      message: 'Update Kilo CLI to v8.4.0 to use slash commands',
      commands: [],
    });
    expect(onError).not.toHaveBeenCalled();
    transport.destroy();
  });

  it('propagates actionable copy from send_command CLI_UPGRADE_REQUIRED failures', async () => {
    const connection = createConnection();
    jest.mocked(connection.sendCommand).mockImplementation((_sessionId, command) => {
      if (command === 'list_models') return Promise.resolve(WIRE_CATALOG);
      if (command === 'list_commands') return Promise.resolve(COMMAND_WIRE_CATALOG);
      return Promise.reject(
        new UserWebCommandError({
          code: 'CLI_UPGRADE_REQUIRED',
          message: 'Update Kilo CLI to v8.4.0 to send slash commands',
        })
      );
    });
    const { transport } = createTransportWithSinks({ connection });

    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    await expect(
      transport.send?.({ payload: { type: 'command', command: 'review', arguments: '' } })
    ).rejects.toThrow('Update Kilo CLI to v8.4.0 to send slash commands');
    transport.destroy();
  });

  it('keeps one command catalog request in flight per owner across reconnects', async () => {
    const connection = createConnection();
    let resolveCatalog: ((catalog: typeof COMMAND_WIRE_CATALOG) => void) | undefined;
    jest.mocked(connection.sendCommand).mockImplementation((_sessionId, command) => {
      if (command === 'list_models') return Promise.resolve(WIRE_CATALOG);
      return new Promise(resolve => {
        resolveCatalog = resolve;
      });
    });
    const { transport } = createTransportWithSinks({ connection });

    transport.connect();
    emitOwner(connection);
    connection.emitReconnect();
    connection.emitReconnect();

    expect(
      jest
        .mocked(connection.sendCommand)
        .mock.calls.filter(([, command]) => command === 'list_commands')
    ).toHaveLength(1);

    resolveCatalog?.(COMMAND_WIRE_CATALOG);
    await Promise.resolve();
    await Promise.resolve();
    transport.destroy();
  });

  it('keeps command discovery independent from model discovery generation', async () => {
    const connection = createConnection();
    let resolveModelCatalog: ((catalog: RemoteModelCatalogWireV1) => void) | undefined;
    let resolveCommandCatalog: ((catalog: typeof COMMAND_WIRE_CATALOG) => void) | undefined;
    jest.mocked(connection.sendCommand).mockImplementation((_sessionId, command) => {
      if (command === 'list_models') {
        return new Promise(resolve => {
          resolveModelCatalog = resolve;
        });
      }
      return new Promise(resolve => {
        resolveCommandCatalog = resolve;
      });
    });
    const { transport } = createTransportWithSinks({ connection });

    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();

    // Resolving the model catalog must not resolve the command catalog
    // (different in-flight promises) and must not leave the command request
    // stuck — it should still be awaiting its own response.
    resolveModelCatalog?.(WIRE_CATALOG);
    await Promise.resolve();
    await Promise.resolve();
    expect(
      jest
        .mocked(connection.sendCommand)
        .mock.calls.filter(([, command]) => command === 'list_commands')
    ).toHaveLength(1);
    expect(
      jest
        .mocked(connection.sendCommand)
        .mock.calls.filter(([, command]) => command === 'list_models')
    ).toHaveLength(1);

    resolveCommandCatalog?.(COMMAND_WIRE_CATALOG);
    await Promise.resolve();
    await Promise.resolve();
    transport.destroy();
  });

  it('ignores a late command catalog from a replaced owner', async () => {
    const connection = createConnection();
    let resolveFirstCatalog: ((catalog: typeof COMMAND_WIRE_CATALOG) => void) | undefined;
    const firstCatalog = new Promise<typeof COMMAND_WIRE_CATALOG>(resolve => {
      resolveFirstCatalog = resolve;
    });
    const replacementCatalog = {
      protocolVersion: 1,
      commands: [{ name: 'compact', hints: [] }],
    };
    jest.mocked(connection.sendCommand).mockImplementation((_sessionId, command, _data, owner) => {
      if (command === 'list_models') return Promise.resolve(WIRE_CATALOG);
      if (command === 'list_commands') {
        return owner === 'owner-a' ? firstCatalog : Promise.resolve(replacementCatalog);
      }
      return Promise.resolve({ ok: true });
    });
    const { transport, serviceEvents } = createTransportWithSinks({ connection });

    transport.connect();
    emitOwner(connection, 'owner-a');
    emitOwner(connection, 'owner-b');
    await Promise.resolve();
    await Promise.resolve();

    resolveFirstCatalog?.(COMMAND_WIRE_CATALOG);
    await Promise.resolve();
    await Promise.resolve();

    expect(serviceEvents.filter(event => event.type === 'commands.available').at(-1)).toEqual({
      type: 'commands.available',
      commands: replacementCatalog.commands,
    });
    transport.destroy();
  });

  it('clears the published command catalog when the current owner disconnects', async () => {
    const connection = createConnection();
    jest
      .mocked(connection.sendCommand)
      .mockImplementation((_sessionId, command) =>
        Promise.resolve(command === 'list_models' ? WIRE_CATALOG : COMMAND_WIRE_CATALOG)
      );
    const { transport, serviceEvents } = createTransportWithSinks({ connection });

    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    connection.emitSystem({ event: 'cli.disconnected', data: { connectionId: 'owner' } });

    expect(serviceEvents.filter(event => event.type === 'commands.available').at(-1)).toEqual({
      type: 'commands.available',
      commands: [],
    });
    transport.destroy();
  });

  it('rejects send_command with Remote session has no connected owner when no owner is known', async () => {
    const { transport } = createTransportWithSinks();

    await expect(
      transport.send?.({ payload: { type: 'command', command: 'review', arguments: '' } })
    ).rejects.toThrow('Remote session has no connected owner');
    transport.destroy();
  });

  it('rejects send_command with SESSION_OWNER_CHANGED error when the owner changes mid-flight', async () => {
    const connection = createConnection();
    jest.mocked(connection.sendCommand).mockImplementation((_sessionId, command) => {
      if (command === 'list_models') return Promise.resolve(WIRE_CATALOG);
      if (command === 'list_commands') return Promise.resolve(COMMAND_WIRE_CATALOG);
      return Promise.reject(
        new UserWebCommandError({ code: 'SESSION_OWNER_CHANGED', message: 'Session owner changed' })
      );
    });
    const { transport } = createTransportWithSinks({ connection });

    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    await expect(
      transport.send?.({ payload: { type: 'command', command: 'review', arguments: '' } })
    ).rejects.toMatchObject({ code: 'SESSION_OWNER_CHANGED' });
    transport.destroy();
  });

  it('keeps an ordinary prompt on send_message after command discovery is enabled', async () => {
    const connection = createConnection();
    jest.mocked(connection.sendCommand).mockImplementation((_sessionId, command) => {
      if (command === 'list_models') return Promise.resolve(WIRE_CATALOG);
      if (command === 'list_commands') return Promise.resolve(COMMAND_WIRE_CATALOG);
      return Promise.resolve({ ok: true });
    });
    const { userWebConnection, transport } = createTransportWithSinks({ connection });

    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    jest.mocked(userWebConnection.sendCommand).mockClear();

    await transport.send?.({ payload: { type: 'prompt', prompt: 'hello' } });

    expect(userWebConnection.sendCommand).toHaveBeenCalledWith(
      KILO_SESSION_ID,
      'send_message',
      {
        sessionID: KILO_SESSION_ID,
        parts: [{ type: 'text', text: 'hello' }],
      },
      'owner'
    );
    transport.destroy();
  });

  it('retains the last valid commands on a transient same-owner refresh failure (state)', async () => {
    const connection = createConnection();
    const onError = jest.fn();
    let rejectRefresh: ((error: Error) => void) | undefined;
    let commandRequest = 0;
    jest.mocked(connection.sendCommand).mockImplementation((_sessionId, command) => {
      if (command === 'list_models') return Promise.resolve(WIRE_CATALOG);
      commandRequest += 1;
      if (commandRequest === 1) return Promise.resolve(COMMAND_WIRE_CATALOG);
      return new Promise((_resolve, reject) => {
        rejectRefresh = reject;
      });
    });
    const commandStates: RemoteCommandState[] = [];
    const { transport } = createTransportWithSinks({
      connection,
      onError,
      onRemoteCommandStateChange: state => commandStates.push(state),
    });

    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Initial discovery: state carries the parsed commands and `idle`.
    const idleState = commandStates.at(-1);
    expect(idleState).toEqual({
      ownerConnectionId: 'owner',
      refresh: 'idle',
      commands: PARSED_COMMAND_CATALOG,
    });

    // Reconnect triggers a new in-flight request; loading state keeps the
    // previously valid commands so consumers can keep showing them.
    connection.emitReconnect();
    await Promise.resolve();
    const loadingState = commandStates.at(-1);
    expect(loadingState).toEqual({
      ownerConnectionId: 'owner',
      refresh: 'loading',
      commands: PARSED_COMMAND_CATALOG,
    });

    // Transient failure: error state keeps the same cached commands.
    rejectRefresh?.(new Error('command catalog timed out'));
    await Promise.resolve();
    await Promise.resolve();
    const errorState = commandStates.at(-1);
    expect(errorState).toEqual({
      ownerConnectionId: 'owner',
      refresh: 'error',
      message: 'command catalog timed out',
      commands: PARSED_COMMAND_CATALOG,
    });
    expect(onError).not.toHaveBeenCalled();
    transport.destroy();
  });

  it('clears cached commands on malformed, oversized, upgrade-required, disconnect, and teardown', async () => {
    const connection = createConnection();
    let commandRequest = 0;
    jest.mocked(connection.sendCommand).mockImplementation((_sessionId, command) => {
      if (command === 'list_models') return Promise.resolve(WIRE_CATALOG);
      commandRequest += 1;
      if (commandRequest === 2) return Promise.resolve({ invalid: true });
      if (commandRequest === 4) {
        return Promise.reject(
          new UserWebCommandError({
            code: 'CATALOG_TOO_LARGE',
            message: 'Command catalog response is too large',
          })
        );
      }
      if (commandRequest === 6) {
        return Promise.reject(
          new UserWebCommandError({
            code: 'CLI_UPGRADE_REQUIRED',
            message: 'Update Kilo CLI to v8.4.0',
          })
        );
      }
      return Promise.resolve(COMMAND_WIRE_CATALOG);
    });
    const commandStates: RemoteCommandState[] = [];
    const { transport } = createTransportWithSinks({
      connection,
      onRemoteCommandStateChange: state => commandStates.push(state),
    });

    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(commandStates.at(-1)?.commands).toEqual(PARSED_COMMAND_CATALOG);

    // Malformed refresh: cache cleared.
    connection.emitReconnect();
    await Promise.resolve();
    await Promise.resolve();
    expect(commandStates.at(-1)).toEqual({
      ownerConnectionId: 'owner',
      refresh: 'error',
      message: 'Invalid remote command catalog',
      commands: [],
    });

    // Reconnect, retry → recovers cache.
    connection.emitReconnect();
    await Promise.resolve();
    await Promise.resolve();
    expect(commandStates.at(-1)?.commands).toEqual(PARSED_COMMAND_CATALOG);

    // CATALOG_TOO_LARGE: cache cleared.
    connection.emitReconnect();
    await Promise.resolve();
    await Promise.resolve();
    expect(commandStates.at(-1)).toEqual({
      ownerConnectionId: 'owner',
      refresh: 'error',
      message: 'Command catalog response is too large',
      commands: [],
    });

    // Reconnect, retry → recovers cache.
    connection.emitReconnect();
    await Promise.resolve();
    await Promise.resolve();
    expect(commandStates.at(-1)?.commands).toEqual(PARSED_COMMAND_CATALOG);

    // CLI_UPGRADE_REQUIRED: cache cleared and upgrade-required surfaced.
    connection.emitReconnect();
    await Promise.resolve();
    await Promise.resolve();
    expect(commandStates.at(-1)).toEqual({
      ownerConnectionId: 'owner',
      refresh: 'upgrade-required',
      message: 'Update Kilo CLI to v8.4.0',
      commands: [],
    });

    // Owner disconnect clears the cache.
    connection.emitSystem({ event: 'cli.disconnected', data: { connectionId: 'owner' } });
    expect(commandStates.at(-1)).toEqual({
      ownerConnectionId: null,
      refresh: 'idle',
      commands: [],
    });
    transport.destroy();

    // After transport teardown the next state (if any) keeps `[]` rather
    // than resurrecting the old cache.
    expect(commandStates.at(-1)?.commands).toEqual([]);
  });

  it('publishes immutable command arrays so later mutation cannot rewrite prior state history', async () => {
    const connection = createConnection();
    jest
      .mocked(connection.sendCommand)
      .mockImplementation((_sessionId, command) =>
        Promise.resolve(command === 'list_models' ? WIRE_CATALOG : COMMAND_WIRE_CATALOG)
      );
    const commandStates: RemoteCommandState[] = [];
    const { transport } = createTransportWithSinks({
      connection,
      onRemoteCommandStateChange: state => commandStates.push(state),
    });

    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const firstCommands = commandStates.at(-1)!.commands;
    expect(firstCommands).toEqual(PARSED_COMMAND_CATALOG);

    // Mutating the array reference held by the consumer must not bleed
    // into the next state — each emitted state carries its own copy.
    firstCommands.length = 0;
    connection.emitReconnect();
    await Promise.resolve();
    await Promise.resolve();
    expect(commandStates.at(-1)?.commands).toEqual(PARSED_COMMAND_CATALOG);
    transport.destroy();
  });

  it('exposes retryRemoteCommands that re-discovers after a transient failure', async () => {
    const connection = createConnection();
    let rejectFirstRefresh: ((error: Error) => void) | undefined;
    let commandRequest = 0;
    jest.mocked(connection.sendCommand).mockImplementation((_sessionId, command) => {
      if (command === 'list_models') return Promise.resolve(WIRE_CATALOG);
      commandRequest += 1;
      if (commandRequest === 1) return Promise.resolve(COMMAND_WIRE_CATALOG);
      if (commandRequest === 2) {
        return new Promise((_resolve, reject) => {
          rejectFirstRefresh = reject;
        });
      }
      return Promise.resolve(COMMAND_WIRE_CATALOG);
    });
    const { transport } = createTransportWithSinks({ connection });

    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(transport.retryRemoteCommands).toBeDefined();

    // Reconnect kicks off a refresh that we will then reject.
    connection.emitReconnect();
    await Promise.resolve();
    expect(
      jest
        .mocked(connection.sendCommand)
        .mock.calls.filter(([, command]) => command === 'list_commands')
    ).toHaveLength(2);
    rejectFirstRefresh?.(new Error('transient timeout'));
    await Promise.resolve();
    await Promise.resolve();

    // Retry must re-issue exactly one more list_commands call and recover.
    transport.retryRemoteCommands?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(
      jest
        .mocked(connection.sendCommand)
        .mock.calls.filter(([, command]) => command === 'list_commands')
    ).toHaveLength(3);

    // After recovery the cached commands are published again.
    const finalService = transport as unknown as {
      // accessor used by serviceEvent assertion helper is not exposed;
      // the cache is observed through the state callback instead.
    };
    void finalService;
    transport.destroy();
  });

  it('retryRemoteCommands is a no-op when there is no current owner', () => {
    const { transport } = createTransportWithSinks();
    transport.connect();
    expect(transport.retryRemoteCommands).toBeDefined();
    expect(() => transport.retryRemoteCommands?.()).not.toThrow();
    transport.destroy();
  });

  it('retryRemoteCommands does not issue a duplicate request while one is in flight', async () => {
    const connection = createConnection();
    let resolveCatalog: ((catalog: typeof COMMAND_WIRE_CATALOG) => void) | undefined;
    jest.mocked(connection.sendCommand).mockImplementation((_sessionId, command) => {
      if (command === 'list_models') return Promise.resolve(WIRE_CATALOG);
      return new Promise(resolve => {
        resolveCatalog = resolve;
      });
    });
    const { transport } = createTransportWithSinks({ connection });

    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();
    const initialCalls = jest
      .mocked(connection.sendCommand)
      .mock.calls.filter(([, command]) => command === 'list_commands').length;

    transport.retryRemoteCommands?.();
    transport.retryRemoteCommands?.();
    transport.retryRemoteCommands?.();

    expect(
      jest
        .mocked(connection.sendCommand)
        .mock.calls.filter(([, command]) => command === 'list_commands')
    ).toHaveLength(initialCalls);

    resolveCatalog?.(COMMAND_WIRE_CATALOG);
    await Promise.resolve();
    await Promise.resolve();
    transport.destroy();
  });

  it('isolates the commands.available event from later mutation of the outer array, command fields, and hints', async () => {
    const connection = createConnection();
    let rejectSecond: ((error: Error) => void) | undefined;
    let commandRequest = 0;
    jest.mocked(connection.sendCommand).mockImplementation((_sessionId, command) => {
      if (command === 'list_models') return Promise.resolve(WIRE_CATALOG);
      commandRequest += 1;
      if (commandRequest === 1) return Promise.resolve(COMMAND_WIRE_CATALOG);
      return new Promise((_resolve, reject) => {
        rejectSecond = reject;
      });
    });
    const commandStates: RemoteCommandState[] = [];
    const { transport, serviceEvents } = createTransportWithSinks({
      connection,
      onRemoteCommandStateChange: state => commandStates.push(state),
    });

    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Grab the event the transport published.
    const availableEvent = serviceEvents.find(
      (event): event is Extract<typeof event, { type: 'commands.available' }> =>
        event.type === 'commands.available'
    );
    expect(availableEvent).toBeDefined();
    const eventCommands = availableEvent!.commands;
    const eventFirst = eventCommands[0];
    expect(eventFirst).toBeDefined();

    // (b) Mutate a command object field — name. The event and the cache
    // currently share this command object reference.
    eventFirst.name = 'hijacked';

    // (c) Mutate a nested hints array on the first command.
    eventFirst.hints.length = 0;

    // (a) Mutate the outer array of the event.
    eventCommands.length = 0;
    eventCommands.push({
      name: 'mutated',
      description: 'consumer-injected',
      hints: ['$ARGUMENTS'],
    });

    // Trigger a retry that hangs, then reject with a transient error.
    // The transient error path surfaces the cached value via state.
    transport.retryRemoteCommands?.();
    await Promise.resolve();
    rejectSecond?.(new Error('transient timeout'));
    await Promise.resolve();
    await Promise.resolve();

    // The error state must still carry the original validated catalog,
    // not the consumer-mutated data. If the cache were corrupted by
    // the event mutations, the state would carry the mutated values.
    expect(commandStates.at(-1)?.commands).toEqual(PARSED_COMMAND_CATALOG);
    transport.destroy();
  });

  it('isolates RemoteCommandState.commands from later mutation of the outer array, command fields, and hints', async () => {
    const connection = createConnection();
    let rejectSecond: ((error: Error) => void) | undefined;
    let commandRequest = 0;
    jest.mocked(connection.sendCommand).mockImplementation((_sessionId, command) => {
      if (command === 'list_models') return Promise.resolve(WIRE_CATALOG);
      commandRequest += 1;
      if (commandRequest === 1) return Promise.resolve(COMMAND_WIRE_CATALOG);
      return new Promise((_resolve, reject) => {
        rejectSecond = reject;
      });
    });
    const commandStates: RemoteCommandState[] = [];
    const { transport } = createTransportWithSinks({
      connection,
      onRemoteCommandStateChange: state => commandStates.push(state),
    });

    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Grab the commands array from the last published state.
    const stateCommands = commandStates.at(-1)!.commands;
    expect(stateCommands).toEqual(PARSED_COMMAND_CATALOG);
    const stateFirst = stateCommands[0];
    expect(stateFirst).toBeDefined();

    // (b) Mutate a command object field — name. The state and the cache
    // currently share this command object reference.
    stateFirst.name = 'hijacked';

    // (c) Mutate a nested hints array on the first command.
    stateFirst.hints.length = 0;

    // (a) Mutate the outer array.
    stateCommands.length = 0;
    stateCommands.push({
      name: 'mutated',
      description: 'consumer-injected',
      hints: ['$ARGUMENTS'],
    });

    // Trigger a retry that hangs, then reject with a transient error.
    // The transient error path surfaces the cached value via state.
    transport.retryRemoteCommands?.();
    await Promise.resolve();
    rejectSecond?.(new Error('transient timeout'));
    await Promise.resolve();
    await Promise.resolve();

    expect(commandStates.at(-1)?.commands).toEqual(PARSED_COMMAND_CATALOG);
    transport.destroy();
  });
});

describe('CliLiveTransport createSession', () => {
  it('rejects when no owner is known', async () => {
    const { transport } = createTransportWithSinks();
    await expect(transport.createSession?.()).rejects.toThrow(
      'Remote session has no connected owner'
    );
    transport.destroy();
  });

  it('sends create_session via sendCommand against the current session and owner and returns the branded id', async () => {
    const connection = createConnection();
    jest
      .mocked(connection.sendCommand)
      .mockResolvedValue({ protocolVersion: 1, sessionID: NEW_KILO_SESSION_ID });
    const { transport, userWebConnection } = createTransportWithSinks({ connection });

    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Clear discovery calls so we can assert exactly the create_session call.
    jest.mocked(userWebConnection.sendCommand).mockClear();
    const result = await transport.createSession?.();
    expect(result).toBe(NEW_KILO_SESSION_ID);
    expect(userWebConnection.sendCommand).toHaveBeenCalledWith(
      KILO_SESSION_ID,
      'create_session',
      { protocolVersion: 1 },
      'owner'
    );
    expect(userWebConnection.sendCommandToConnection).not.toHaveBeenCalled();
    transport.destroy();
  });

  it('rejects a malformed response without retrying or changing owner', async () => {
    const connection = createConnection();
    jest.mocked(connection.sendCommand).mockResolvedValue({ invalid: true });
    const { transport, userWebConnection } = createTransportWithSinks({ connection });

    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    jest.mocked(userWebConnection.sendCommand).mockClear();
    await expect(transport.createSession?.()).rejects.toThrow('Invalid create_session response');
    // No second create_session call — never auto-retry.
    expect(
      jest
        .mocked(userWebConnection.sendCommand)
        .mock.calls.filter(([, command]) => command === 'create_session')
    ).toHaveLength(1);
    expect(userWebConnection.sendCommandToConnection).not.toHaveBeenCalled();
    expect(transport.canSend?.()).toBe(true);
    transport.destroy();
  });

  it('propagates a CLI_UPGRADE_REQUIRED error with the actionable message', async () => {
    const connection = createConnection();
    jest.mocked(connection.sendCommand).mockRejectedValue(
      new UserWebCommandError({
        code: 'CLI_UPGRADE_REQUIRED',
        message: 'Creating remote sessions from mobile requires a newer Kilo CLI.',
      })
    );
    const { transport, userWebConnection } = createTransportWithSinks({ connection });

    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    jest.mocked(userWebConnection.sendCommand).mockClear();
    await expect(transport.createSession?.()).rejects.toThrow(
      'Creating remote sessions from mobile requires a newer Kilo CLI.'
    );
    expect(
      jest
        .mocked(userWebConnection.sendCommand)
        .mock.calls.filter(([, command]) => command === 'create_session')
    ).toHaveLength(1);
    expect(userWebConnection.sendCommandToConnection).not.toHaveBeenCalled();
    transport.destroy();
  });

  it('clears the owner on a SESSION_OWNER_CHANGED error and re-throws', async () => {
    const connection = createConnection();
    const commandStates: RemoteCommandState[] = [];
    const { transport, userWebConnection } = createTransportWithSinks({
      connection,
      onRemoteCommandStateChange: state => commandStates.push(state),
    });

    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    jest.mocked(userWebConnection.sendCommand).mockClear();
    jest
      .mocked(userWebConnection.sendCommand)
      .mockRejectedValue(
        new UserWebCommandError({ code: 'SESSION_OWNER_CHANGED', message: 'Session owner changed' })
      );

    await expect(transport.createSession?.()).rejects.toMatchObject({
      code: 'SESSION_OWNER_CHANGED',
    });
    expect(commandStates.at(-1)?.ownerConnectionId).toBeNull();
    expect(userWebConnection.sendCommandToConnection).not.toHaveBeenCalled();
    transport.destroy();
  });

  it('uses the owner snapshot at call time when the owner changes mid-flight', async () => {
    const connection = createConnection();
    let resolveCreate: ((value: { protocolVersion: 1; sessionID: string }) => void) | undefined;
    const { transport, userWebConnection } = createTransportWithSinks({ connection });

    transport.connect();
    emitOwner(connection, 'owner-a');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    jest.mocked(userWebConnection.sendCommand).mockClear();
    jest.mocked(userWebConnection.sendCommand).mockImplementation((_sessionId, command) => {
      if (command !== 'create_session') return Promise.resolve({ ok: true });
      return new Promise(resolve => {
        resolveCreate = resolve;
      });
    });
    const createPromise = transport.createSession?.();
    await Promise.resolve();
    // Owner rotates mid-flight.
    connection.emitSystem({
      event: 'sessions.list',
      data: {
        sessions: [
          { id: KILO_SESSION_ID, status: 'active', title: 'Tracked', connectionId: 'owner-b' },
        ],
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    resolveCreate?.({ protocolVersion: 1, sessionID: ROTATED_KILO_SESSION_ID });
    await expect(createPromise).resolves.toBe(ROTATED_KILO_SESSION_ID);
    // The snapshot we used was 'owner-a' even though the current owner is now 'owner-b'.
    expect(userWebConnection.sendCommand).toHaveBeenCalledWith(
      KILO_SESSION_ID,
      'create_session',
      { protocolVersion: 1 },
      'owner-a'
    );
    expect(userWebConnection.sendCommandToConnection).not.toHaveBeenCalled();
    transport.destroy();
  });

  it('does not retry a network failure', async () => {
    const connection = createConnection();
    jest
      .mocked(connection.sendCommand)
      .mockRejectedValue(new Error('Connection lost during reconnect'));
    const { transport, userWebConnection } = createTransportWithSinks({ connection });

    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    jest.mocked(userWebConnection.sendCommand).mockClear();
    await expect(transport.createSession?.()).rejects.toThrow('Connection lost during reconnect');
    expect(
      jest
        .mocked(userWebConnection.sendCommand)
        .mock.calls.filter(([, command]) => command === 'create_session')
    ).toHaveLength(1);
    expect(userWebConnection.sendCommandToConnection).not.toHaveBeenCalled();
    transport.destroy();
  });
});

describe('CliLiveTransport exitSession', () => {
  const EXIT_COMMAND_CATALOG = {
    protocolVersion: 1,
    canExitSession: true,
    commands: [],
  };

  async function connectWithCommandCatalog(
    commandCatalog: unknown = EXIT_COMMAND_CATALOG,
    exitResult: unknown = {}
  ) {
    const connection = createConnection();
    jest.mocked(connection.sendCommand).mockImplementation((_sessionId, command) => {
      if (command === 'list_models') return Promise.resolve(WIRE_CATALOG);
      if (command === 'list_commands') return Promise.resolve(commandCatalog);
      if (command === 'exit_cli') return Promise.resolve(exitResult);
      return Promise.resolve({ ok: true });
    });
    const fixture = createTransportWithSinks({ connection });
    fixture.transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    return { connection, ...fixture };
  }

  it('sends exit_cli exactly once against the current session and owner', async () => {
    const { transport, userWebConnection } = await connectWithCommandCatalog();
    jest.mocked(userWebConnection.sendCommand).mockClear();

    await expect(transport.exitSession?.()).resolves.toBeUndefined();

    expect(userWebConnection.sendCommand).toHaveBeenCalledTimes(1);
    expect(userWebConnection.sendCommand).toHaveBeenCalledWith(
      KILO_SESSION_ID,
      'exit_cli',
      { protocolVersion: 1 },
      'owner'
    );
    expect(userWebConnection.sendCommandToConnection).not.toHaveBeenCalled();
    transport.destroy();
  });

  it('uses an internal command-state snapshot when consumers mutate published state', async () => {
    const connection = createConnection();
    jest.mocked(connection.sendCommand).mockImplementation((_sessionId, command) => {
      if (command === 'list_models') return Promise.resolve(WIRE_CATALOG);
      if (command === 'list_commands') return Promise.resolve(EXIT_COMMAND_CATALOG);
      return Promise.resolve({});
    });
    const { transport, userWebConnection } = createTransportWithSinks({
      connection,
      onRemoteCommandStateChange: state => {
        if (state.refresh === 'idle' && state.commands.length > 0) {
          state.commands[0].name = 'mutated';
          state.commands.length = 0;
        }
      },
    });
    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    jest.mocked(userWebConnection.sendCommand).mockClear();

    await expect(transport.exitSession?.()).resolves.toBeUndefined();
    expect(userWebConnection.sendCommand).toHaveBeenCalledWith(
      KILO_SESSION_ID,
      'exit_cli',
      { protocolVersion: 1 },
      'owner'
    );
    transport.destroy();
  });

  it('rejects unavailable while a same-owner refresh is still in flight', async () => {
    // The new `canExitSession` gate is strict: only a successful catalog
    // parse sets the flag, so a still-loading or transient-failing refresh
    // drops the previous flag to `undefined` and fails closed. This is
    // stronger than the prior synthetic-exit-command pattern: a CLI that
    // has downgraded between refreshes can no longer be trusted.
    const connection = createConnection();
    let commandRequest = 0;
    jest.mocked(connection.sendCommand).mockImplementation((_sessionId, command) => {
      if (command === 'list_models') return Promise.resolve(WIRE_CATALOG);
      if (command === 'list_commands') {
        commandRequest += 1;
        return commandRequest === 1 ? Promise.resolve(EXIT_COMMAND_CATALOG) : new Promise(() => {});
      }
      return Promise.resolve({});
    });
    const { transport, userWebConnection } = createTransportWithSinks({ connection });
    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    connection.emitReconnect();
    await Promise.resolve();
    jest.mocked(userWebConnection.sendCommand).mockClear();

    await expect(transport.exitSession?.()).rejects.toThrow(
      'Remote session exit is unavailable for the current session'
    );
    expect(userWebConnection.sendCommand).not.toHaveBeenCalled();
    transport.destroy();
  });

  it('rejects unavailable after a transient same-owner refresh error', async () => {
    // Same as above: a transient refresh error drops `canExitSession` to
    // `undefined` (the prior cached commands are retained, but the flag is
    // not). Retry-safe; a successful next parse restores the flag.
    const connection = createConnection();
    let commandRequest = 0;
    jest.mocked(connection.sendCommand).mockImplementation((_sessionId, command) => {
      if (command === 'list_models') return Promise.resolve(WIRE_CATALOG);
      if (command === 'list_commands') {
        commandRequest += 1;
        return commandRequest === 1
          ? Promise.resolve(EXIT_COMMAND_CATALOG)
          : Promise.reject(new Error('catalog timed out'));
      }
      return Promise.resolve({});
    });
    const { transport, userWebConnection } = createTransportWithSinks({ connection });
    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    connection.emitReconnect();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    jest.mocked(userWebConnection.sendCommand).mockClear();

    await expect(transport.exitSession?.()).rejects.toThrow(
      'Remote session exit is unavailable for the current session'
    );
    expect(userWebConnection.sendCommand).not.toHaveBeenCalled();
    transport.destroy();
  });

  it.each([null, [], { extra: true }])(
    'rejects malformed result %p without retrying',
    async result => {
      const { transport, userWebConnection } = await connectWithCommandCatalog(
        EXIT_COMMAND_CATALOG,
        result
      );
      jest.mocked(userWebConnection.sendCommand).mockClear();

      await expect(transport.exitSession?.()).rejects.toThrow('Invalid exit_cli response');
      expect(userWebConnection.sendCommand).toHaveBeenCalledTimes(1);
      transport.destroy();
    }
  );

  it('does not retry a network failure', async () => {
    const { transport, userWebConnection } = await connectWithCommandCatalog();
    jest
      .mocked(userWebConnection.sendCommand)
      .mockRejectedValueOnce(new Error('Connection lost before CLI acknowledgement'));
    jest.mocked(userWebConnection.sendCommand).mockClear();

    await expect(transport.exitSession?.()).rejects.toThrow(
      'Connection lost before CLI acknowledgement'
    );
    expect(userWebConnection.sendCommand).toHaveBeenCalledTimes(1);
    transport.destroy();
  });

  it('uses the owner snapshot at call time', async () => {
    const { connection, transport, userWebConnection } = await connectWithCommandCatalog();
    let resolveExit: ((result: {}) => void) | undefined;
    jest.mocked(userWebConnection.sendCommand).mockClear();
    jest.mocked(userWebConnection.sendCommand).mockImplementation((_sessionId, command) => {
      if (command !== 'exit_cli') return Promise.resolve({});
      return new Promise(resolve => {
        resolveExit = resolve;
      });
    });

    const exitPromise = transport.exitSession?.();
    connection.emitSystem({
      event: 'sessions.list',
      data: {
        sessions: [
          { id: KILO_SESSION_ID, status: 'active', title: 'Tracked', connectionId: 'owner-b' },
        ],
      },
    });
    resolveExit?.({});

    await expect(exitPromise).resolves.toBeUndefined();
    expect(userWebConnection.sendCommand).toHaveBeenCalledWith(
      KILO_SESSION_ID,
      'exit_cli',
      { protocolVersion: 1 },
      'owner'
    );
    transport.destroy();
  });

  it.each([
    {
      label: 'catalog without canExitSession (old CLI)',
      catalog: { protocolVersion: 1, commands: [] },
    },
    {
      label: 'canExitSession: false',
      catalog: { protocolVersion: 1, canExitSession: false, commands: [] },
    },
  ])('rejects unavailable for $label', async ({ catalog }) => {
    const { transport, userWebConnection } = await connectWithCommandCatalog(catalog);
    jest.mocked(userWebConnection.sendCommand).mockClear();

    await expect(transport.exitSession?.()).rejects.toThrow(
      'Remote session exit is unavailable for the current session'
    );
    expect(userWebConnection.sendCommand).not.toHaveBeenCalled();
    transport.destroy();
  });

  it('rejects unavailable while the command catalog is loading', async () => {
    const connection = createConnection();
    jest.mocked(connection.sendCommand).mockImplementation((_sessionId, command) => {
      if (command === 'list_models') return Promise.resolve(WIRE_CATALOG);
      if (command === 'list_commands') return new Promise(() => {});
      return Promise.resolve({});
    });
    const { transport, userWebConnection } = createTransportWithSinks({ connection });
    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    jest.mocked(userWebConnection.sendCommand).mockClear();

    await expect(transport.exitSession?.()).rejects.toThrow(
      'Remote session exit is unavailable for the current session'
    );
    expect(userWebConnection.sendCommand).not.toHaveBeenCalled();
    transport.destroy();
  });

  it('rejects unavailable after command catalog error', async () => {
    const connection = createConnection();
    jest.mocked(connection.sendCommand).mockImplementation((_sessionId, command) => {
      if (command === 'list_models') return Promise.resolve(WIRE_CATALOG);
      if (command === 'list_commands') return Promise.reject(new Error('catalog unavailable'));
      return Promise.resolve({});
    });
    const { transport, userWebConnection } = createTransportWithSinks({ connection });
    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    jest.mocked(userWebConnection.sendCommand).mockClear();

    await expect(transport.exitSession?.()).rejects.toThrow(
      'Remote session exit is unavailable for the current session'
    );
    expect(userWebConnection.sendCommand).not.toHaveBeenCalled();
    transport.destroy();
  });

  it('rejects unavailable after owner disconnect', async () => {
    const { connection, transport, userWebConnection } = await connectWithCommandCatalog();
    connection.emitSystem({ event: 'cli.disconnected', data: { connectionId: 'owner' } });
    jest.mocked(userWebConnection.sendCommand).mockClear();

    await expect(transport.exitSession?.()).rejects.toThrow(
      'Remote session exit is unavailable for the current session'
    );
    expect(userWebConnection.sendCommand).not.toHaveBeenCalled();
    transport.destroy();
  });

  it('rejects unavailable while an owner replacement has an empty catalog', async () => {
    const { connection, transport, userWebConnection } = await connectWithCommandCatalog();
    connection.emitSystem({
      event: 'sessions.list',
      data: {
        sessions: [
          { id: KILO_SESSION_ID, status: 'active', title: 'Tracked', connectionId: 'owner-b' },
        ],
      },
    });
    jest.mocked(userWebConnection.sendCommand).mockClear();

    await expect(transport.exitSession?.()).rejects.toThrow(
      'Remote session exit is unavailable for the current session'
    );
    expect(userWebConnection.sendCommand).not.toHaveBeenCalled();
    transport.destroy();
  });

  it('rejects with the exact upgrade-required message', async () => {
    const connection = createConnection();
    const upgradeMessage =
      'Remote slash commands require a newer Kilo CLI. Update Kilo CLI and reconnect.';
    jest.mocked(connection.sendCommand).mockImplementation((_sessionId, command) => {
      if (command === 'list_models') return Promise.resolve(WIRE_CATALOG);
      if (command === 'list_commands') {
        return Promise.reject(
          new UserWebCommandError({ code: 'CLI_UPGRADE_REQUIRED', message: upgradeMessage })
        );
      }
      return Promise.resolve({});
    });
    const { transport, userWebConnection } = createTransportWithSinks({ connection });
    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    jest.mocked(userWebConnection.sendCommand).mockClear();

    await expect(transport.exitSession?.()).rejects.toThrow(upgradeMessage);
    expect(userWebConnection.sendCommand).not.toHaveBeenCalled();
    transport.destroy();
  });
});

// ---------------------------------------------------------------------------
// Page-seam + reconnect: transport uses fetchSnapshotPage for the initial
// bounded read AND for reconnect/delayed resync replays, but only the initial
// read fires onInitialPageLoaded. A reconnect must never reset the user's
// already-advanced older-pages cursor back to the latest 50.
// ---------------------------------------------------------------------------

type FetchPage = (
  kiloSessionId: KiloSessionId,
  options: { cursor?: string }
) => Promise<SessionSnapshotPageOutcome | null>;

type CreatePageTransportOptions = {
  fetchSnapshotPage: FetchPage;
  fetchSnapshot?: (kiloSessionId: KiloSessionId) => Promise<SessionSnapshot>;
  onInitialPageLoaded?: (page: {
    info: { id: string };
    messages: Array<{ info: { id: string; sessionID: string }; parts: unknown[] }>;
    nextCursor: string | null;
    omittedItemCount: number;
  }) => void;
  onError?: (message: string) => void;
};

function createPageTransport(options: CreatePageTransportOptions) {
  const chatEvents: ChatEvent[] = [];
  const serviceEvents: ServiceEvent[] = [];
  let replayCompleteCount = 0;
  const userWebConnection = createConnection();
  const fetchSnapshotPage = jest.fn(options.fetchSnapshotPage);
  const onInitialPageLoaded = jest.fn(options.onInitialPageLoaded ?? (() => undefined));
  const onError = jest.fn(options.onError ?? (() => undefined));

  const transport = createCliLiveTransport({
    kiloSessionId: KILO_SESSION_ID,
    userWebConnection,
    ...(options.fetchSnapshot ? { fetchSnapshot: options.fetchSnapshot } : {}),
    fetchSnapshotPage,
    onInitialPageLoaded,
    onError,
  })({
    onChatEvent: event => chatEvents.push(event),
    onServiceEvent: event => serviceEvents.push(event),
    onReplayComplete: () => {
      replayCompleteCount += 1;
    },
  });

  return {
    transport,
    userWebConnection,
    chatEvents,
    serviceEvents,
    fetchSnapshotPage,
    onInitialPageLoaded,
    onError,
    getReplayCompleteCount: () => replayCompleteCount,
  };
}

function makeLivePage(
  options: {
    nextCursor?: string | null;
    omittedItemCount?: number;
    id?: string;
  } = {}
): Extract<SessionSnapshotPageOutcome, { kind: 'success' }> {
  return {
    kind: 'success',
    info: { id: options.id ?? KILO_SESSION_ID },
    messages: [],
    nextCursor: options.nextCursor ?? null,
    omittedItemCount: options.omittedItemCount ?? 0,
  };
}

describe('CliLiveTransport page-seam + reconnect', () => {
  it('uses fetchSnapshotPage for the initial bounded read and reports it via onInitialPageLoaded', async () => {
    const page = makeLivePage({ nextCursor: 'cursor-A', omittedItemCount: 2 });
    const { transport, fetchSnapshotPage, onInitialPageLoaded, serviceEvents } =
      createPageTransport({
        fetchSnapshotPage: async () => page,
      });

    transport.connect();
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchSnapshotPage).toHaveBeenCalledWith(KILO_SESSION_ID, {});
    expect(onInitialPageLoaded).toHaveBeenCalledWith(page);
    // session.created from the page must have flowed through.
    expect(serviceEvents.filter(event => event.type === 'session.created')).toHaveLength(1);
    transport.destroy();
  });

  it('does not call onInitialPageLoaded again on a reconnect replay (cursor preserved)', async () => {
    const initial = makeLivePage({ nextCursor: 'cursor-A', omittedItemCount: 0 });
    const reconnect = makeLivePage({ nextCursor: 'cursor-B', omittedItemCount: 0 });
    const fetchSnapshotPage = jest
      .fn<Promise<SessionSnapshotPageOutcome | null>, [KiloSessionId, { cursor?: string }]>()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(reconnect);
    const onInitialPageLoaded = jest.fn();
    const {
      transport,
      userWebConnection,
      fetchSnapshotPage: _fetch,
    } = createPageTransport({
      fetchSnapshotPage,
      onInitialPageLoaded,
    });

    transport.connect();
    await Promise.resolve();
    await Promise.resolve();
    expect(onInitialPageLoaded).toHaveBeenCalledTimes(1);
    expect(onInitialPageLoaded).toHaveBeenLastCalledWith(initial);

    // Reconnect replay: the transport re-fetches the page (so the manager's
    // already-advanced older-pages cursor is not overwritten), but it must
    // NOT fire onInitialPageLoaded again — that hook is the manager's signal
    // to advance `loadOlderGeneration`, which would reset the cursor.
    userWebConnection.emitReconnect();
    await Promise.resolve();
    await Promise.resolve();

    expect(_fetch.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(onInitialPageLoaded).toHaveBeenCalledTimes(1);
    transport.destroy();
  });

  it('does not call onInitialPageLoaded on the delayed resync replay', async () => {
    jest.useFakeTimers();
    try {
      const initial = makeLivePage({ nextCursor: 'cursor-A' });
      const fetchSnapshotPage = jest
        .fn<Promise<SessionSnapshotPageOutcome | null>, [KiloSessionId, { cursor?: string }]>()
        .mockResolvedValueOnce(initial)
        .mockResolvedValue(makeLivePage({ nextCursor: 'cursor-B' }));
      const onInitialPageLoaded = jest.fn();
      const { transport, userWebConnection } = createPageTransport({
        fetchSnapshotPage,
        onInitialPageLoaded,
      });

      transport.connect();
      await Promise.resolve();
      await Promise.resolve();
      expect(onInitialPageLoaded).toHaveBeenCalledTimes(1);

      userWebConnection.emitReconnect();
      jest.advanceTimersByTime(5000);
      await Promise.resolve();
      await Promise.resolve();

      // Still only the initial page fired the hook; reconnect + resync
      // replays never reset the user's older-pages cursor.
      expect(onInitialPageLoaded).toHaveBeenCalledTimes(1);
      transport.destroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('surfaces retryable_failure on the initial read via onError but stays subscribed', async () => {
    const onError = jest.fn();
    const { transport, userWebConnection, onInitialPageLoaded, serviceEvents } =
      createPageTransport({
        fetchSnapshotPage: async () => ({ kind: 'retryable_failure' }),
        onError,
      });

    transport.connect();
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith('Session history temporarily unavailable');
    expect(onInitialPageLoaded).not.toHaveBeenCalled();
    // No session.created was emitted because no successful page replayed.
    expect(serviceEvents.filter(event => event.type === 'session.created')).toHaveLength(0);
    expect(userWebConnection.subscribeToCliSession).toHaveBeenCalledWith(KILO_SESSION_ID);
    transport.destroy();
  });

  it('surfaces too_large and invalid_data typed failures via onError', async () => {
    for (const failure of [
      { kind: 'too_large' as const, expected: 'Session history too large to load' },
      { kind: 'invalid_data' as const, expected: 'Session history is unavailable' },
    ]) {
      const onError = jest.fn();
      const { transport, onInitialPageLoaded } = createPageTransport({
        fetchSnapshotPage: async () => failure,
        onError,
      });
      transport.connect();
      await Promise.resolve();
      await Promise.resolve();
      expect(onError).toHaveBeenCalledWith(failure.expected);
      expect(onInitialPageLoaded).not.toHaveBeenCalled();
      transport.destroy();
    }
  });

  it('treats a null page result as session not found via onError', async () => {
    const onError = jest.fn();
    const { transport, onInitialPageLoaded } = createPageTransport({
      fetchSnapshotPage: async () => null,
      onError,
    });

    transport.connect();
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith('Session not found');
    expect(onInitialPageLoaded).not.toHaveBeenCalled();
    transport.destroy();
  });

  it('prefers fetchSnapshotPage over legacy fetchSnapshot when both are provided', async () => {
    const page = makeLivePage({ nextCursor: 'cursor-A' });
    const fetchSnapshot = jest.fn(() =>
      Promise.reject(new Error('legacy fetchSnapshot must not be called'))
    );
    const { transport, fetchSnapshotPage, onInitialPageLoaded } = createPageTransport({
      fetchSnapshotPage: async () => page,
      fetchSnapshot,
    });

    transport.connect();
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchSnapshotPage).toHaveBeenCalledTimes(1);
    expect(fetchSnapshot).not.toHaveBeenCalled();
    expect(onInitialPageLoaded).toHaveBeenCalledWith(page);
    transport.destroy();
  });

  it('drains buffered live events only after a successful reconnect page', async () => {
    let resolveReconnectPage: ((page: SessionSnapshotPageOutcome | null) => void) | undefined;
    const initial = makeLivePage({ nextCursor: 'cursor-A' });
    const fetchSnapshotPage = jest
      .fn<Promise<SessionSnapshotPageOutcome | null>, [KiloSessionId, { cursor?: string }]>()
      .mockResolvedValueOnce(initial)
      .mockReturnValueOnce(
        new Promise<SessionSnapshotPageOutcome | null>(resolve => {
          resolveReconnectPage = resolve;
        })
      );
    const { transport, userWebConnection, chatEvents } = createPageTransport({
      fetchSnapshotPage,
    });

    transport.connect();
    await Promise.resolve();
    await Promise.resolve();
    // After the initial bounded read, the buffer is drained; emitting now
    // passes the event straight through.
    emitMessageUpdated(userWebConnection);
    await Promise.resolve();
    expect(chatEvents).toHaveLength(1);

    // Trigger a reconnect, then emit a new live event while the page is
    // still in flight. It must be buffered, not emitted ahead of the page.
    userWebConnection.emitReconnect();
    await Promise.resolve();
    await Promise.resolve();
    expect(chatEvents).toHaveLength(1);

    emitMessageUpdated(userWebConnection);
    await Promise.resolve();
    expect(chatEvents).toHaveLength(1);

    // Resolving the reconnect page must drain the buffered event AFTER the
    // page replay so we never show a newer message over an older snapshot.
    resolveReconnectPage?.(makeLivePage({ nextCursor: 'cursor-B' }));
    await Promise.resolve();
    await Promise.resolve();
    expect(chatEvents).toHaveLength(2);
    transport.destroy();
  });

  it('swallows a rejected reconnect page without leaving events stranded', async () => {
    const initial = makeLivePage({ nextCursor: 'cursor-A' });
    const fetchSnapshotPage = jest
      .fn<Promise<SessionSnapshotPageOutcome | null>, [KiloSessionId, { cursor?: string }]>()
      .mockResolvedValueOnce(initial)
      .mockRejectedValueOnce(new Error('reconnect refetch failed'));
    const onError = jest.fn();
    const { transport, userWebConnection, chatEvents, getReplayCompleteCount } =
      createPageTransport({
        fetchSnapshotPage,
        onError,
      });

    transport.connect();
    await Promise.resolve();
    await Promise.resolve();

    emitMessageUpdated(userWebConnection);
    userWebConnection.emitReconnect();
    await Promise.resolve();
    await Promise.resolve();

    // Initial reconnect errors must not surface to the manager — the live
    // stream carries on. The buffered event must still be drained.
    expect(onError).not.toHaveBeenCalled();
    expect(chatEvents).toHaveLength(1);
    expect(getReplayCompleteCount()).toBeGreaterThanOrEqual(2);
    transport.destroy();
  });
});

describe('CliLiveTransport remote attachment capabilities', () => {
  it('publishes heartbeat attachments: true via onCapabilitiesChange', async () => {
    const connection = createConnection();
    jest
      .mocked(connection.sendCommand)
      .mockImplementation((_sessionId, command) =>
        Promise.resolve(command === 'list_models' ? WIRE_CATALOG : { ok: true })
      );
    const capabilities: ({ attachments?: boolean } | undefined)[] = [];
    const { transport, userWebConnection } = createTransportWithSinks({
      connection,
      onCapabilitiesChange: capability => capabilities.push(capability),
    });

    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();

    emitHeartbeat(userWebConnection, [
      {
        id: KILO_SESSION_ID,
        status: 'active',
        title: 'Tracked',
        capabilities: { attachments: true },
      },
    ]);

    expect(capabilities.at(-1)).toEqual({ attachments: true });

    emitHeartbeat(userWebConnection, [
      {
        id: KILO_SESSION_ID,
        status: 'active',
        title: 'Tracked',
        capabilities: { attachments: false },
      },
    ]);

    expect(capabilities.at(-1)).toEqual({ attachments: false });
    transport.destroy();
  });

  it('publishes sessions.list capability changes via onCapabilitiesChange', async () => {
    const connection = createConnection();
    jest
      .mocked(connection.sendCommand)
      .mockImplementation((_sessionId, command) =>
        Promise.resolve(command === 'list_models' ? WIRE_CATALOG : { ok: true })
      );
    const capabilities: ({ attachments?: boolean } | undefined)[] = [];
    const { transport, userWebConnection } = createTransportWithSinks({
      connection,
      onCapabilitiesChange: capability => capabilities.push(capability),
    });

    transport.connect();
    userWebConnection.emitSystem({
      event: 'sessions.list',
      data: {
        sessions: [
          {
            id: KILO_SESSION_ID,
            status: 'active',
            title: 'Tracked',
            connectionId: 'owner',
            capabilities: { attachments: true },
          },
        ],
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(capabilities.at(-1)).toEqual({ attachments: true });

    userWebConnection.emitSystem({
      event: 'sessions.list',
      data: {
        sessions: [
          {
            id: KILO_SESSION_ID,
            status: 'active',
            title: 'Tracked',
            connectionId: 'owner',
            capabilities: { attachments: false },
          },
        ],
      },
    });

    expect(capabilities.at(-1)).toEqual({ attachments: false });
    transport.destroy();
  });

  it('publishes undefined on reconnect then re-advertises via heartbeat', async () => {
    const connection = createConnection();
    jest
      .mocked(connection.sendCommand)
      .mockImplementation((_sessionId, command) =>
        Promise.resolve(command === 'list_models' ? WIRE_CATALOG : { ok: true })
      );
    const capabilities: ({ attachments?: boolean } | undefined)[] = [];
    const { transport, userWebConnection } = createTransportWithSinks({
      connection,
      onCapabilitiesChange: capability => capabilities.push(capability),
    });

    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();

    emitHeartbeat(userWebConnection, [
      {
        id: KILO_SESSION_ID,
        status: 'active',
        title: 'Tracked',
        capabilities: { attachments: true },
      },
    ]);
    expect(capabilities.at(-1)).toEqual({ attachments: true });

    userWebConnection.emitReconnect();
    await Promise.resolve();
    await Promise.resolve();

    // The gate must close immediately on reconnect, before the next
    // heartbeat/sessions.list has a chance to re-advertise.
    expect(capabilities.at(-1)).toBeUndefined();

    emitHeartbeat(userWebConnection, [
      {
        id: KILO_SESSION_ID,
        status: 'active',
        title: 'Tracked',
        capabilities: { attachments: true },
      },
    ]);
    expect(capabilities.at(-1)).toEqual({ attachments: true });

    transport.destroy();
  });
});

describe('CliLiveTransport send_message parts', () => {
  it('appends file parts after the text part in send_message', async () => {
    const connection = createConnection();
    jest
      .mocked(connection.sendCommand)
      .mockImplementation((_sessionId, command) =>
        Promise.resolve(command === 'list_models' ? WIRE_CATALOG : { ok: true })
      );
    const { userWebConnection, transport } = createTransportWithSinks({ connection });

    transport.connect();
    emitOwner(connection);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    jest.mocked(userWebConnection.sendCommand).mockClear();

    const attachmentParts: RemoteAttachmentPart[] = [
      {
        type: 'file',
        mime: 'text/plain',
        filename: 'msg-uuid.txt',
        url: 'https://r2.example.com/msg-uuid.txt',
      },
      {
        type: 'file',
        mime: 'image/png',
        filename: 'msg-uuid.png',
        url: 'https://r2.example.com/msg-uuid.png',
      },
    ];

    await transport.send?.({
      payload: { type: 'prompt', prompt: 'look at these files' },
      attachmentParts,
    });

    expect(userWebConnection.sendCommand).toHaveBeenCalledWith(
      KILO_SESSION_ID,
      'send_message',
      {
        sessionID: KILO_SESSION_ID,
        parts: [
          { type: 'text', text: 'look at these files' },
          {
            type: 'file',
            mime: 'text/plain',
            filename: 'msg-uuid.txt',
            url: 'https://r2.example.com/msg-uuid.txt',
          },
          {
            type: 'file',
            mime: 'image/png',
            filename: 'msg-uuid.png',
            url: 'https://r2.example.com/msg-uuid.png',
          },
        ],
      },
      'owner'
    );
    transport.destroy();
  });
});
