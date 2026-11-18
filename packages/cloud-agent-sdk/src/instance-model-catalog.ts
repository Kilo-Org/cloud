/**
 * Instance model catalog — sessionless `list_models` request and strict parse.
 *
 * `list_models` is a connection-scoped viewer command sent on the user-web
 * socket before a session exists. The wire request is deliberately bare:
 * `protocolVersion: 1` with no `sessionId` and no `mutationId` — a catalog read
 * is not a mutation and does not belong to a session. The success body is
 * parsed with the strict `remoteModelCatalogV1Schema`; anything outside that
 * envelope (unknown keys, protocol drift, or an over-limit serialized size)
 * fails closed as `invalid`.
 *
 * The helper never throws and never logs. It classifies every outcome so the
 * caller can distinguish a permanent "this CLI cannot answer" result
 * (`unsupported`) from a transient transport failure worth retrying
 * (`transport`).
 */
import { remoteModelCatalogV1Schema } from './schemas';
import type { RemoteModelCatalogV1 } from './schemas';
import {
  CommandDeliveredError,
  UserWebCommandError,
  type UserWebConnection,
} from './user-web-connection';

export type { RemoteModelCatalogV1 } from './schemas';

/**
 * Delivered error strings that mean the CLI cannot serve `list_models` at all:
 * an old CLI rejects the unknown command, and a newer CLI rejects a malformed
 * request body. Both repeat identically on retry.
 */
const UNSUPPORTED_DELIVERED_ERRORS = [
  'unknown command: list_models',
  'invalid list_models command',
];

/**
 * Relay codes whose failure is transient for this connection. Every other
 * structured relay error repeats identically on retry, so it must not be
 * retried.
 */
export const RETRYABLE_RELAY_CODES = new Set([
  'SESSION_OWNER_CHANGED',
  'CATALOG_REQUEST_PENDING',
  'COMMAND_EXPIRED',
  'PENDING_COMMAND_LIMIT',
]);

export type InstanceModelCatalogResult =
  | { ok: true; catalog: RemoteModelCatalogV1 }
  | { ok: false; reason: 'unsupported' | 'invalid' }
  | { ok: false; reason: 'transport'; cause?: unknown };

/**
 * Request the model catalog of a specific CLI connection before a session
 * exists.
 *
 * Sends exactly one sessionless `list_models` command with protocol version 1
 * and no session or mutation id, then classifies the outcome:
 *
 * - Resolved and schema-valid → `{ ok: true, catalog }` with the transformed
 *   catalog shape.
 * - Resolved but outside the strict schema → `{ ok: false, reason: 'invalid' }`.
 * - Resolved but the strict parse throws unexpectedly → `{ ok: false,
 *   reason: 'transport' }`; the parse never escapes the helper.
 * - Rejected with an old-CLI unknown-command or invalid-request string, or a
 *   non-retryable relay code → `{ ok: false, reason: 'unsupported' }`.
 * - Rejected with any other delivered string, a retryable relay code, or a
 *   transport-level failure → `{ ok: false, reason: 'transport' }`.
 *
 * A `transport` outcome carries the caught failure as `cause`, so a caller
 * that reports it can attach what actually went wrong.
 *
 * Never throws and never logs.
 */
export async function listInstanceModels(
  connection: Pick<UserWebConnection, 'sendCommandToConnection'>,
  connectionId: string
): Promise<InstanceModelCatalogResult> {
  let raw: unknown;
  try {
    raw = await connection.sendCommandToConnection({
      command: 'list_models',
      data: { protocolVersion: 1 },
      expectedConnectionId: connectionId,
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
    const parsed = remoteModelCatalogV1Schema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: 'invalid' };
    return { ok: true, catalog: parsed.data };
  } catch (error) {
    return { ok: false, reason: 'transport', cause: error };
  }
}
