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

/** `create_session` wire data: protocol v1 plus any defined inheritance fields. */
export type CreateSessionWireData = {
  protocolVersion: 1;
  agent?: string;
  model?: { providerID: string; modelID: string; variant?: string };
  orgId?: string;
  directory?: string;
  cloneFromKiloSessionId?: string;
  cloneUpToMessageId?: string;
};

/**
 * Build `create_session` wire data for both create paths (session-scoped and
 * connection-scoped). Every defined inheritance field is forwarded; the clone
 * cut travels only beside its clone source.
 */
export function buildCreateSessionWireData(
  input?: CreateRemoteSessionInput
): CreateSessionWireData {
  return {
    protocolVersion: 1,
    ...(input?.agent !== undefined ? { agent: input.agent } : {}),
    ...(input?.model !== undefined ? { model: input.model } : {}),
    ...(input?.orgId !== undefined ? { orgId: input.orgId } : {}),
    ...(input?.directory !== undefined ? { directory: input.directory } : {}),
    ...(input?.cloneFromKiloSessionId !== undefined
      ? {
          cloneFromKiloSessionId: input.cloneFromKiloSessionId,
          ...(input.cloneUpToMessageId !== undefined
            ? { cloneUpToMessageId: input.cloneUpToMessageId }
            : {}),
        }
      : {}),
  };
}

/**
 * True when the wire data differs from the bare `{ protocolVersion: 1 }` form
 * that every supported CLI accepts.
 */
export function hasExtendedCreateSessionFields(data: CreateSessionWireData): boolean {
  return (
    data.agent !== undefined ||
    data.model !== undefined ||
    data.orgId !== undefined ||
    data.directory !== undefined
  );
}

/**
 * Derive the durable wire identities of one create intent.
 *
 * The extended attempt and the old-CLI bare retry MUST NOT share an identity:
 * the relay dedupes by mutationId and would replay the extended attempt's
 * stored `invalid create_session command` error to the bare retry. A caller
 * retry of the same intent reuses these identities, so the relay replays its
 * stored terminal result instead of dispatching a second command.
 *
 * Without a caller key both fields are `undefined` and the wire carries no
 * mutationId; the relay then falls back to a per-wire random correlation id.
 */
export function createSessionWireMutationIds(mutationId: string | undefined): {
  extended: string | undefined;
  bare: string | undefined;
} {
  return mutationId === undefined
    ? { extended: undefined, bare: undefined }
    : { extended: `${mutationId}:ext`, bare: `${mutationId}:bare` };
}

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

/**
 * Connection-scoped `create_session` for the `kilo remote` process-per-session
 * spawn flow. Unlike the session-scoped `createSession` in
 * `cli-live-transport.ts` (which fences the command to a known Kilo sessionId),
 * this helper targets a specific CLI viewer connection and omits any
 * `sessionId` on the wire — the CLI is expected to provision a fresh
 * `KiloSessionId` for the new cloud-agent session.
 *
 * When `input.mutationId` is supplied it is forwarded on the wire as a durable
 * dedupe identity: the extended attempt uses `${key}:ext` and the old-CLI bare
 * retry uses `${key}:bare`. The two MUST NOT share an identity, because the
 * relay dedupes by mutationId and would replay the extended attempt's stored
 * `invalid create_session command` error to the bare retry. When omitted, the
 * wire carries no mutationId and the relay falls back to a per-wire random
 * correlation id.
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
  const data = buildCreateSessionWireData(input);
  // `directory` is an extended field; the `:bare` retry omits it for old CLIs.
  // Remove `:bare` when every supported CLI accepts it.
  const hasExtendedFields = hasExtendedCreateSessionFields(data);
  const hasCloneField = input?.cloneFromKiloSessionId !== undefined;
  const { extended: extendedMutationId, bare: bareMutationId } = createSessionWireMutationIds(
    input?.mutationId
  );
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
    // Old form is one bare protocolVersion 1 retry for extended fields; a
    // clone id must never use that fallback because it would create a fresh
    // session.
    if (
      !hasCloneField &&
      hasExtendedFields &&
      error instanceof CommandDeliveredError &&
      error.message === INVALID_CREATE_SESSION_COMMAND
    ) {
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
 * Relay-emitted structured code for a same-key duplicate whose command is
 * already in flight or whose durable entry is still pending. The intent is NOT
 * terminal: the retry must keep the caller's operation key so it rides the same
 * durable identity and the relay replays the stored terminal result instead of
 * dispatching a second command. Callers classify it as retryable.
 */
export const COMMAND_ALREADY_PENDING_CODE = 'COMMAND_ALREADY_PENDING';
