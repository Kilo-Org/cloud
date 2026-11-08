import { TRPCError } from '@trpc/server';

import type { SafeMessageResult } from './message-result.js';

/**
 * What a stored initial turn proves, as every reconciliation path reads it.
 *
 * `queued`, `running` and `completed` prove the turn was admitted and did not
 * end in a terminal failure, so its acknowledgement may be replayed. `failed`
 * and `interrupted` prove the turn was admitted and then died: replaying them
 * as work in progress hands back a dead session, and a later fresh admission
 * would double-admit the turn.
 */
export type StoredInitialTurnOutcome =
  | { type: 'admitted'; delivery: 'sent' | 'queued' }
  | { type: 'terminal-failure' };

export function classifyStoredInitialTurn(result: SafeMessageResult): StoredInitialTurnOutcome {
  if (result.status === 'failed' || result.status === 'interrupted') {
    return { type: 'terminal-failure' };
  }
  return { type: 'admitted', delivery: result.status === 'running' ? 'sent' : 'queued' };
}

/**
 * The typed non-retryable failure for an initial turn that was admitted and
 * then died. One owner, so the ledger create path and the prepared replay path
 * answer the same stored state the same way and the client clears its
 * operation key only once.
 */
export function initialTurnTerminalFailure(): TRPCError {
  return new TRPCError({ code: 'BAD_REQUEST', message: 'session_creation_failed' });
}
