import { createCloudAgentSession } from './session';
import { createConnection, type ConnectionConfig } from './cloud-agent-connection';
import { NativeSyncError, type NativeSyncClient, type NativeSessionState } from './native-sync';
import { createHostedNativeConversation } from './hosted-native-conversation';
import { createChatProcessor } from './chat-processor';
import { createMemoryStorage } from './storage/memory';
import { createServiceState } from './service-state';
import { readNativeConversation } from './native-conversation-source';
import { replayStoredMessages } from './snapshot-page';
import { cloudAgentId, kiloId } from './test-helpers';
import type { TransportSink, CloudAgentApi } from './transport';
import { createSessionManager } from './session-manager';
import { createStore } from 'jotai';
import { createUserWebConnection } from './user-web-connection';

jest.mock('./cloud-agent-connection', () => ({ createConnection: jest.fn() }));
const cloudConnection = {
  connect: jest.fn(),
  disconnect: jest.fn(),
  destroy: jest.fn(),
  retryReconnect: jest.fn(),
  recoverAfterSuccessfulMutation: jest.fn(),
};
let cloud: ConnectionConfig;
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(createConnection).mockImplementation(config => {
    cloud = config;
    return cloudConnection;
  });
});
const state = (): NativeSessionState => ({
  connection: 'connected',
  runnerConnected: true,
  liveAfterSeq: 3,
  session: {
    id: 'ses_native',
    origin: { directory: '/synthetic' },
    time: { created: 1, updated: 2 },
  },
  snapshot: { revision: 1, position: 3 },
  messages: [
    {
      seq: 1,
      message: {
        id: 'msg_a',
        type: 'user',
        text: 'Read this',
        time: { created: 1 },
        files: [
          {
            mime: 'image/png',
            data: 'aW1hZ2U=',
            name: 'synthetic.png',
            source: { type: 'inline' },
          },
        ],
      },
    },
    {
      seq: 2,
      message: {
        id: 'msg_b',
        type: 'assistant',
        time: { created: 2, completed: 3 },
        content: [
          { type: 'text', text: 'Before' },
          { type: 'reasoning', text: 'Thinking', time: { created: 2, completed: 3 } },
          {
            type: 'tool',
            id: 'call_tool',
            name: 'shell',
            state: { status: 'completed', input: { command: 'pwd' }, output: '/synthetic' },
          },
          { type: 'text', text: 'After' },
        ],
      },
    },
  ],
  pending: { questions: [], permissions: [], unreadablePermissions: [] },
  events: [],
  commands: {},
});
function fixture() {
  const storage = createMemoryStorage();
  const processor = createChatProcessor(storage);
  const services = createServiceState({ rootSessionId: 'ses_native' });
  const sink: TransportSink = {
    onChatEvent: event => {
      processor.process(event);
    },
    onServiceEvent: event => services.process(event),
  };
  return { storage, services, sink, adapter: createHostedNativeConversation(sink, 'ses_native') };
}
const rows = (storage: ReturnType<typeof createMemoryStorage>) =>
  storage
    .getMessageIds()
    .map(id => ({ info: storage.getMessageInfo(id), parts: storage.getParts(id) }));

test('the hosted adapter uses the existing projector and processor, including replacement and incomplete recovery', () => {
  const f = fixture();
  const native = state();
  f.adapter.updateNative(native);
  const baseline = createMemoryStorage();
  const processor = createChatProcessor(baseline);
  replayStoredMessages(readNativeConversation(native).messages, event => {
    processor.process(event);
  });
  expect(rows(f.storage)).toEqual(rows(baseline));
  f.adapter.updateNative(native);
  expect(rows(f.storage)).toEqual(rows(baseline));
  const incomplete = {
    ...native,
    messages: native.messages.map(message => ({ ...message, incomplete: true })),
  };
  expect(f.adapter.updateNative(incomplete).incompleteMessageIDs).toHaveLength(2);
  expect(rows(f.storage)).toEqual(rows(baseline));
  f.adapter.updateNative({ ...native, messages: native.messages.slice(0, 1) });
  expect(f.storage.getMessageIds()).toEqual(['msg_a']);
  f.adapter.updateNative(native);
  expect(rows(f.storage)).toEqual(rows(baseline));
});

test('current native interactions win over stale Cloud updates; offline and reconnect use one authority', () => {
  const f = fixture();
  const fallback = {
    questions: [
      {
        id: 'cloud-question',
        questions: [{ header: 'Cloud', question: 'Continue?', options: [] }],
      },
    ],
    permissions: [
      { id: 'cloud-permission', permission: 'bash', patterns: ['cloud'], metadata: {}, always: [] },
    ],
  };
  f.adapter.updateCloud({ type: 'cloud.interactions', pendingInteractions: fallback });
  expect(f.services.getQuestion()?.requestId).toBe('cloud-question');
  const native = state();
  native.pending.questions = [
    {
      id: 'native-question',
      metadata: { kind: 'question' },
      fields: [{ type: 'text', key: 'answer', title: 'Native' }],
    },
  ];
  native.pending.permissions = [
    {
      id: 'native-permission',
      action: 'shell',
      resources: ['/synthetic/**'],
      metadata: { synthetic: true },
      save: ['/synthetic/**'],
    },
  ];
  const frame = {
    v: 1 as const,
    channel: 'events' as const,
    seq: 4,
    at: 4,
    from: 'runner',
    type: 'remote.state',
    body: { incarnation: 'current-runner', runID: 'current-run', running: true },
  };
  native.events = [frame];
  f.adapter.updateNative(native);
  expect(f.services.getQuestion()?.requestId).toBe('native-question');
  expect(f.services.getPermission()).toMatchObject({
    requestId: 'native-permission',
    permission: 'bash',
    patterns: ['/synthetic/**'],
    always: ['/synthetic/**'],
  });
  f.adapter.updateCloud({
    type: 'cloud.interactions',
    pendingInteractions: { questions: [], permissions: [] },
  });
  expect(f.services.getQuestion()?.requestId).toBe('native-question');
  expect(f.services.getPermission()?.requestId).toBe('native-permission');
  f.sink.onServiceEvent({ type: 'connected' });
  f.adapter.updateCloud({
    type: 'connected',
    pendingInteractions: { questions: [], permissions: [] },
  });
  expect(f.services.getQuestion()?.requestId).toBe('native-question');
  f.adapter.updateCloud({ type: 'cloud.interactions', pendingInteractions: fallback });
  f.adapter.updateNative({ ...native, runnerConnected: false });
  expect(f.services.getQuestion()?.requestId).toBe('cloud-question');
  expect(f.services.getPermission()?.requestId).toBe('cloud-permission');
  f.adapter.updateNative({ ...native, liveAfterSeq: 4 });
  expect(f.services.getQuestion()?.requestId).toBe('cloud-question');
  f.adapter.updateNative({ ...native, events: [{ ...frame, seq: 5 }] });
  expect(f.services.getQuestion()?.requestId).toBe('native-question');
  const current = { ...native, liveAfterSeq: 5, events: [{ ...frame, seq: 5 }] };
  f.adapter.updateNative({ ...current, error: 'Synthetic replay gap' });
  expect(f.services.getQuestion()?.requestId).toBe('cloud-question');
  f.adapter.updateNative({
    ...current,
    events: [{ ...frame, seq: 6 }],
    pending: { questions: [], permissions: [], unreadablePermissions: [] },
  });
  expect(f.services.getQuestion()).toBeNull();
  expect(f.services.getPermission()).toBeNull();
});

test('stored hosted factory keeps Cloud and native cursors separate and delegates every write to Cloud', async () => {
  let nativeListener: ((state: NativeSessionState) => void) | undefined;
  const nativeClose = jest.fn();
  const connectSession = jest.fn((_id: string, listener: (state: NativeSessionState) => void) => {
    nativeListener = listener;
    return { close: nativeClose };
  });
  const api: CloudAgentApi = {
    send: jest.fn(async () => ({})),
    interrupt: jest.fn(async () => ({})),
    answer: jest.fn(async () => ({})),
    reject: jest.fn(async () => ({})),
    respondToPermission: jest.fn(async () => ({})),
    cancelQueuedMessage: jest.fn(async () => ({ dropped: true })),
  };
  const error = jest.fn();
  const session = createCloudAgentSession({
    kiloSessionId: kiloId('ses_native'),
    resolveSession: async kiloSessionId => ({
      type: 'hosted-native',
      kiloSessionId,
      cloudAgentSessionId: cloudAgentId('workspace_synthetic'),
    }),
    websocketBaseUrl: 'wss://cloud.test',
    onError: error,
    transport: {
      api,
      getTicket: async () => 'synthetic-ticket',
      nativeSyncClient: { connectSession } as unknown as NativeSyncClient,
    },
  });
  session.connect();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  nativeListener?.(state());
  cloud.onEvent({
    eventId: 1000,
    cursor: 1000,
    sessionId: 'workspace_synthetic',
    timestamp: new Date().toISOString(),
    streamEventType: 'connected',
    data: {},
  });
  nativeListener?.({ ...state(), snapshot: { position: 4, revision: 2 } });
  const url = new URL(
    typeof cloud.websocketUrl === 'function' ? cloud.websocketUrl() : cloud.websocketUrl
  );
  expect(url.searchParams.get('afterCursor')).toBe('1000');
  expect(url.searchParams.get('eventTypes')).not.toContain('kilocode');
  expect(session.storage.getMessageIds()).toEqual(['msg_a', 'msg_b']);
  await session.send({
    messageId: 'msg_cloud',
    payload: {
      type: 'prompt',
      prompt: 'Cloud write',
      mode: 'code',
      model: { providerID: 'kilo', modelID: 'synthetic/model' },
    },
  });
  await session.interrupt();
  await session.answer({ requestId: 'question', answers: [['yes']] });
  await session.reject({ requestId: 'question' });
  await session.respondToPermission({ requestId: 'permission', response: 'once' });
  await session.cancelQueuedMessage('queued');
  expect(api.send).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId: 'workspace_synthetic', messageId: 'msg_cloud' })
  );
  expect(api.interrupt).toHaveBeenCalledTimes(1);
  expect(api.answer).toHaveBeenCalledTimes(1);
  expect(api.reject).toHaveBeenCalledTimes(1);
  expect(api.respondToPermission).toHaveBeenCalledTimes(1);
  expect(api.cancelQueuedMessage).toHaveBeenCalledTimes(1);
  session.destroy();
  expect(nativeClose).toHaveBeenCalledTimes(1);
});

test('a known incompatible Cloud bootstrap failure settles loading without a transport switch', async () => {
  const nativeClose = jest.fn();
  let listener: ((state: NativeSessionState) => void) | undefined;
  const connectSession = jest.fn((_id: string, publish: (state: NativeSessionState) => void) => {
    listener = publish;
    return { close: nativeClose };
  });
  const onError = jest.fn();
  const session = createCloudAgentSession({
    kiloSessionId: kiloId('ses_native'),
    resolveSession: async kiloSessionId => ({
      type: 'hosted-native',
      kiloSessionId,
      cloudAgentSessionId: cloudAgentId('workspace_synthetic'),
    }),
    websocketBaseUrl: 'wss://cloud.test',
    onError,
    transport: {
      nativeSyncClient: { connectSession } as unknown as NativeSyncClient,
      getTicket: async () => 'ticket',
      api: {} as CloudAgentApi,
    },
  });
  session.connect();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  listener?.({
    ...state(),
    snapshot: undefined,
    error: 'session_not_found',
    failure: new NativeSyncError('session_not_found', 404),
  });
  expect(onError).not.toHaveBeenCalled();
  cloud.onEvent({
    eventId: 0,
    sessionId: 'workspace_synthetic',
    timestamp: new Date().toISOString(),
    streamEventType: 'connected',
    data: { cloudStatus: { type: 'error', message: 'invalid_configuration' } },
  });
  expect(onError).toHaveBeenCalledWith(
    'The hosted runtime could not start. Send a new message to retry.'
  );
  expect(nativeClose).toHaveBeenCalledTimes(1);
  expect(connectSession).toHaveBeenCalledTimes(1);
  session.destroy();
});

test('real manager and hosted factory retain Cloud metadata without any Cloud transcript reader or cached cursor', async () => {
  const store = createStore();
  const cloudAgentSessionId = cloudAgentId('workspace_synthetic');
  const kiloSessionId = kiloId('ses_native');
  const fetchCloudSnapshotPage = jest.fn();
  const fetchSnapshotPage = jest.fn();
  const readCachedSnapshotPage = jest.fn();
  const fetchSession = jest.fn();
  const manager = createSessionManager({
    store,
    websocketBaseUrl: 'wss://cloud.test',
    userWebConnection: createUserWebConnection({
      websocketUrl: 'wss://ingest.test',
      getAuthToken: async () => 'ticket',
    }),
    nativeSyncClient: { connectSession: () => ({ close() {} }) } as unknown as NativeSyncClient,
    resolveSession: async () => ({
      type: 'hosted-native',
      kiloSessionId,
      cloudAgentSessionId,
      organizationId: 'synthetic-organization',
    }),
    fetchCloudSession: async () => ({
      sessionId: cloudAgentSessionId,
      kiloSessionId,
      chat: { transport: 'relay' },
      title: 'Hosted title',
      orgId: 'synthetic-organization',
      githubRepo: 'synthetic/repository',
      branchName: 'synthetic-branch',
      model: 'synthetic/model',
      mode: 'code',
      profileId: 'synthetic-profile',
      totalCostMicrodollars: 123,
    }),
    fetchCloudSnapshotPage,
    fetchSnapshotPage,
    readCachedSnapshotPage,
    fetchSession,
    fetchSnapshot: jest.fn(),
    getTicket: async () => 'ticket',
    api: {} as CloudAgentApi,
    prepare: jest.fn(),
    initiate: jest.fn(),
  });
  await manager.switchSession(kiloSessionId);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(store.get(manager.atoms.fetchedSessionData)).toMatchObject({
    cloudAgentSessionId,
    kiloSessionId,
    title: 'Hosted title',
    organizationId: 'synthetic-organization',
    repository: 'synthetic/repository',
    gitBranch: 'synthetic-branch',
    model: 'synthetic/model',
    profileId: 'synthetic-profile',
    totalCostMicrodollars: 123,
  });
  expect(store.get(manager.atoms.activeSessionType)).toBe('cloud-agent');
  await manager.loadOlderMessages();
  expect(fetchCloudSnapshotPage).not.toHaveBeenCalled();
  expect(fetchSnapshotPage).not.toHaveBeenCalled();
  expect(readCachedSnapshotPage).not.toHaveBeenCalled();
  expect(fetchSession).not.toHaveBeenCalled();
  manager.destroy();
});
