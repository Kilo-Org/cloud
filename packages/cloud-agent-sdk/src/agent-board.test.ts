import type { AgentBoard } from '@kilocode/session-ingest-contracts';
import { createAgentBoardReader, type AgentBoardState } from './agent-board';
import { createConversationSourceReader } from './conversation-source';
import type { CloudAgentEvent } from './cloud-conversation-schemas';

const board: AgentBoard = {
  ownerSessionID: 'ses_root',
  revision: 1,
  messages: [
    { id: 'board_1', timestamp: 1, from: 'ses_child', to: 'main', type: 'RESULT', body: 'Done' },
  ],
  hasMore: false,
};

describe('agent board reader', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function setup(read: jest.Mock) {
    const states: AgentBoardState[] = [];
    const reader = createAgentBoardReader({
      ownerSessionID: 'ses_root',
      read,
      publish: state => states.push(state),
    });
    return { reader, states };
  }

  test('reads on start and coalesces invalidations into one later read', async () => {
    const read = jest
      .fn()
      .mockResolvedValueOnce(board)
      .mockResolvedValue({ ...board, revision: 2 });
    const { reader, states } = setup(read);
    reader.start();
    await jest.advanceTimersByTimeAsync(100);
    expect(states).toEqual([{ status: 'current', board }]);
    for (let i = 0; i < 5; i++) reader.invalidate();
    await jest.advanceTimersByTimeAsync(500);
    expect(read).toHaveBeenCalledTimes(2);
    expect(states.at(-1)).toEqual({ status: 'current', board: { ...board, revision: 2 } });
    reader.stop();
  });

  test('keeps the last board when the runtime goes offline or a read fails', async () => {
    const read = jest
      .fn()
      .mockResolvedValueOnce(board)
      .mockResolvedValueOnce(null)
      .mockRejectedValue(new Error('unavailable'));
    const { reader, states } = setup(read);
    reader.start();
    await jest.advanceTimersByTimeAsync(100);
    reader.invalidate();
    await jest.advanceTimersByTimeAsync(500);
    reader.invalidate();
    await jest.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(6);
    expect(states).toEqual([{ status: 'current', board }]);
    reader.stop();
  });

  test('retries a failed read with backoff for about 15 seconds, then waits for a change', async () => {
    const notReady = new Error('not ready');
    const read = jest
      .fn()
      .mockRejectedValueOnce(notReady)
      .mockRejectedValueOnce(notReady)
      .mockRejectedValueOnce(notReady)
      .mockRejectedValueOnce(notReady)
      .mockResolvedValue(board);
    const { reader, states } = setup(read);
    reader.start();
    await jest.advanceTimersByTimeAsync(100 + 500 + 1000 + 2000);
    expect(read).toHaveBeenCalledTimes(4);
    expect(states).toEqual([]);
    await jest.advanceTimersByTimeAsync(4000);
    expect(read).toHaveBeenCalledTimes(5);
    expect(states).toEqual([{ status: 'current', board }]);

    read.mockReset().mockRejectedValue(new Error('unavailable'));
    reader.invalidate();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(6);
    reader.stop();
  });

  test('does not publish a board owned by another session', async () => {
    const read = jest.fn().mockResolvedValue({ ...board, ownerSessionID: 'ses_other' });
    const { reader, states } = setup(read);
    reader.start();
    await jest.advanceTimersByTimeAsync(5000);
    expect(states).toEqual([]);
    reader.stop();
  });

  test('stops reading after stop', async () => {
    const read = jest.fn().mockResolvedValue(board);
    const { reader } = setup(read);
    reader.start();
    reader.stop();
    reader.invalidate();
    await jest.advanceTimersByTimeAsync(5000);
    expect(read).not.toHaveBeenCalled();
  });
});

test('a native board change invalidates the board', () => {
  const raw: CloudAgentEvent = {
    eventId: 1,
    cursor: 1,
    sessionId: 'workspace_test',
    streamEventType: 'kilocode',
    timestamp: '2026-11-19T09:00:00Z',
    data: {
      type: 'conversation.event',
      properties: {
        sessionID: 'ses_root',
        source: { version: 'v2' },
        event: {
          id: 'evt_board',
          type: 'rpc.kilocode.board.changed',
          data: { sessionID: 'ses_root', revision: 2 },
        },
      },
    },
  };
  expect(createConversationSourceReader().read(raw).events).toEqual([
    { type: 'agent-board.invalidated' },
  ]);
});
