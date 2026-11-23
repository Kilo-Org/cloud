/**
 * Identifiers for synced chats.
 *
 * The server id is CLI-canonical (`ses_<12 lowercase hex of descending
 * time><14 base62>`) so it passes every cloud schema, minted once at first
 * sync and kept in `chats.server_session_id` across harness clones. Message
 * ids derive deterministically from harness turn ids, so retrying an upload
 * names the same messages again instead of forking the log.
 */

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** The shape a CLI-canonical server session id takes. */
export const SERVER_SESSION_ID_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

export function isServerSessionId(value: string): boolean {
  return SERVER_SESSION_ID_PATTERN.test(value);
}

/**
 * Mints a server session id at `now` (epoch ms). `random` answers one byte
 * per call; it is injected so tests can pin the suffix.
 */
export function mintServerSessionId(now: number, random: () => number): string {
  const descending = (0xffff_ffff_ffffn - BigInt(Math.max(0, Math.floor(now))))
    .toString(16)
    .padStart(12, '0')
    .slice(-12);
  let suffix = '';
  for (let index = 0; index < 14; index += 1) {
    suffix += BASE62[Math.abs(Math.floor(random())) % BASE62.length];
  }
  return `ses_${descending}${suffix}`;
}

/** The stable `msg_` id a harness turn uploads under. */
export function msgIdForTurn(turnId: string): string {
  const suffix = turnId.replace(/[^0-9A-Za-z]/g, '').replace(/^trn/i, '');
  return `msg_${suffix === '' ? 'turn' : suffix}`;
}

/** The `msg_` id of the idle marker that settles one uploaded exchange. */
export function idleMsgIdForTurn(turnId: string): string {
  return `${msgIdForTurn(turnId)}idle`;
}

/** Decodes the millisecond time a harness ULID id carries, or null when it carries none. */
export function ulidTimeMs(id: string): number | null {
  const body = id.includes('_') ? id.slice(id.indexOf('_') + 1) : id;
  if (body.length < 10) {
    return null;
  }
  let time = 0;
  for (let index = 0; index < 10; index += 1) {
    const digit = CROCKFORD.indexOf(body[index]?.toUpperCase() ?? '');
    if (digit === -1) {
      return null;
    }
    time = time * 32 + digit;
  }
  return time;
}

/** Encodes a millisecond time the way a ULID does: ten Crockford base32 characters. */
export function crockfordTime(timeMs: number): string {
  let rest = Math.max(0, Math.floor(timeMs));
  let encoded = '';
  for (let index = 0; index < 10; index += 1) {
    encoded = (CROCKFORD[rest % 32] ?? '0') + encoded;
    rest = Math.floor(rest / 32);
  }
  return encoded;
}

/**
 * The harness turn id an imported message takes. The store orders turns by
 * id, so the id encodes the message's own creation time the way a local
 * ULID does; imported and local turns then interleave in conversation
 * order, and `seq` breaks ties inside one millisecond.
 */
export function importedTurnId(createdMs: number, seq: number): string {
  return `trn_${crockfordTime(createdMs)}${String(Math.max(0, seq)).padStart(16, '0')}`;
}

/** The harness part id of one part of an imported turn, ordered after its siblings. */
export function importedPartId(createdMs: number, seq: number, ordinal: number): string {
  return `prt_${crockfordTime(createdMs)}${String(Math.max(0, seq)).padStart(12, '0')}${String(
    Math.max(0, ordinal)
  ).padStart(4, '0')}`;
}
