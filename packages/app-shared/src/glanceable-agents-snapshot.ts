import { z } from 'zod';

/**
 * One durable, privacy-minimal, versioned snapshot for every glanceable
 * surface (Live Activity, Dynamic Island, Home Screen widget, Android
 * widget, Android ongoing notification).
 *
 * Privacy contract: the snapshot carries generic status, counts, safe
 * timestamps, and an opaque scope key only. It must never carry a session
 * title, prompt, excerpt, organization name, repository name, generated
 * text, secret, or a raw account/session id.
 */

export const GLANCEABLE_SNAPSHOT_SCHEMA_VERSION = 1;
/** 8 hours: matches the usual Live Activity lifetime. */
export const GLANCEABLE_SNAPSHOT_EXPIRY_MS = 28_800_000;
/** Later happy updates are coalesced for at most this long. */
export const GLANCEABLE_COALESCE_MS = 1000;
/** Terminal empty lasts at most this long before the activity ends. */
export const GLANCEABLE_TERMINAL_MS = 8000;

export type GlanceableAgentsSnapshotStatus =
  | 'waiting'
  | 'empty'
  | 'happy'
  | 'stale'
  | 'expired'
  | 'signed_out'
  | 'privacy';

export const glanceableAgentsSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().min(1),
  /** ISO 8601 timestamp. */
  updatedAt: z.string(),
  /** ISO 8601 timestamp; `updatedAt + GLANCEABLE_SNAPSHOT_EXPIRY_MS`. */
  expiresAt: z.string(),
  /** Opaque scope key; never a raw user or organization id. */
  scopeKey: z.string().min(1),
  /**
   * Client-set local auth epoch. Optional on the wire: old and server
   * producers omit it; the client sets the current local epoch when it
   * applies a remote snapshot. Remove the optional when every producer
   * sends it.
   */
  accountEpoch: z.number().int().optional(),
  organizationBound: z.boolean(),
  status: z.enum(['waiting', 'empty', 'happy', 'stale', 'expired', 'signed_out', 'privacy']),
  /** Sessions actively doing something. */
  running: z.number().int().min(0),
  /** Sessions waiting on the user, including one whose CLI dropped mid-question. */
  needsInput: z.number().int().min(0),
  /** Sessions connected but doing nothing. */
  idle: z.number().int().min(0),
  /**
   * ISO 8601 timestamp or null: when the longest-waiting needs-input session
   * entered that state. Null when nothing needs input, or when no row carried
   * a status timestamp. Only needs-input carries a duration, because a wait is
   * the one interval the user can act on — see `oldestNeedsInputSince`.
   */
  needsInputSince: z.string().nullable(),
});

export type GlanceableAgentsSnapshot = z.infer<typeof glanceableAgentsSnapshotSchema>;

export type GlanceableCounts = {
  running: number;
  needsInput: number;
  idle: number;
};

/** One session row, as both producers read it from the active-sessions list. */
export type GlanceableSessionRow = {
  status: string;
  /** ISO 8601; when this session's status last changed. Absent on old rows. */
  statusUpdatedAt?: string;
};

/** Statuses that mean the agent waits on the user and cannot go on alone. */
const NEEDS_INPUT_STATUSES = new Set(['question', 'permission', 'retry']);

/**
 * Map session rows to the three glanceable counts. `busy` → running,
 * `question`/`permission`/`retry` → needs-input, `idle` → idle, and any
 * unknown status is ignored. Do not call `isCompletedStatus` here.
 *
 * `retry` folds into needs-input because it means one thing to the user: the
 * agent is waiting and cannot go on alone. Session-ingest writes it when a CLI
 * disconnects while that session was waiting on an answer, and the CLI writes
 * it while backing off after a provider error.
 */
export function countGlanceableSessions(
  sessions: readonly GlanceableSessionRow[]
): GlanceableCounts {
  let running = 0;
  let needsInput = 0;
  let idle = 0;
  for (const session of sessions) {
    switch (session.status) {
      case 'busy':
        running += 1;
        break;
      case 'question':
      case 'permission':
      case 'retry':
        needsInput += 1;
        break;
      case 'idle':
        idle += 1;
        break;
      default:
        // An unknown status contributes nothing.
        break;
    }
  }
  return { running, needsInput, idle };
}

/**
 * The earliest `statusUpdatedAt` among the needs-input sessions, or null when
 * none waits or none carried a usable timestamp.
 *
 * The counts are aggregates, so a single duration can only honestly describe
 * the oldest wait: it is a floor on how long the user has kept an agent
 * blocked. A row with a missing or unparseable timestamp is skipped rather
 * than treated as waiting since now, which would understate the wait.
 */
export function oldestNeedsInputSince(sessions: readonly GlanceableSessionRow[]): string | null {
  let oldest: number | null = null;
  let oldestIso: string | null = null;
  for (const session of sessions) {
    if (!NEEDS_INPUT_STATUSES.has(session.status) || session.statusUpdatedAt === undefined) {
      continue;
    }
    const at = Date.parse(session.statusUpdatedAt);
    if (Number.isNaN(at) || (oldest !== null && at >= oldest)) {
      continue;
    }
    oldest = at;
    oldestIso = session.statusUpdatedAt;
  }
  return oldestIso;
}

// FNV-1a 32-bit over UTF-16 code units (two bytes each). Deterministic across
// Node and Hermes and not reversible to the input, so the raw ids never appear
// in the key.
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    hash = Math.imul(hash ^ (code & 0xff), 0x01000193) >>> 0;
    hash = Math.imul(hash ^ ((code >>> 8) & 0xff), 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Opaque, stable scope key for a user + optional organization pair. The
 * client also fences remote snapshots on the local auth epoch, so the epoch
 * deliberately does not enter this key.
 */
export function buildOpaqueScopeKey(input: {
  userId: string;
  organizationId: string | null;
}): string {
  // Length-delimited by a NUL separator so `user=ab,org=c` and `user=a,org=bc`
  // cannot hash to the same key.
  const joined = `${input.userId}\u0000${input.organizationId ?? ''}`;
  const hash = fnv1a32(joined);
  return hash.toString(16).padStart(8, '0');
}

export type BuildGlanceableSnapshotInput = {
  sessions: readonly GlanceableSessionRow[];
  userId: string;
  organizationId: string | null;
  /** Epoch milliseconds. */
  now: number;
  previousRevision?: number;
  accountEpoch?: number;
  /** Overrides the happy/empty derivation for waiting, stale, expired, signed_out, privacy. */
  status?: GlanceableAgentsSnapshotStatus;
};

/**
 * Build a snapshot from the current session rows. Revision increases by one
 * on every build. `needsInputSince` comes straight from the rows, so it needs
 * no carry-forward across revisions: it is data, not a latch.
 */
export function buildGlanceableSnapshot(
  input: BuildGlanceableSnapshotInput
): GlanceableAgentsSnapshot {
  const counts = countGlanceableSessions(input.sessions);
  // Idle counts: a connected agent doing nothing is still something the user
  // wants on the Lock Screen, and the Dynamic Island ranks it last.
  const eligible = counts.running + counts.needsInput + counts.idle > 0;
  const now = input.now;
  const updatedAt = new Date(now).toISOString();

  return {
    schemaVersion: GLANCEABLE_SNAPSHOT_SCHEMA_VERSION,
    revision: (input.previousRevision ?? 0) + 1,
    updatedAt,
    expiresAt: new Date(now + GLANCEABLE_SNAPSHOT_EXPIRY_MS).toISOString(),
    scopeKey: buildOpaqueScopeKey({ userId: input.userId, organizationId: input.organizationId }),
    ...(input.accountEpoch === undefined ? {} : { accountEpoch: input.accountEpoch }),
    organizationBound: typeof input.organizationId === 'string',
    status: input.status ?? (eligible ? 'happy' : 'empty'),
    running: counts.running,
    needsInput: counts.needsInput,
    idle: counts.idle,
    needsInputSince: oldestNeedsInputSince(input.sessions),
  };
}

/** True when any agent is connected, whether working, waiting, or idle. */
export function isEligibleGlanceableWork(snapshot: GlanceableAgentsSnapshot): boolean {
  return snapshot.running + snapshot.needsInput + snapshot.idle > 0;
}

/**
 * True when `incoming` must be discarded in favour of `current`: a strictly
 * lower revision, or the same revision with an older `updatedAt`. ISO strings
 * from `toISOString()` compare correctly as strings.
 */
export function shouldDiscardGlanceableRevision(
  incoming: GlanceableAgentsSnapshot,
  current: GlanceableAgentsSnapshot
): boolean {
  if (incoming.revision < current.revision) {
    return true;
  }
  if (incoming.revision === current.revision) {
    return incoming.updatedAt < current.updatedAt;
  }
  return false;
}
