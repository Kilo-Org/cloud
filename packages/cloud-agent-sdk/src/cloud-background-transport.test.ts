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
    };
  });
});
afterEach(() => jest.useRealTimers());

function setup(version: 'v1' | 'v2' = 'v2') {
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
    fetchCloudSnapshotPage: async () => ({
      kind: 'success',
      source: version === 'v2' ? { version, session: native } : { version },
      info: { id: native.id },
      messages: [],
      nextCursor: null,
      omittedItemCount: 0,
      updateCursor: 0,
    }),
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
