import { createCloudAgentTransport } from './cloud-agent-transport';
import { createConnection, type ConnectionConfig } from './cloud-agent-connection';
import { cloudAgentId, kiloId } from './test-helpers';
import type { ServiceEvent } from './normalizer';

jest.mock('./cloud-agent-connection', () => ({ createConnection: jest.fn() }));
const native = {
  id: 'ses_root',
  location: { directory: '/workspace/app' },
  time: { created: 1, updated: 2 },
};
const empty = { sessionID: native.id, jobs: [], sessions: [{ id: native.id }], waits: [] };
let connection: ConnectionConfig;
beforeEach(() => {
  jest.useFakeTimers();
  jest.mocked(createConnection).mockImplementation(config => {
    connection = config;
    return {
      connect: () => config.onConnected(),
      disconnect() {},
      destroy() {},
      retryReconnect() {},
      recoverAfterSuccessfulMutation() {},
      socketPhase: () => 'absent' as const,
    };
  });
});
afterEach(() => jest.useRealTimers());

function pageFor(version: 'v1' | 'v2') {
  return {
    kind: 'success' as const,
    source: version === 'v2' ? { version, session: native } : { version },
    info: { id: native.id },
    messages: [],
    nextCursor: null,
    omittedItemCount: 0,
    updateCursor: 0,
  };
}

/** ES2022-safe deferred: this package's `lib` target predates `Promise.withResolvers`. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(
  version: 'v1' | 'v2' = 'v2',
  fetchCloudSnapshotPage: () => Promise<unknown> = async () => pageFor(version)
) {
  const events: ServiceEvent[] = [];
  const read = jest.fn().mockResolvedValue(empty);
  const transport = createCloudAgentTransport({
    sessionId: cloudAgentId('workspace_11111111-1111-4111-8111-111111111111'),
    kiloSessionId: kiloId(native.id),
    api: {
      getBackgroundActivity: read,
      send: async () => {},
      interrupt: async () => {},
      answer: async () => {},
      reject: async () => {},
      respondToPermission: async () => {},
    },
    getTicket: async () => 'local-ticket',
    websocketBaseUrl: 'ws://localhost:8794',
    fetchCloudSnapshotPage,
  })({ onChatEvent() {}, onServiceEvent: event => events.push(event) });
  return { transport, read, events };
}

test('reads v2 inventory on connect, shell lifecycle events, completion, and reconnect', async () => {
  const { transport, read, events } = setup();
  transport.connect();
  await jest.advanceTimersByTimeAsync(100);
  expect(read).toHaveBeenCalledTimes(1);
  connection.onEvent({
    eventId: 0,
    sessionId: 'workspace_11111111-1111-4111-8111-111111111111',
    streamEventType: 'kilocode',
    timestamp: '',
    data: {
      type: 'conversation.event',
      properties: {
        sessionID: native.id,
        source: { version: 'v2' },
        event: { id: 'evt_shell', type: 'session.shell.ended', data: { sessionID: native.id } },
      },
    },
  });
  await jest.advanceTimersByTimeAsync(1000);
  expect(read).toHaveBeenCalledTimes(2);
  connection.onEvent({
    eventId: 0,
    sessionId: 'workspace_11111111-1111-4111-8111-111111111111',
    streamEventType: 'kilocode',
    timestamp: '',
    data: {
      type: 'question.asked',
      properties: { id: 'question_local', sessionID: native.id, questions: [] },
    },
  });
  await jest.advanceTimersByTimeAsync(1000);
  expect(read).toHaveBeenCalledTimes(3);
  connection.onUnexpectedDisconnect?.();
  expect(events.at(-1)?.type === 'stopped' ? events.at(-2) : events.at(-1)).toMatchObject({
    type: 'background.activity',
    state: { status: 'inactive' },
  });
  connection.onReconnected?.();
  await jest.advanceTimersByTimeAsync(100);
  expect(read).toHaveBeenCalledTimes(4);
  transport.destroy();
});

test('streamed tool frames do not trigger inventory reads', async () => {
  const { transport, read } = setup();
  transport.connect();
  await jest.advanceTimersByTimeAsync(100);
  for (const type of ['session.tool.input.delta', 'session.tool.progress']) {
    connection.onEvent({
      eventId: 0,
      sessionId: 'workspace_11111111-1111-4111-8111-111111111111',
      streamEventType: 'kilocode',
      timestamp: '',
      data: {
        type: 'conversation.event',
        properties: {
          sessionID: native.id,
          source: { version: 'v2' },
          event: { id: `evt_${type}`, type, data: { sessionID: native.id } },
        },
      },
    });
  }
  await jest.advanceTimersByTimeAsync(2000);
  expect(read).toHaveBeenCalledTimes(1);
  transport.destroy();
});

test('leaves v1 chats unchanged', async () => {
  const { transport, read, events } = setup('v1');
  transport.connect();
  await jest.advanceTimersByTimeAsync(100);
  transport.destroy();
  expect(read).not.toHaveBeenCalled();
  expect(events.some(event => event.type === 'background.activity')).toBe(false);
});

test('destroy fences a late read from the previous chat', async () => {
  const { transport, read, events } = setup();
  let resolve!: (value: unknown) => void;
  read.mockImplementation(
    () =>
      new Promise(done => {
        resolve = done;
      })
  );
  transport.connect();
  await jest.advanceTimersByTimeAsync(100);
  transport.destroy();
  resolve(empty);
  await jest.advanceTimersByTimeAsync(100);
  expect(events.at(-1)).toMatchObject({
    type: 'background.activity',
    state: { status: 'inactive' },
  });
});

test('a v2 page that lands before the connection opens reads the inventory on connect', async () => {
  const { transport, read } = setup();
  transport.connect();
  // The page replays before `connectWebSocket`, so this flushes the page and
  // the ticket without reaching the reader's own timer.
  await jest.advanceTimersByTimeAsync(0);
  expect(read).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(100);
  expect(read).toHaveBeenCalledTimes(1);
  transport.destroy();
});

test('starts the reader when a v2 page lands after the connection opened', async () => {
  const retryPage = deferred<unknown>();
  let calls = 0;
  // The initial read fails so the socket opens without a page; the retry then
  // carries the v2 page, exactly the window in which a page used to enable the
  // readers without starting them.
  const { transport, read } = setup('v2', () => {
    calls += 1;
    return calls === 1 ? Promise.reject(new Error('history read failed')) : retryPage.promise;
  });
  transport.connect();
  await jest.advanceTimersByTimeAsync(500);
  expect(read).not.toHaveBeenCalled();
  retryPage.resolve(pageFor('v2'));
  await jest.advanceTimersByTimeAsync(100);
  expect(read).toHaveBeenCalledTimes(1);
  transport.destroy();
});

test('starts the reader when a v2 page lands after a reconnect', async () => {
  const reconnectPage = deferred<unknown>();
  let calls = 0;
  const { transport, read } = setup('v2', () => {
    calls += 1;
    return calls === 1 ? Promise.reject(new Error('history read failed')) : reconnectPage.promise;
  });
  transport.connect();
  await jest.advanceTimersByTimeAsync(100);
  expect(read).not.toHaveBeenCalled();
  connection.onUnexpectedDisconnect?.();
  // The reconnect supersedes the armed retry and reads its own page.
  connection.onReconnected?.();
  await jest.advanceTimersByTimeAsync(100);
  expect(read).not.toHaveBeenCalled();
  reconnectPage.resolve(pageFor('v2'));
  await jest.advanceTimersByTimeAsync(100);
  expect(read).toHaveBeenCalledTimes(1);
  transport.destroy();
});

test('holds a v2 page that lands while the socket is down until the next reconnect', async () => {
  const latePage = deferred<unknown>();
  let calls = 0;
  const { transport, read, events } = setup('v2', () => {
    calls += 1;
    return calls === 1 ? Promise.reject(new Error('history read failed')) : latePage.promise;
  });
  transport.connect();
  await jest.advanceTimersByTimeAsync(100);
  connection.onUnexpectedDisconnect?.();
  // The armed retry fires while the socket is down and carries the v2 page.
  await jest.advanceTimersByTimeAsync(400);
  latePage.resolve(pageFor('v2'));
  await jest.advanceTimersByTimeAsync(1000);
  expect(read).not.toHaveBeenCalled();
  expect(
    events.some(
      event => event.type === 'background.activity' && event.state.status === 'unavailable'
    )
  ).toBe(false);
  connection.onReconnected?.();
  await jest.advanceTimersByTimeAsync(100);
  expect(read).toHaveBeenCalledTimes(1);
  transport.destroy();
});
