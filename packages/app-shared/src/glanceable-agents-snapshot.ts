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
/**
 * Later happy updates are coalesced for at most this long. A tray with many
 * running sessions heartbeats every few seconds, and each emit re-renders the
 * native surfaces, so a counts-only change may lag by at most one window. An
 * actionable needs-input change never waits (the publisher emits it at once).
 */
export const GLANCEABLE_COALESCE_MS = 10_000;
/** Terminal empty lasts at most this long before the activity ends. */
export const GLANCEABLE_TERMINAL_MS = 8000;
/**
 * A Live Activity that has taken no update for this long reads as unknown, not
 * as current: ActivityKit dims stale content. Every real transition pushes an
 * update well inside the window, and an idle card is already gone by then.
 */
export const GLANCEABLE_STALE_MS = 1_800_000;

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
  /**
   * Sessions waiting on a permission prompt: the needs-input rows that can be
   * approved without choosing an option. Optional on the wire — an older
   * producer omits it — and every reader treats absent as 0.
   */
  needsApproval: z.number().int().min(0).optional(),
  /** Sessions connected but doing nothing. */
  idle: z.number().int().min(0),
  /**
   * Sessions scheduled to wake later and doing nothing now. Optional on input
   * with a zero default: a version-1 snapshot persisted by the release before
   * this count carried no such key, and every reader treats absent as 0.
   * Remove the default when every producer sends it.
   */
  scheduled: z.number().int().min(0).default(0),
  /**
   * ISO 8601 timestamp or null: when the longest-waiting needs-input session
   * entered that state. Null when nothing needs input, or when no row carried
   * a status timestamp. Only needs-input carries a duration, because a wait is
   * the one interval the user can act on — see `oldestNeedsInputSince`.
   */
  needsInputSince: z.string().nullable(),
  /**
   * ISO 8601 timestamp or null: the soonest wake among scheduled sessions.
   * Null when nothing is scheduled, or when no scheduled row carried a usable
   * `scheduledAt`. A `scheduled` count with no wake time is representable.
   * Optional on input with a null default for the same reason as `scheduled`.
   */
  scheduledAt: z.string().nullable().default(null),
  /**
   * The kind of the most recent agent state change, in the one vocabulary every
   * surface shows. Null when no row carried a usable status timestamp. A
   * completed or unknown status folds into `running`, the same fold the counts
   * use, so the newest-result line can never disagree with the row above it —
   * see `newestGlanceableResult`.
   *
   * Optional on input with a null default: a version-1 snapshot persisted by
   * the release before this fact carried no such key, and every reader treats
   * absent as null. Remove the optional and the default when every producer
   * sends it.
   */
  newestResultKind: z.enum(['needsInput', 'running', 'idle', 'scheduled']).nullable().default(null),
  /**
   * ISO 8601 timestamp or null: when that newest change happened. Null exactly
   * when `newestResultKind` is null. Optional on input with a null default for
   * the same reason as the kind.
   */
  newestResultAt: z.string().nullable().default(null),
});

export type GlanceableAgentsSnapshot = z.infer<typeof glanceableAgentsSnapshotSchema>;

export type GlanceableCounts = {
  running: number;
  needsInput: number;
  idle: number;
  scheduled: number;
};

/** One session row, as both producers read it from the active-sessions list. */
export type GlanceableSessionRow = {
  status: string;
  /** ISO 8601; when this session's status last changed. Absent on old rows. */
  statusUpdatedAt?: string;
  /**
   * ISO 8601 wake time. Only a `scheduled` row carries one, and even then the
   * CLI may omit it — `scheduled` with no time is representable.
   */
  scheduledAt?: string;
};

/** Statuses that mean the agent waits on the user and cannot go on alone. */
const NEEDS_INPUT_STATUSES = new Set(['question', 'permission', 'retry']);

/** What a session's status means to a user: the one vocabulary every surface reads. */
export type GlanceableStatusKind = 'needsInput' | 'running' | 'idle' | 'scheduled';

/**
 * Map one session status to the kind the glanceable surfaces and the session
 * lists both show. Total on strings: needs-input statuses → `needsInput`,
 * `idle` → `idle`, the literal `scheduled` → `scheduled`, everything else →
 * `running` (starting, empty, unknown included). A session is idle only when
 * the agent says so, so a working or unrecognized session can never render
 * idle and a row can never disagree with the widget beside it. Callers pass
 * null only when a row has no status at all.
 */
export function glanceableStatusKind(status: string): GlanceableStatusKind {
  if (NEEDS_INPUT_STATUSES.has(status)) {
    return 'needsInput';
  }
  if (status === 'idle') {
    return 'idle';
  }
  if (status === 'scheduled') {
    return 'scheduled';
  }
  return 'running';
}

/**
 * Map session rows to the glanceable counts. `busy` → running,
 * `question`/`permission`/`retry` → needs-input, `idle` → idle, the literal
 * `scheduled` → scheduled, and any other status (starting, empty, unknown,
 * completed) counts as running: a session is idle only when the agent says
 * so, and no row is dropped from the count its list row shows.
 *
 * `retry` folds into needs-input because it means one thing to the user: the
 * agent is waiting and cannot go on alone. Session-ingest writes it when a CLI
 * disconnects while that session was waiting on an answer, and the CLI writes
 * it while backing off after a provider error.
 */
export function countGlanceableSessions(
  sessions: readonly GlanceableSessionRow[]
): GlanceableCounts {
  const counts = { running: 0, needsInput: 0, idle: 0, scheduled: 0 };
  for (const session of sessions) {
    counts[glanceableStatusKind(session.status)] += 1;
  }
  return counts;
}

/**
 * The number of session rows whose status is exactly `permission`. A
 * permission wait is the one needs-input kind the user can clear without
 * choosing an option, so the wrist control offers Approve only against this
 * count.
 *
 * Deliberately narrower than `needsInput`: a `question` needs an answer, and a
 * `retry` needs the provider to come back, so neither is approvable.
 */
export function countGlanceableApprovals(sessions: readonly GlanceableSessionRow[]): number {
  let approvals = 0;
  for (const session of sessions) {
    if (session.status === 'permission') {
      approvals += 1;
    }
  }
  return approvals;
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

/**
 * The earliest parseable `scheduledAt` among scheduled sessions, or null when
 * none is scheduled or none carried a usable wake time.
 *
 * A row with a missing or unparseable timestamp is skipped rather than treated
 * as waking now, which would understate how soon the soonest wake is. A
 * scheduled row with no wake time still counts as scheduled — only the
 * timestamp is absent.
 */
export function soonestScheduledAt(sessions: readonly GlanceableSessionRow[]): string | null {
  let soonest: number | null = null;
  let soonestIso: string | null = null;
  for (const session of sessions) {
    if (session.status !== 'scheduled' || session.scheduledAt === undefined) {
      continue;
    }
    const at = Date.parse(session.scheduledAt);
    if (Number.isNaN(at) || (soonest !== null && at >= soonest)) {
      continue;
    }
    soonest = at;
    soonestIso = session.scheduledAt;
  }
  return soonestIso;
}

/**
 * The most recent status change across the rows, or null when no row carried a
 * usable timestamp.
 *
 * The counts and the newest-result line must agree, so the kind maps through
 * `glanceableStatusKind`: a completed or unknown status reads as `running`
 * exactly as it counts. A row with a missing or unparseable timestamp is
 * skipped rather than treated as changing now, which would overstate how new
 * the newest change is.
 */
export function newestGlanceableResult(
  sessions: readonly GlanceableSessionRow[]
): { kind: GlanceableStatusKind; at: string } | null {
  let newest: number | null = null;
  let newestIso: string | null = null;
  let newestKind: GlanceableStatusKind | null = null;
  for (const session of sessions) {
    if (session.statusUpdatedAt === undefined) {
      continue;
    }
    const at = Date.parse(session.statusUpdatedAt);
    if (Number.isNaN(at) || (newest !== null && at <= newest)) {
      continue;
    }
    newest = at;
    newestIso = session.statusUpdatedAt;
    newestKind = glanceableStatusKind(session.status);
  }
  return newestIso === null || newestKind === null ? null : { kind: newestKind, at: newestIso };
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
 * no carry-forward across revisions: it is data, not a latch. The newest-result
 * fact reads the rows the same way.
 */
export function buildGlanceableSnapshot(
  input: BuildGlanceableSnapshotInput
): GlanceableAgentsSnapshot {
  const counts = countGlanceableSessions(input.sessions);
  // Idle and scheduled counts: a connected agent doing nothing, or one that
  // will wake later, is still something the user wants on the Lock Screen.
  const eligible = counts.running + counts.needsInput + counts.idle + counts.scheduled > 0;
  const now = input.now;
  const updatedAt = new Date(now).toISOString();
  const newest = newestGlanceableResult(input.sessions);

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
    needsApproval: countGlanceableApprovals(input.sessions),
    idle: counts.idle,
    scheduled: counts.scheduled,
    needsInputSince: oldestNeedsInputSince(input.sessions),
    scheduledAt: soonestScheduledAt(input.sessions),
    newestResultKind: newest?.kind ?? null,
    newestResultAt: newest?.at ?? null,
  };
}

/** True when any agent is connected, whether working, waiting, idle, or scheduled. */
export function isEligibleGlanceableWork(snapshot: GlanceableAgentsSnapshot): boolean {
  return snapshot.running + snapshot.needsInput + snapshot.idle + snapshot.scheduled > 0;
}

/**
 * True when an agent is working, waiting on the user, or scheduled to wake.
 * Only this may raise a Live Activity: idle work is worth keeping one alive,
 * never worth interrupting the Lock Screen for. A scheduled session is worth
 * a card and must not be treated as idle-only, or the widget would offer
 * `New agent` and the iOS Live Activity would not raise. The client sink and
 * the APNs push-to-start share the rule, so neither can resurrect a surface
 * the other retired.
 */
export function isStartableGlanceableWork(snapshot: GlanceableAgentsSnapshot): boolean {
  return snapshot.running + snapshot.needsInput + snapshot.scheduled > 0;
}

/** True when every connected agent is idle: eligible work, but nothing happening. */
export function isIdleOnlyGlanceableWork(snapshot: GlanceableAgentsSnapshot): boolean {
  return isEligibleGlanceableWork(snapshot) && !isStartableGlanceableWork(snapshot);
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
