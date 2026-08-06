/**
 * Create-session response parser.
 *
 * `create_session` is a session-scoped viewer command sent on the user-web
 * socket. Its success body is the strict `protocolVersion: 1` envelope
 * (see `createSessionResponseV1Schema`). Anything outside that shape — extra
 * fields, missing fields, the wrong protocol version, or a non-string
 * `sessionID` — is rejected; the relay is the source of truth for this
 * envelope and any drift must fail closed.
 *
 * The parser returns a `KiloSessionId`-branded `sessionID` so downstream
 * consumers cannot accidentally pass a cloud-agent session ID into a
 * session-scoped transport.
 */
import { createSessionResponseV1Schema } from './schemas';
import type { CreateRemoteSessionInput } from './transport';
import type { KiloSessionId } from './types';
import {
  CommandDeliveredError,
  UserWebCommandError,
  type UserWebConnection,
} from './user-web-connection';

export { createSessionResponseV1Schema } from './schemas';
export type { CreateSessionResponseV1 } from './schemas';
export type { CreateRemoteSessionInput } from './transport';

/** Delivered error string for old-CLI strict-parse rejection of extended create_session. */
const INVALID_CREATE_SESSION_COMMAND = 'invalid create_session command';

export type CreateSessionParseResult =
  | { ok: true; kiloSessionId: KiloSessionId }
  | { ok: false; reason: 'invalid' };

/**
 * Parse a raw `create_session` response into a branded `KiloSessionId`.
 *
 * Returns `{ ok: true, kiloSessionId }` for a well-formed v1 envelope, or
 * `{ ok: false, reason: 'invalid' }` for any other input. Callers can use
 * the structured result to distinguish a malformed/oversized payload from a
 * transport-level failure.
 */
export function parseCreateSessionResponse(raw: unknown): CreateSessionParseResult {
  const parsed = createSessionResponseV1Schema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'invalid' };
  return { ok: true, kiloSessionId: parsed.data.sessionID };
}

/**
 * Result of `createRemoteSessionOnConnection` — the raw, unparsed
 * `create_session` reply. Callers should run it through
 * `parseCreateSessionResponse` to obtain a `KiloSessionId`. Exposed for
 * consistency with other SDK helpers that return the raw reply; success
 * here only means "the relay accepted and answered", not "the body is valid".
 */
export type CreateRemoteSessionRawResult = unknown;

/** Durable identity suffix for the extended `create_session` attempt. */
const EXTENDED_MUTATION_ID_SUFFIX = ':ext';

/** Durable identity suffix for the old-CLI bare `create_session` retry. */
const BARE_MUTATION_ID_SUFFIX = ':bare';

/**
 * Derive the wire mutationId for one create attempt from the caller's stable
 * key. The two attempts MUST NOT share a durable identity: the UserConnectionDO
 * dedupes by mutationId, so a bare retry under the extended attempt's id would
 * replay the stored `invalid create_session command` error instead of reaching
 * the CLI. Appending a per-attempt suffix keeps both identities stable and
 * distinct. `undefined` input keeps the legacy byte-identical wire (no
 * mutationId).
 */
function attemptMutationId(key: string | undefined, suffix: string): string | undefined {
  return key !== undefined ? `${key}${suffix}` : undefined;
}

/**
 * Connections whose extended (`${key}:ext`) durable identity already delivered
 * the old-CLI `invalid create_session command` terminal error. The relay stores
 * that delivered error under the extended identity, so every later attempt
 * under `${key}:ext` replays the stale error instead of reaching the CLI. Once
 * the `${key}:bare` fallback has succeeded, later creates with the same logical
 * key on the same connection skip the dead extended identity and use the proven
 * bare identity directly. Keyed by connection object (each connection owns a
 * separate UserConnectionDO) and composite on `connectionId` + logical key, so
 * a fresh connection is never short-circuited.
 */
const bareFallbackProvenKeys = new WeakMap<object, Set<string>>();

/** Composite key for one connection's durable extended identity. */
function extendedIdentityKey(connectionId: string, logicalKey: string): string {
  return `${connectionId}:${logicalKey}`;
}

/** Remembers that the connection's `${logicalKey}:ext` identity is dead. */
function markExtendedIdentityDead(
  connection: object,
  connectionId: string,
  logicalKey: string
): void {
  const keys = bareFallbackProvenKeys.get(connection) ?? new Set<string>();
  keys.add(extendedIdentityKey(connectionId, logicalKey));
  bareFallbackProvenKeys.set(connection, keys);
}

/** True when the connection already proved the `${logicalKey}:ext` identity dead. */
function isExtendedIdentityDead(
  connection: object,
  connectionId: string,
  logicalKey: string
): boolean {
  return (
    bareFallbackProvenKeys.get(connection)?.has(extendedIdentityKey(connectionId, logicalKey)) ??
    false
  );
}

/**
 * Connection-scoped `create_session` for the `kilo remote` process-per-session
 * spawn flow. Unlike the session-scoped `createSession` in
 * `cli-live-transport.ts` (which fences the command to a known Kilo sessionId),
 * this helper targets a specific CLI viewer connection and omits any
 * `sessionId` on the wire — the CLI is expected to provision a fresh
 * `KiloSessionId` for the new cloud-agent session.
 *
 * When `input.mutationId` is supplied it is forwarded on the wire as a durable
 * dedupe identity (D8): the extended attempt uses `${key}:ext` and the old-CLI
 * bare retry uses `${key}:bare`, so the two durable identities cannot collide
 * (see `attemptMutationId`). When omitted, the wire carries no mutationId and
 * the relay falls back to a per-wire random correlation id.
 *
 * Once an extended attempt delivers the old-CLI `invalid create_session
 * command` error, the relay keeps that terminal error under `${key}:ext`
 * forever. Later creates with the same logical key on the same connection
 * therefore skip the dead extended identity and use the proven `${key}:bare`
 * identity directly, so a retry never replays the stale extended error.
 *
 * The returned promise resolves with the raw reply; the caller is responsible
 * for parsing the response shape. A delivered error response (string or
 * structured `UserWebCommandError`) rejects the promise; transport failures
 * (timeout, destroyed connection) reject with a plain `Error`. See
 * `CommandDeliveredError` and `UserWebCommandError` for the rejection
 * subclass contract.
 */
export async function createRemoteSessionOnConnection(
  connection: Pick<UserWebConnection, 'sendCommandToConnection'>,
  connectionId: string,
  input?: CreateRemoteSessionInput
): Promise<CreateRemoteSessionRawResult> {
  const data = {
    protocolVersion: 1 as const,
    ...(input?.agent !== undefined ? { agent: input.agent } : {}),
    ...(input?.model !== undefined ? { model: input.model } : {}),
    ...(input?.orgId !== undefined ? { orgId: input.orgId } : {}),
  };
  const hasExtendedFields =
    data.agent !== undefined || data.model !== undefined || data.orgId !== undefined;
  const logicalKey = input?.mutationId;
  // A prior extended attempt for this connection and logical key already
  // delivered the old-CLI invalid-command terminal error, which the relay
  // stores under `${key}:ext` and would replay on every later attempt. Skip
  // the dead identity and use the proven `${key}:bare` identity directly.
  const extendedIdentityIsDead =
    logicalKey !== undefined && isExtendedIdentityDead(connection, connectionId, logicalKey);
  const extendedMutationId = attemptMutationId(logicalKey, EXTENDED_MUTATION_ID_SUFFIX);
  try {
    if (extendedIdentityIsDead) {
      const bareMutationId = attemptMutationId(logicalKey, BARE_MUTATION_ID_SUFFIX);
      return await connection.sendCommandToConnection({
        command: 'create_session',
        data: { protocolVersion: 1 },
        expectedConnectionId: connectionId,
        ...(bareMutationId !== undefined ? { mutationId: bareMutationId } : {}),
      });
    }
    return await connection.sendCommandToConnection({
      command: 'create_session',
      data,
      expectedConnectionId: connectionId,
      ...(extendedMutationId !== undefined ? { mutationId: extendedMutationId } : {}),
    });
  } catch (error) {
    // Only bare-retry when extended fields made the original wire differ from
    // `{ protocolVersion: 1 }`; otherwise the retry is byte-identical noise.
    if (
      hasExtendedFields &&
      error instanceof CommandDeliveredError &&
      error.message === INVALID_CREATE_SESSION_COMMAND
    ) {
      // The extended identity is now durably dead (the relay stored the
      // invalid-command error under it): remember it so later retries with the
      // same logical key skip straight to the proven bare identity.
      if (logicalKey !== undefined) {
        markExtendedIdentityDead(connection, connectionId, logicalKey);
      }
      const bareMutationId = attemptMutationId(logicalKey, BARE_MUTATION_ID_SUFFIX);
      return connection.sendCommandToConnection({
        command: 'create_session',
        data: { protocolVersion: 1 },
        expectedConnectionId: connectionId,
        ...(bareMutationId !== undefined ? { mutationId: bareMutationId } : {}),
      });
    }
    throw error;
  }
}

/**
 * Exact-match literal for the relay's "instance disconnected" string
 * (`UserConnectionDO`). Special-cased to `retryable` because semantically the
 * instance disconnected, which is the same recovery path as a transport
 * failure.
 */
export const SESSION_OWNER_NOT_FOUND_LITERAL = 'Session owner not found';

export type CreateSessionOutcome =
  | { status: 'ready'; sessionID: KiloSessionId }
  | { status: 'retryable'; reason: string; cause: unknown }
  | { status: 'nonRetryable'; reason: string; cause: unknown };

/**
 * Relay-emitted structured code (`UserConnectionDO`) for a same-key duplicate
 * whose command is already in flight or whose durable entry is still pending.
 * Semantically the intent is NOT terminal: the retry must keep the caller's
 * operation key so it rides the same durable identity and the DO replays the
 * stored terminal result instead of dispatching a second command. Classified
 * as `retryable`, never `nonRetryable`.
 */
export const COMMAND_ALREADY_PENDING_CODE = 'COMMAND_ALREADY_PENDING';

/**
 * Classify the resolved-or-rejected outcome of `createRemoteSessionOnConnection`
 * into the spawn flow's state space:
 *
 *   - `ready`        — a fresh `KiloSessionId` was provisioned by the CLI
 *   - `retryable`    — a transport-level failure (timeout, destroyed
 *                      connection, socket gone), the relay-emitted literal
 *                      `'Session owner not found'`, or the relay's
 *                      `COMMAND_ALREADY_PENDING` same-key in-flight dedupe
 *   - `nonRetryable` — anything else: a malformed response envelope, a
 *                      delivered CLI string error, or any other structured
 *                      `UserWebCommandError`
 *
 * A durable D8 replay of a terminal envelope carries exactly the live
 * envelope's shape under the retry request's id, so a replayed envelope must
 * classify identically to the original live delivery.
 *
 * The `cause` field preserves the original error for callers that want to
 * surface or log it; `reason` is a short, user-safe string intended for UI.
 */
export function classifyCreateSessionResult(
  result: PromiseSettledResult<unknown>
): CreateSessionOutcome {
  if (result.status === 'fulfilled') {
    const parsed = parseCreateSessionResponse(result.value);
    if (parsed.ok) {
      return { status: 'ready', sessionID: parsed.kiloSessionId };
    }
    return {
      status: 'nonRetryable',
      reason: 'unexpected response shape',
      cause: result.value,
    };
  }

  // result.status === 'rejected'
  const cause: unknown = result.reason;

  // Structured relay error: keep `.code` available; every code maps to
  // `nonRetryable` EXCEPT `COMMAND_ALREADY_PENDING`, the relay's same-key
  // in-flight dedupe marker. That marker means the intent is still pending
  // on the DO, so the caller must keep its operation key and retry to get
  // the durable replay (see `COMMAND_ALREADY_PENDING_CODE`).
  if (cause instanceof UserWebCommandError) {
    if (cause.code === COMMAND_ALREADY_PENDING_CODE) {
      return {
        status: 'retryable',
        reason: cause.message || cause.code,
        cause,
      };
    }
    return {
      status: 'nonRetryable',
      reason: cause.message || cause.code,
      cause,
    };
  }

  // Delivered bare-string error: special-case the relay's vanished-connection
  // literal to `retryable` (see `SESSION_OWNER_NOT_FOUND_LITERAL`).
  if (cause instanceof CommandDeliveredError) {
    if (cause.message === SESSION_OWNER_NOT_FOUND_LITERAL) {
      return {
        status: 'retryable',
        reason: SESSION_OWNER_NOT_FOUND_LITERAL,
        cause,
      };
    }
    return {
      status: 'nonRetryable',
      reason: cause.message,
      cause,
    };
  }

  // Anything else (plain `Error` from timeout / destroyed connection /
  // socket gone) is a transport failure: retryable.
  return {
    status: 'retryable',
    reason: cause instanceof Error ? cause.message : 'transport failure',
    cause,
  };
}
