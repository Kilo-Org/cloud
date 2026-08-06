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
import { CommandDeliveredError, type UserWebConnection } from './user-web-connection';

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
  const extendedMutationId = attemptMutationId(input?.mutationId, EXTENDED_MUTATION_ID_SUFFIX);
  try {
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
      const bareMutationId = attemptMutationId(input?.mutationId, BARE_MUTATION_ID_SUFFIX);
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
