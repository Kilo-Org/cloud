import { z } from 'zod';
import { AGENT_BOARD_PAGE_LIMIT, agentBoardSchema } from '../../../src/shared/agent-board.js';
import type { Kilo2Api } from './kilo2-api.js';
import { kilo2LocationQuery } from './kilo2-reads.js';

/** Reads the newest page of the shared agent board owned by a root session. */
export async function readKilo2AgentBoard(
  api: Kilo2Api,
  sessionID: string,
  directory: string,
  signal: AbortSignal
) {
  const result = z.object({ output: agentBoardSchema }).parse(
    await api.request(`/api/rpc/kilocode.board/get?${kilo2LocationQuery(directory)}`, {
      method: 'POST',
      body: { input: { sessionID, limit: AGENT_BOARD_PAGE_LIMIT } },
      signal,
    })
  );
  if (result.output.ownerSessionID !== sessionID) throw new Error('Board owner mismatch');
  return result.output;
}
