/**
 * Agent listing — `list_agents` request and parse.
 *
 * `list_agents` asks a CLI for the agents a session can run as, including the
 * project agents it loads from the target directory. Two scopes exist:
 *
 * - Connection scope (before a session exists): the CLI resolves an optional
 *   relative `directory` under its launch directory, the same way it resolves
 *   create_session's `directory`.
 * - Session scope: the CLI lists the agents of that session's directory.
 *
 * The helper never throws and never logs. It classifies every outcome so the
 * caller can distinguish a permanent "this CLI cannot answer" result
 * (`unsupported`) from a transient transport failure worth retrying
 * (`transport`).
 */
import { RETRYABLE_RELAY_CODES } from './instance-model-catalog';
import { listAgentsV1Schema } from './schemas';
import type { ListAgentsV1 } from './schemas';
import {
  CommandDeliveredError,
  UserWebCommandError,
  type UserWebConnection,
} from './user-web-connection';

export type { ListAgentsV1 } from './schemas';

/**
 * Delivered error strings that mean the CLI cannot serve this request at all:
 * an old CLI rejects the unknown command, and a newer CLI rejects a malformed
 * request body. Both repeat identically on retry.
 */
const UNSUPPORTED_DELIVERED_ERRORS = [
  'unknown command: list_agents',
  'invalid list_agents command',
];

export type ListAgentsTarget =
  | { connectionId: string; directory?: string }
  | { sessionId: string; ownerConnectionId?: string };

export type ListAgentsResult =
  | { ok: true; agents: ListAgentsV1['agents'] }
  | { ok: false; reason: 'unsupported' | 'invalid' }
  | { ok: false; reason: 'transport'; cause?: unknown };

/**
 * Request the agents of one CLI connection or one remote session, then
 * classify the outcome:
 *
 * - Resolved and schema-valid → `{ ok: true, agents }`.
 * - Resolved but outside the schema → `{ ok: false, reason: 'invalid' }`.
 * - Resolved but the parse throws unexpectedly → `{ ok: false, reason:
 *   'transport', cause }`; the parse never escapes the helper.
 * - Rejected with an old-CLI unknown-command or invalid-request string, a
 *   non-retryable relay code, or `CLI_UPGRADE_REQUIRED` → `{ ok: false,
 *   reason: 'unsupported' }`.
 * - Rejected with any other delivered string (including `failed to list
 *   agents` and `invalid list_agents directory`), a retryable relay code, or a
 *   transport-level failure → `{ ok: false, reason: 'transport', cause }`.
 */
export async function listAgents(
  connection: Pick<UserWebConnection, 'sendCommand' | 'sendCommandToConnection'>,
  target: ListAgentsTarget
): Promise<ListAgentsResult> {
  let raw: unknown;
  try {
    raw =
      'sessionId' in target
        ? await connection.sendCommand(
            target.sessionId,
            'list_agents',
            { protocolVersion: 1 },
            target.ownerConnectionId
          )
        : await connection.sendCommandToConnection({
            command: 'list_agents',
            data: {
              protocolVersion: 1,
              ...(target.directory ? { directory: target.directory } : {}),
            },
            expectedConnectionId: target.connectionId,
          });
  } catch (error) {
    if (error instanceof CommandDeliveredError) {
      return UNSUPPORTED_DELIVERED_ERRORS.includes(error.message)
        ? { ok: false, reason: 'unsupported' }
        : { ok: false, reason: 'transport', cause: error };
    }
    if (error instanceof UserWebCommandError) {
      return RETRYABLE_RELAY_CODES.has(error.code)
        ? { ok: false, reason: 'transport', cause: error }
        : { ok: false, reason: 'unsupported' };
    }
    return { ok: false, reason: 'transport', cause: error };
  }

  try {
    const parsed = listAgentsV1Schema.safeParse(raw);
    return parsed.success
      ? { ok: true, agents: parsed.data.agents }
      : { ok: false, reason: 'invalid' };
  } catch (error) {
    return { ok: false, reason: 'transport', cause: error };
  }
}
