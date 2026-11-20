import { expect, test } from 'bun:test';
import { readKilo2AgentBoard } from './kilo2-board.js';
import type { Kilo2Api } from './kilo2-api.js';

const board = {
  ownerSessionID: 'ses_root',
  revision: 2,
  messages: [
    {
      id: 'board_1',
      timestamp: 1,
      from: 'ses_child',
      to: 'main',
      fromLabel: 'Inspect commands',
      type: 'RESULT',
      body: 'Done',
    },
  ],
  hasMore: false,
};

async function errorMessage(result: Promise<unknown>) {
  try {
    await result;
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function apiFor(output: unknown, requests: unknown[] = []): Kilo2Api {
  return {
    request: async (path, options) => {
      requests.push({ path, method: options?.method, body: options?.body });
      return { output };
    },
    data: async () => {
      throw new Error('Unexpected data read');
    },
  };
}

test('reads the newest board page through the board RPC at the session location', async () => {
  const requests: unknown[] = [];
  const result = await readKilo2AgentBoard(
    apiFor(board, requests),
    'ses_root',
    '/workspace/app',
    new AbortController().signal
  );
  expect(result).toEqual(board);
  expect(requests).toEqual([
    {
      path: '/api/rpc/kilocode.board/get?location[directory]=%2Fworkspace%2Fapp',
      method: 'POST',
      body: { input: { sessionID: 'ses_root', limit: 50 } },
    },
  ]);
});

test('refuses a board owned by another session', async () => {
  const read = readKilo2AgentBoard(
    apiFor({ ...board, ownerSessionID: 'ses_other' }),
    'ses_root',
    '/workspace/app',
    new AbortController().signal
  );
  expect(await errorMessage(read)).toBe('Board owner mismatch');
});

test('refuses an unreadable board', async () => {
  const read = readKilo2AgentBoard(
    apiFor({ ...board, messages: [{ id: 'board_1' }] }),
    'ses_root',
    '/workspace/app',
    new AbortController().signal
  );
  expect(await errorMessage(read)).not.toBe('');
});
