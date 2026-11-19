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
const cloudSessionId = 'workspace_11111111-1111-4111-8111-111111111111';
const board = { ownerSessionID: native.id, revision: 0, messages: [], hasMore: false };
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
  const read = jest.fn().mockResolvedValue(board);
  const transport = createCloudAgentTransport({
    sessionId: cloudAgentId(cloudSessionId),
    kiloSessionId: kiloId(native.id),
    api: {
      getAgentBoard: read,
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

function nativeEvent(type: string) {
  connection.onEvent({
    eventId: 0,
    sessionId: cloudSessionId,
    streamEventType: 'kilocode',
    timestamp: '',
    data: {
      type: 'conversation.event',
      properties: {
        sessionID: native.id,
        source: { version: 'v2' },
        event: { id: `evt_${type}`, type, data: { sessionID: native.id, revision: 1 } },
      },
    },
  });
}

test('reads the v2 board on connect, on a board change, and on reconnect', async () => {
  const { transport, read, events } = setup();
  transport.connect();
  await jest.advanceTimersByTimeAsync(100);
  expect(read).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledWith(expect.objectContaining({ sessionId: cloudSessionId }));
  expect(events).toContainEqual({ type: 'agent-board.state', state: { status: 'current', board } });
  nativeEvent('session.text.delta');
  await jest.advanceTimersByTimeAsync(1000);
  expect(read).toHaveBeenCalledTimes(1);
  nativeEvent('rpc.kilocode.board.changed');
  await jest.advanceTimersByTimeAsync(500);
  expect(read).toHaveBeenCalledTimes(2);
  connection.onUnexpectedDisconnect?.();
  connection.onReconnected?.();
  await jest.advanceTimersByTimeAsync(100);
  expect(read).toHaveBeenCalledTimes(3);
  transport.destroy();
});

test('does not read a board for v1 chats', async () => {
  const { transport, read, events } = setup('v1');
  transport.connect();
  await jest.advanceTimersByTimeAsync(100);
  transport.destroy();
  expect(read).not.toHaveBeenCalled();
  expect(events.some(event => event.type === 'agent-board.state')).toBe(false);
});
