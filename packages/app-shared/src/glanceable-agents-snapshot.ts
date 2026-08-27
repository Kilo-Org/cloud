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
  running: z.number().int().min(0),
  needsInput: z.number().int().min(0),
  reconnecting: z.number().int().min(0),
  /** ISO 8601 timestamp or null; binds the elapsed-time display. */
  eligibleStartedAt: z.string().nullable(),
});

export type GlanceableAgentsSnapshot = z.infer<typeof glanceableAgentsSnapshotSchema>;

export type GlanceableCounts = {
  running: number;
  needsInput: number;
  reconnecting: number;
};

/**
 * Map session rows to the three eligible counts. `busy` → running,
 * `question`/`permission` → needs-input, `retry` → reconnecting. `idle` and
 * any unknown status are ignored. Do not call `isCompletedStatus` here.
 */
export function countGlanceableSessions(
  sessions: readonly { status: string }[]
): GlanceableCounts {
  let running = 0;
  let needsInput = 0;
  let reconnecting = 0;
  for (const session of sessions) {
    switch (session.status) {
      case 'busy':
        running += 1;
        break;
      case 'question':
      case 'permission':
        needsInput += 1;
        break;
      case 'retry':
        reconnecting += 1;
        break;
      default:
        // idle and unknown statuses contribute nothing.
        break;
    }
  }
  return { running, needsInput, reconnecting };
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
  sessions: readonly { status: string }[];
  userId: string;
  organizationId: string | null;
  /** Epoch milliseconds. */
  now: number;
  previousRevision?: number;
  previousEligibleStartedAt?: string | null;
  accountEpoch?: number;
  /** Overrides the happy/empty derivation for waiting, stale, expired, signed_out, privacy. */
  status?: GlanceableAgentsSnapshotStatus;
};

/**
 * Build a snapshot from the current session rows. Revision increases by one
 * on every build. `eligibleStartedAt` keeps the previous value while work
 * stays eligible, starts at `now` when work becomes eligible, and is null
 * otherwise.
 */
export function buildGlanceableSnapshot(input: BuildGlanceableSnapshotInput): GlanceableAgentsSnapshot {
  const counts = countGlanceableSessions(input.sessions);
  const eligible = counts.running + counts.needsInput + counts.reconnecting > 0;
  const now = input.now;
  const updatedAt = new Date(now).toISOString();
  const eligibleStartedAt = eligible ? (input.previousEligibleStartedAt ?? updatedAt) : null;

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
    reconnecting: counts.reconnecting,
    eligibleStartedAt,
  };
}

/** True when any eligible count is non-zero. */
export function isEligibleGlanceableWork(snapshot: GlanceableAgentsSnapshot): boolean {
  return snapshot.running + snapshot.needsInput + snapshot.reconnecting > 0;
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
