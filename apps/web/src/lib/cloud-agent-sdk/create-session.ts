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
import { createSessionResponseV1Schema, type CreateSessionResponseV1 } from './schemas';
import type { KiloSessionId } from './types';

export { createSessionResponseV1Schema } from './schemas';
export type { CreateSessionResponseV1 } from './schemas';

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
