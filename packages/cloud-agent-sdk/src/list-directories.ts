/**
 * Directory listing — connection-scoped `list_directories` request and strict
 * parse.
 *
 * `list_directories` is a connection-scoped viewer command sent on the user-web
 * socket. It lists one directory level beneath a CLI connection's launch
 * directory, resolving an optional `path` relative to that root. The success
 * body is parsed with the strict `listDirectoriesV1Schema`; anything outside
 * that envelope (unknown keys, an over-limit entry array, an empty or
 * over-length entry string, or protocol drift) fails closed as `invalid`.
 *
 * The helper never throws and never logs. It classifies every outcome so the
 * caller can distinguish a permanent "this CLI cannot answer" result
 * (`unsupported`) from a transient transport failure worth retrying
 * (`transport`).
 */
import { listDirectoriesV1Schema } from './schemas';
import type { ListDirectoriesV1 } from './schemas';
import {
  CommandDeliveredError,
  UserWebCommandError,
  type UserWebConnection,
} from './user-web-connection';

export type { ListDirectoriesV1 } from './schemas';

/**
 * Relay codes whose failure is transient for this connection. Every other
 * structured relay error repeats identically on retry, so it must not be
 * retried.
 */
const RETRYABLE_RELAY_CODES = new Set([
  'SESSION_OWNER_CHANGED',
  'CATALOG_REQUEST_PENDING',
  'COMMAND_EXPIRED',
  'PENDING_COMMAND_LIMIT',
]);

/**
 * Delivered error strings that mean the CLI cannot serve this command at all.
 * An old CLI rejects the unknown command before parsing the request, and a
 * newer CLI rejects a malformed request body. Both are permanent for this
 * command and must not be retried.
 */
const UNSUPPORTED_DELIVERED_ERRORS = new Set([
  'unknown command: list_directories',
  'invalid list_directories request',
]);

export type ListDirectoriesResult =
  | { ok: true; path: string; directories: ListDirectoriesV1['directories'] }
  | { ok: false; reason: 'unsupported' | 'invalid' | 'transport' };

/**
 * Request one directory level of a specific CLI connection.
 *
 * Sends one connection-scoped `list_directories` command with protocol version
 * 1 and an optional `path` (the CLI resolves it relative to its launch
 * directory), then classifies the outcome:
 *
 * - Resolved and schema-valid → `{ ok: true, path, directories }`.
 * - Resolved but outside the strict schema → `{ ok: false, reason: 'invalid' }`.
 * - Resolved but the strict parse throws unexpectedly → `{ ok: false,
 *   reason: 'transport' }`; the parse never escapes the helper.
 * - Rejected with an old-CLI unknown-command or invalid-request string, or a
 *   non-retryable relay code, or `CLI_UPGRADE_REQUIRED` → `{ ok: false,
 *   reason: 'unsupported' }`.
 * - Rejected with any other delivered string (including `failed to list
 *   directories` and `invalid list_directories path`), a retryable relay
 *   code, or a transport-level failure → `{ ok: false, reason: 'transport' }`.
 *
 * Never throws and never logs.
 */
export async function listDirectoriesOnConnection(
  connection: Pick<UserWebConnection, 'sendCommandToConnection'>,
  connectionId: string,
  path?: string
): Promise<ListDirectoriesResult> {
  let raw: unknown;
  try {
    raw = await connection.sendCommandToConnection({
      command: 'list_directories',
      data: { protocolVersion: 1, ...(path ? { path } : {}) },
      expectedConnectionId: connectionId,
    });
  } catch (error) {
    if (error instanceof CommandDeliveredError) {
      return UNSUPPORTED_DELIVERED_ERRORS.has(error.message)
        ? { ok: false, reason: 'unsupported' }
        : { ok: false, reason: 'transport' };
    }
    if (error instanceof UserWebCommandError) {
      return RETRYABLE_RELAY_CODES.has(error.code)
        ? { ok: false, reason: 'transport' }
        : { ok: false, reason: 'unsupported' };
    }
    return { ok: false, reason: 'transport' };
  }

  try {
    const parsed = listDirectoriesV1Schema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: 'invalid' };
    return { ok: true, path: parsed.data.path, directories: parsed.data.directories };
  } catch {
    return { ok: false, reason: 'transport' };
  }
}
