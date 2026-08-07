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

/** Delivered error string an old CLI returns for a sessionless `list_models`. */
const INVALID_LIST_MODELS_COMMAND = 'invalid list_models command';

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

export type InstanceModelCatalogResult =
  | { ok: true; catalog: RemoteModelCatalogV1 }
  | { ok: false; reason: 'unsupported' | 'invalid' | 'transport' };

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
 * - Rejected with the old-CLI `invalid list_models command` string or a
 *   non-retryable relay code → `{ ok: false, reason: 'unsupported' }`.
 * - Rejected with a retryable relay code or a transport-level failure →
 *   `{ ok: false, reason: 'transport' }`.
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
      return error.message === INVALID_LIST_MODELS_COMMAND
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

  const parsed = remoteModelCatalogV1Schema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'invalid' };
  return { ok: true, catalog: parsed.data };
}
