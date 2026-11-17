import { createStore } from 'jotai';
import { createConnection, type ConnectionConfig } from './cloud-agent-connection';
import { NativeSyncClient, NativeSyncError, type NativeSocket } from './native-sync';
import type { NativeSnapshot } from './native-sync-snapshot';
import { createSessionManager } from './session-manager';
import { createUserWebConnection } from './user-web-connection';
import { cloudAgentId, kiloId } from './test-helpers';

jest.mock('./cloud-agent-connection', () => ({ createConnection: jest.fn() }));
let cloud: ConnectionConfig;
class FixtureSocket implements NativeSocket {
  static sockets: FixtureSocket[] = [];
  readyState = 1;
  onopen: NativeSocket['onopen'] = null;
  onmessage: NativeSocket['onmessage'] = null;
  onclose: NativeSocket['onclose'] = null;
  onerror: NativeSocket['onerror'] = null;
  constructor(_url: string, _protocols: string[]) {
    FixtureSocket.sockets.push(this);
  }
  send(_data: string) {}
  close() {
    this.readyState = 3;
    this.onclose?.call(this as unknown as WebSocket, {} as CloseEvent);
  }
  frame(type: string, body: unknown, seq: number, channel = 'control') {
    this.onmessage?.call(
      this as unknown as WebSocket,
      {
        data: JSON.stringify({
          v: 1,
          type,
          body,
          seq,
          channel,
          from: 'synthetic-runner',
          at: Date.now(),
        }),
      } as MessageEvent
    );
  }
}
const sessionID = kiloId('ses_native');
const cloudID = cloudAgentId('workspace_synthetic');
const snapshot = (id = sessionID): NativeSnapshot => ({
  position: 0,
  revision: 1,
  entities: [],
  session: { id, origin: { directory: '/synthetic' }, time: { created: 1, updated: 2 } },
  messages: [
    {
      seq: 1,
      message: { id: 'msg_user', type: 'user', text: 'Synthetic request', time: { created: 1 } },
    },
    {
      seq: 2,
      message: {
        id: 'msg_assistant',
        type: 'assistant',
        time: { created: 2, completed: 3 },
        content: [{ type: 'text', text: 'Synthetic answer' }],
      },
    },
  ],
});
const pending = (id: string) => ({
  permissions: [],
  questions: [{ requestID: id, fields: [{ type: 'text', key: 'answer', title: id }] }],
});
const remote = (runID: string, id: string) => ({
  incarnation: 'synthetic-incarnation',
  runID,
  running: true,
  pending: pending(id),
});
const hello = (socket: FixtureSocket, seq: number) =>
  socket.frame(
    'hello',
    { runnerConnected: true, reauthAt: new Date(Date.now() + 60_000).toISOString() },
    seq
  );
async function flush() {
  for (let i = 0; i < 35; i++) await Promise.resolve();
}
function socket(index = 0) {
  const value = FixtureSocket.sockets[index];
  if (!value) throw new Error('Missing fixture socket');
  return value;
}
function cloudEvent(type: string, data: unknown) {
  cloud.onEvent({
    eventId: 0,
    streamEventType: type,
    data,
    sessionId: cloudID,
    timestamp: new Date().toISOString(),
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  FixtureSocket.sockets = [];
  jest.mocked(createConnection).mockImplementation(config => {
    cloud = config;
    return {
      connect() {},
      disconnect() {},
      destroy() {},
      retryReconnect() {},
      recoverAfterSuccessfulMutation() {},
    };
  });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

async function fixture(initial = snapshot()) {
  const client = new NativeSyncClient({
    baseUrl: 'https://sync.test',
    getGrant: async () => ({
      token: 'synthetic-grant',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    }),
    WebSocket: FixtureSocket,
    fetch: async () =>
      Response.json({
        ticket: 'synthetic-ticket',
        expiresAt: new Date(Date.now() + 90_000).toISOString(),
      }),
  });
  const read = jest.spyOn(client, 'getSnapshot').mockResolvedValue(initial);
  const store = createStore();
  const manager = createSessionManager({
    store,
    nativeSyncClient: client,
    websocketBaseUrl: 'wss://cloud.test',
    userWebConnection: createUserWebConnection({
      websocketUrl: 'wss://ingest.test',
      getAuthToken: async () => 'synthetic-ticket',
    }),
    resolveSession: async () => ({
      type: 'hosted-native',
      kiloSessionId: sessionID,
      cloudAgentSessionId: cloudID,
    }),
    fetchCloudSession: async () => ({
      sessionId: cloudID,
      kiloSessionId: sessionID,
      chat: { transport: 'relay' },
      mode: 'code',
      model: 'synthetic/model',
    }),
    fetchSession: jest.fn(),
    fetchSnapshot: jest.fn(),
    getTicket: async () => 'synthetic-ticket',
    prepare: jest.fn(),
    initiate: jest.fn(),
    api: {
      send: async () => ({}),
      interrupt: async () => ({}),
      answer: async () => ({}),
      reject: async () => ({}),
      respondToPermission: async () => ({}),
    },
  });
  await manager.switchSession(sessionID);
  await flush();
  return { manager, store, read };
}

test('disconnected native activity follows matched Cloud completion, not unrelated queued completion', async () => {
  const f = await fixture();
  try {
    cloudEvent('connected', { activeMessageId: 'active', sessionStatus: { type: 'busy' } });
    hello(socket(), 10);
    await flush();
    socket().frame('remote.state', remote('run_current', 'native-question'), 11, 'events');
    await flush();
    expect(f.store.get(f.manager.atoms.activity).type).toBe('busy');
    socket().close();
    await flush();
    cloudEvent('cloud.message.completed', { messageId: 'queued-other' });
    expect(f.store.get(f.manager.atoms.activity).type).toBe('busy');
    cloudEvent('cloud.message.completed', { messageId: 'active' });
    cloudEvent('cloud.interactions', { questions: [], permissions: [] });
    expect(f.store.get(f.manager.atoms.activity).type).toBe('idle');
  } finally {
    f.manager.destroy();
  }
});

test('bounded native recovery never latches a manager open error after a healthy revision', async () => {
  const initial = snapshot();
  initial.messages[1] = { ...initial.messages[1]!, incomplete: true };
  const f = await fixture(initial);
  try {
    cloudEvent('connected', { sessionStatus: { type: 'idle' } });
    hello(socket(), 10);
    await flush();
    f.read.mockResolvedValue({ ...snapshot(), revision: 2 });
    await jest.advanceTimersByTimeAsync(250);
    await flush();
    expect(f.store.get(f.manager.atoms.messagesList)).toHaveLength(2);
    expect(f.store.get(f.manager.atoms.error)).toBeNull();
    expect(f.store.get(f.manager.atoms.statusIndicator)).toBeNull();
  } finally {
    f.manager.destroy();
  }
});

test('Cloud completion cannot idle a current native run', async () => {
  const f = await fixture();
  try {
    cloudEvent('connected', { activeMessageId: 'active', sessionStatus: { type: 'busy' } });
    hello(socket(), 10);
    await flush();
    socket().frame('remote.state', remote('run_current', 'native-question'), 11, 'events');
    await flush();
    cloudEvent('cloud.message.completed', { messageId: 'active' });
    expect(f.store.get(f.manager.atoms.activity).type).toBe('busy');
    expect(f.store.get(f.manager.atoms.question)?.requestId).toBe('native-question');
  } finally {
    f.manager.destroy();
  }
});

test('exhausted reader recovery is visible and later recovery clears only its own indicator', async () => {
  const initial = snapshot();
  initial.messages[1] = { ...initial.messages[1]!, incomplete: true };
  const f = await fixture(initial);
  try {
    cloudEvent('connected', { sessionStatus: { type: 'idle' } });
    hello(socket(), 10);
    await flush();
    for (const delay of [250, 500, 1000, 2000]) {
      await jest.advanceTimersByTimeAsync(delay);
      await flush();
    }
    expect(f.store.get(f.manager.atoms.statusIndicator)).toMatchObject({
      type: 'error',
      message: expect.stringContaining('recovery is incomplete'),
    });
    expect(f.store.get(f.manager.atoms.error)).toBeNull();
    f.read.mockResolvedValue({ ...snapshot(), revision: 2 });
    socket().frame(
      'session.execution.succeeded',
      {
        syncPosition: 20,
        data: {
          id: 'evt_done',
          type: 'session.execution.succeeded',
          created: 20,
          data: { sessionID },
        },
      },
      11,
      'events'
    );
    await flush();
    expect(f.store.get(f.manager.atoms.statusIndicator)).toMatchObject({ type: 'error' });
    await jest.advanceTimersByTimeAsync(250);
    await flush();
    expect(f.store.get(f.manager.atoms.statusIndicator)).toBeNull();
    expect(f.store.get(f.manager.atoms.messagesList)).toHaveLength(2);
  } finally {
    f.manager.destroy();
  }
});

test('native recovery cannot clear an unrelated Cloud authorization failure', async () => {
  const initial = snapshot();
  initial.messages[1] = { ...initial.messages[1]!, incomplete: true };
  const f = await fixture(initial);
  try {
    cloudEvent('connected', { sessionStatus: { type: 'idle' } });
    hello(socket(), 10);
    await flush();
    cloud.onError?.({
      type: 'error',
      code: 'WS_AUTH_ERROR',
      message: 'Synthetic Cloud access denied',
    });
    f.read.mockResolvedValue({ ...snapshot(), revision: 2 });
    await jest.advanceTimersByTimeAsync(250);
    await flush();
    expect(f.store.get(f.manager.atoms.error)).toBe('Synthetic Cloud access denied');
    expect(f.store.get(f.manager.atoms.messagesList)).toHaveLength(2);
  } finally {
    f.manager.destroy();
  }
});

test.each([12, 13])(
  'historical decoded remote state at sequence %i cannot regain authority after hello 13',
  async seq => {
    const f = await fixture();
    try {
      cloudEvent('connected', {
        pendingInteractions: {
          questions: [{ id: 'cloud-current', questions: [] }],
          permissions: [],
        },
      });
      hello(socket(), 10);
      await flush();
      socket().frame('remote.state', remote('old-run', 'old-question'), 11, 'events');
      await flush();
      expect(f.store.get(f.manager.atoms.question)?.requestId).toBe('old-question');
      socket().close();
      await flush();
      await jest.advanceTimersByTimeAsync(2000);
      await flush();
      hello(socket(1), 13);
      await flush();
      socket(1).frame('remote.state', remote('old-run', 'old-question'), seq, 'events');
      await flush();
      expect(f.store.get(f.manager.atoms.question)?.requestId).toBe('cloud-current');
      socket(1).frame('remote.state', remote('new-run', 'fresh-question'), 14, 'events');
      await flush();
      expect(f.store.get(f.manager.atoms.question)?.requestId).toBe('fresh-question');
    } finally {
      f.manager.destroy();
    }
  }
);

test.each([12, 13])(
  'runner replacement retires replay at or below its existing sequence boundary %i',
  async seq => {
    const f = await fixture();
    try {
      cloudEvent('connected', {
        pendingInteractions: {
          questions: [{ id: 'cloud-current', questions: [] }],
          permissions: [],
        },
      });
      hello(socket(), 10);
      await flush();
      socket().frame('remote.state', remote('old-run', 'old-question'), 11, 'events');
      await flush();
      socket().frame('runner_status', { runnerConnected: false }, 11);
      await flush();
      socket().frame('runner_status', { runnerConnected: true }, 13);
      await flush();
      socket().frame('remote.state', remote('old-run', 'old-question'), seq, 'events');
      await flush();
      expect(f.store.get(f.manager.atoms.question)?.requestId).toBe('cloud-current');
      socket().frame('remote.state', remote('new-run', 'fresh-question'), 14, 'events');
      await flush();
      expect(f.store.get(f.manager.atoms.question)?.requestId).toBe('fresh-question');
      socket().frame('reset_required', { seq: 20 }, 20);
      await flush();
      socket().frame('remote.state', remote('old-run', 'old-question'), 20, 'events');
      await flush();
      expect(f.store.get(f.manager.atoms.question)?.requestId).toBe('cloud-current');
      socket().frame('remote.state', remote('new-run', 'fresh-question'), 21, 'events');
      await flush();
      expect(f.store.get(f.manager.atoms.question)?.requestId).toBe('fresh-question');
    } finally {
      f.manager.destroy();
    }
  }
);

test('failed child hydration keeps readable native history and the child execution error', async () => {
  const f = await fixture();
  const childID = kiloId('ses_child');
  try {
    const child = snapshot(childID);
    const assistant = child.messages[1];
    if (!assistant || assistant.message.type !== 'assistant')
      throw new Error('Missing child assistant fixture');
    child.messages[1] = {
      ...assistant,
      message: {
        ...assistant.message,
        content: [
          ...(assistant.message.content ?? []),
          {
            type: 'tool',
            id: 'synthetic-tool',
            name: 'shell',
            state: { status: 'completed', input: { command: 'pwd' }, output: '/synthetic' },
          },
        ],
      },
    };
    child.messages.push({
      seq: 3,
      message: {
        id: 'msg_idle',
        type: 'idle',
        time: { created: 4 },
        error: { type: 'provider.error', message: 'Synthetic child execution failed' },
      },
    });
    f.read.mockResolvedValue(child);
    await f.manager.hydrateChildSession(childID);
    const messages = f.store.get(f.manager.atoms.childMessages)(childID);
    expect(messages).toHaveLength(2);
    expect(messages.some(message => message.parts.some(part => part.type === 'tool'))).toBe(true);
    expect(f.store.get(f.manager.atoms.childSessionHydrationState)(childID)).toMatchObject({
      status: 'ready',
    });
    expect(f.store.get(f.manager.atoms.childSessionError)(childID)).toBe(
      'Synthetic child execution failed'
    );
  } finally {
    f.manager.destroy();
  }
});

test.each(['denied', 'incomplete', 'missing-metadata'])(
  'child hydration does not hide %s reader failures',
  async failure => {
    const f = await fixture();
    const childID = kiloId('ses_child');
    try {
      const child = snapshot(childID);
      if (failure === 'denied') f.read.mockRejectedValue(new NativeSyncError('forbidden', 403));
      else if (failure === 'incomplete') {
        child.messages[1] = { ...child.messages[1]!, incomplete: true };
        f.read.mockResolvedValue(child);
      } else f.read.mockResolvedValue({ ...child, session: undefined });
      await f.manager.hydrateChildSession(childID);
      expect(f.store.get(f.manager.atoms.childMessages)(childID)).toHaveLength(0);
      expect(f.store.get(f.manager.atoms.childSessionHydrationState)(childID)).toMatchObject({
        status: 'error',
      });
    } finally {
      f.manager.destroy();
    }
  }
);
