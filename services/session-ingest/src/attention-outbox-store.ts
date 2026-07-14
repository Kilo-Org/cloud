/**
 * Durable per-session outbox for human-attention pushes.
 *
 * One row per stable upstream request id (a question id, permission id, or
 * blocking-suggestion id). Rows are created lazily on the first `*.asked` and
 * transitioned to a terminal status (`dispatched`, `suppressed_presence`,
 * `missing_session`, `failed`, or `resolved`) by the alarm dispatch loop.
 *
 * Concurrency: this module is called from inside `SessionIngestDO` where the
 * platform serializes input gate access per DO, so individual statements are
 * safe to issue back-to-back without an explicit transaction. The DO alarm
 * fires single-threaded per DO, which is what makes the dispatch loop's
 * `pending → in_flight → terminal` sequence atomic at the row level.
 *
 * The store never stores event bodies, prompt text, or any envelope payload —
 * only stable request ids, reasons, and the terminal status of the dispatch
 * attempt. The raw event data is not logged or persisted for retries.
 *
 * Transition rules (enforced by the `apply*` helpers and the drizzle layer):
 *   - `recordRaiseIntent`: insert a fresh `pending` row; idempotent on
 *     request id (re-raise of a `resolved`/terminal row is a no-op).
 *   - `recordResolveIntent`: `pending`/`in_flight` → `resolved`, sets
 *     `resolvedAt`, clears `nextAttemptAt`/`lastError`. Terminal rows only
 *     gain `resolvedAt` (the status stays terminal) and stay no-op on a
 *     repeat resolve.
 *   - `claimNextDispatchable`: lease the next due `pending` row by flipping
 *     it to `in_flight`.
 *   - `markDispatched` / `markSuppressedByPresence` / `markMissingSession`:
 *     terminal transitions, idempotent.
 *   - `markRetry`: bump `attemptCount`, schedule next attempt; at
 *     `MAX_ATTEMPTS` park at terminal `failed` to stop the alarm loop.
 *     No-op for any terminal row.
 *   - `recoverStaleInFlightRows`: alarm-restart recovery — any row left in
 *     `in_flight` is bumped to `pending` with a fresh `nextAttemptAt`, or
 *     parked at `failed` when the bump hits `MAX_ATTEMPTS`. Downstream
 *     dispatch is deduped at the request-id level, so re-leasing a row
 *     that already pushed cannot double-fire a notification.
 */

import { and, asc, eq, gte, isNotNull, lte, sql } from 'drizzle-orm';
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';

import { attentionOutbox } from './db/sqlite-schema';
import {
  ATTENTION_MAX_DISPATCH_AGE_MS,
  computeNextAttemptAt,
  dispatchDeadline,
  MAX_ATTEMPTS,
  type AttentionReason,
} from './attention-outbox';

export type OutboxStatus =
  | 'pending'
  | 'in_flight'
  | 'dispatched'
  | 'suppressed_presence'
  | 'missing_session'
  | 'failed'
  | 'resolved';

const TERMINAL_STATUSES: OutboxStatus[] = [
  'resolved',
  'dispatched',
  'suppressed_presence',
  'missing_session',
  'failed',
];

function isTerminalStatus(status: OutboxStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export type OutboxRow = {
  requestId: string;
  reason: AttentionReason;
  status: OutboxStatus;
  attemptCount: number;
  nextAttemptAt: number | null;
  lastError: string | null;
  raisedAt: number;
  resolvedAt: number | null;
};

export type RecordIntentParams = {
  requestId: string;
  reason: AttentionReason;
  now: number;
};

/**
 * Pure: build the row for a fresh raise. Does not enforce dedup; the
 * drizzle layer checks for an existing row first and short-circuits.
 */
export function applyRaiseIntent(params: RecordIntentParams): OutboxRow {
  return {
    requestId: params.requestId,
    reason: params.reason,
    status: 'pending',
    attemptCount: 0,
    nextAttemptAt: params.now,
    lastError: null,
    raisedAt: params.now,
    resolvedAt: null,
  };
}

/**
 * Idempotently record a raise. Returns the resulting row. A re-raise of the
 * same request id is a no-op — the original `raised_at` and reason are
 * preserved, so the user only sees one push per upstream request, even if
 * the CLI replays the `*.asked` event. A raise against a `resolved` or
 * terminal row is a no-op too: the user already saw the outcome, so we do
 * not create a new pending push.
 */
export function recordRaiseIntent(
  db: DrizzleSqliteDODatabase,
  params: RecordIntentParams
): OutboxRow {
  const existing = selectByRequestId(db, params.requestId);
  if (existing) return existing;

  const row = applyRaiseIntent(params);
  db.insert(attentionOutbox)
    .values({
      request_id: row.requestId,
      reason: row.reason,
      status: row.status,
      attempt_count: row.attemptCount,
      next_attempt_at: row.nextAttemptAt,
      last_error: row.lastError,
      raised_at: row.raisedAt,
      resolved_at: row.resolvedAt,
    })
    .run();
  return row;
}

export type RecordResolveParams = {
  requestId: string;
  reason: AttentionReason;
  now: number;
};

/**
 * Pure: compute the next row for a resolve intent. `pending` and
 * `in_flight` rows collapse to terminal `resolved` and clear their retry
 * bookkeeping. Terminal rows only gain `resolvedAt` (when missing) and
 * keep their existing status; a repeat resolve is a no-op.
 */
export function applyResolveIntent(existing: OutboxRow, now: number): OutboxRow {
  if (existing.status === 'pending' || existing.status === 'in_flight') {
    return {
      ...existing,
      status: 'resolved',
      nextAttemptAt: null,
      lastError: null,
      resolvedAt: now,
    };
  }
  if (existing.resolvedAt !== null) return existing;
  return { ...existing, resolvedAt: now };
}

/**
 * Pure: build a terminal resolved tombstone for a request id that was
 * never raised. The unknown-resolve path is the safe out-of-order case
 * where the resolve arrives before the matching raise. The tombstone
 * stamps `raisedAt` and `resolvedAt` to the same `now` so a subsequent
 * raise cannot pick the row up as a real push — the outbox dispatch
 * loop will see `status === 'resolved'` and skip it.
 *
 * `raisedAt === resolvedAt` and `attemptCount === 0` are the contract
 * that distinguishes a tombstone from a real raise-then-resolve row.
 */
export function applyResolveIntentForUnknownRequest(params: {
  requestId: string;
  reason: AttentionReason;
  now: number;
}): OutboxRow {
  return {
    requestId: params.requestId,
    reason: params.reason,
    status: 'resolved',
    attemptCount: 0,
    nextAttemptAt: null,
    lastError: null,
    raisedAt: params.now,
    resolvedAt: params.now,
  };
}

/**
 * Mark a request resolved. When the request id was never raised this
 * inserts a terminal resolved tombstone (see
 * `applyResolveIntentForUnknownRequest`) so a late raise cannot enqueue
 * a notification. When a row already exists, the original `reason` is
 * preserved and the row is collapsed to terminal `resolved` — a repeat
 * resolve with a different reason is a no-op for the stored reason and
 * never re-flaps status.
 */
export function recordResolveIntent(
  db: DrizzleSqliteDODatabase,
  params: RecordResolveParams
): OutboxRow {
  const existing = selectByRequestId(db, params.requestId);
  if (!existing) {
    const row = applyResolveIntentForUnknownRequest({
      requestId: params.requestId,
      reason: params.reason,
      now: params.now,
    });
    db.insert(attentionOutbox)
      .values({
        request_id: row.requestId,
        reason: row.reason,
        status: row.status,
        attempt_count: row.attemptCount,
        next_attempt_at: row.nextAttemptAt,
        last_error: row.lastError,
        raised_at: row.raisedAt,
        resolved_at: row.resolvedAt,
      })
      .run();
    return row;
  }

  // Existing row: the original reason is preserved. A repeat resolve
  // with a different reason must not overwrite the stored reason, and
  // must not change status away from any terminal state.
  const next = applyResolveIntent(existing, params.now);
  if (next === existing) return existing;

  db.update(attentionOutbox)
    .set({
      status: next.status,
      resolved_at: next.resolvedAt,
      next_attempt_at: next.nextAttemptAt,
      last_error: next.lastError,
    })
    .where(eq(attentionOutbox.request_id, params.requestId))
    .run();

  return selectByRequestId(db, params.requestId) as OutboxRow;
}

export type ClaimDispatchParams = {
  now: number;
};

/**
 * Park every pending row whose `next_attempt_at` is at/over the
 * absolute dispatch window (raisedAt + ATTENTION_MAX_DISPATCH_AGE_MS)
 * as terminal failed with `last_error: 'retry_window_expired'`. The
 * window is the receiver's idempotency TTL bound
 * (NotificationChannelDO = 60min; we cap dispatch at 55min) so any
 * attempt at/after 60min could be silently dropped or duplicated. By
 * parking first, the rest of the dispatch loop and the
 * `earliestScheduledAttemptAt` scheduler see only rows that are still
 * safely within the window.
 *
 * Defense in depth: `claimNextDispatchable` calls this on every lease
 * attempt and the DO alarm also calls it at start-up, so a delayed
 * alarm that fires long after the row crossed the window can never
 * claim a stale row.
 */
export function parkExpiredPendingRows(
  db: DrizzleSqliteDODatabase,
  _params: ClaimDispatchParams
): OutboxRow[] {
  const candidates = db
    .select()
    .from(attentionOutbox)
    .where(
      and(
        eq(attentionOutbox.status, 'pending'),
        isNotNull(attentionOutbox.next_attempt_at),
        gte(
          attentionOutbox.next_attempt_at,
          sql`${attentionOutbox.raised_at} + ${ATTENTION_MAX_DISPATCH_AGE_MS}`
        )
      )
    )
    .all();

  const parked: OutboxRow[] = [];
  for (const row of candidates) {
    const existing = rowToOutbox(row);
    db.update(attentionOutbox)
      .set({
        status: 'failed',
        next_attempt_at: null,
        last_error: 'retry_window_expired',
      })
      .where(eq(attentionOutbox.request_id, existing.requestId))
      .run();
    parked.push({
      ...existing,
      status: 'failed',
      nextAttemptAt: null,
      lastError: 'retry_window_expired',
    });
  }
  return parked;
}

/**
 * Claim the next due pending row for dispatch, transitioning it to
 * `in_flight`. Returns the row or null when nothing is due.
 *
 * Two hard guards ensure the row is still within the receiver's
 * idempotency window before any lease is granted:
 *   1. `parkExpiredPendingRows` flips any pending row whose
 *      `next_attempt_at` is at/over the absolute deadline to terminal
 *      `failed` (defense in depth — also called at alarm start).
 *   2. The remaining `pending` candidate must additionally satisfy
 *      `now < raisedAt + ATTENTION_MAX_DISPATCH_AGE_MS` so a row whose
 *      deadline has just elapsed between the parking step and the
 *      claim is never picked.
 *
 * Atomic within the DO input gate — the SQLite update + select is the
 * dispatch lease.
 */
export function claimNextDispatchable(
  db: DrizzleSqliteDODatabase,
  params: ClaimDispatchParams
): OutboxRow | null {
  parkExpiredPendingRows(db, params);

  const candidates = db
    .select()
    .from(attentionOutbox)
    .where(
      and(
        eq(attentionOutbox.status, 'pending'),
        isNotNull(attentionOutbox.next_attempt_at),
        lte(attentionOutbox.next_attempt_at, params.now)
      )
    )
    .orderBy(asc(attentionOutbox.next_attempt_at))
    .all();

  for (const candidate of candidates) {
    const existing = rowToOutbox(candidate);
    if (params.now >= dispatchDeadline(existing.raisedAt)) {
      // The candidate is "due" by next_attempt_at but the absolute
      // window has elapsed. Park it and continue scanning — the
      // earlier `next_attempt_at` does not imply earlier dispatch
      // safety. Parking here covers the rare case where
      // `next_attempt_at < raisedAt + maxAge` (so the parking step
      // didn't catch it) but the wall clock is now past the deadline.
      db.update(attentionOutbox)
        .set({
          status: 'failed',
          next_attempt_at: null,
          last_error: 'retry_window_expired',
        })
        .where(eq(attentionOutbox.request_id, existing.requestId))
        .run();
      continue;
    }

    db.update(attentionOutbox)
      .set({ status: 'in_flight' })
      .where(eq(attentionOutbox.request_id, existing.requestId))
      .run();

    return { ...existing, status: 'in_flight' };
  }
  return null;
}

export type MarkDispatchedParams = {
  requestId: string;
  now: number;
};

/**
 * Mark a row terminal-dispatched. The dispatch succeeded, so no further
 * retries will fire.
 */
export function markDispatched(db: DrizzleSqliteDODatabase, params: MarkDispatchedParams): void {
  db.update(attentionOutbox)
    .set({ status: 'dispatched', next_attempt_at: null })
    .where(eq(attentionOutbox.request_id, params.requestId))
    .run();
}

export type MarkSuppressedByPresenceParams = {
  requestId: string;
  now: number;
};

/**
 * Terminal: the user is actively viewing this session, so the push was
 * suppressed upstream. Don't retry — they'll see the result in-app.
 */
export function markSuppressedByPresence(
  db: DrizzleSqliteDODatabase,
  params: MarkSuppressedByPresenceParams
): void {
  db.update(attentionOutbox)
    .set({ status: 'suppressed_presence', next_attempt_at: null })
    .where(eq(attentionOutbox.request_id, params.requestId))
    .run();
}

export type MarkMissingSessionParams = {
  requestId: string;
  now: number;
};

/**
 * Terminal: the session row is gone or the user no longer has access. We
 * could re-raise in the future if access is restored, but a stale push
 * with the wrong recipient is worse than missing one.
 */
export function markMissingSession(
  db: DrizzleSqliteDODatabase,
  params: MarkMissingSessionParams
): void {
  db.update(attentionOutbox)
    .set({ status: 'missing_session', next_attempt_at: null })
    .where(eq(attentionOutbox.request_id, params.requestId))
    .run();
}

export type MarkRetryParams = {
  requestId: string;
  now: number;
  reason: string;
};

/**
 * Pure: compute the next row for a retry outcome. Bumps `attemptCount`
 * and either schedules the next attempt or parks the row at terminal
 * `failed`. Two independent terminal triggers:
 *   1. the attempt cap (`MAX_ATTEMPTS`) is reached, or
 *   2. the absolute dispatch window has elapsed — `now` is at/after
 *      `raisedAt + ATTENTION_MAX_DISPATCH_AGE_MS`, or the candidate
 *      next attempt timestamp would itself land at/after that deadline.
 * Trigger (2) is the receiver's idempotency TTL bound
 * (NotificationChannelDO is 60min; we cap dispatch at 55min) and trips
 * regardless of the cap. Terminal rows (resolved, dispatched,
 * suppressed_presence, missing_session, or failed) win and are returned
 * unchanged so retries never resurrect finished work. The terminal
 * `failed` row keeps `resolvedAt` null to match the markRetry park
 * convention.
 */
export function applyRetry(existing: OutboxRow, now: number, reason: string): OutboxRow {
  if (isTerminalStatus(existing.status)) {
    return existing;
  }
  const nextAttemptCount = existing.attemptCount + 1;
  const capReached = nextAttemptCount >= MAX_ATTEMPTS;
  const deadline = dispatchDeadline(existing.raisedAt);
  const candidateNext = computeNextAttemptAt(nextAttemptCount, now);
  const windowExpired = now >= deadline || candidateNext >= deadline;
  const isTerminal = capReached || windowExpired;
  return {
    ...existing,
    status: isTerminal ? 'failed' : 'pending',
    attemptCount: nextAttemptCount,
    nextAttemptAt: isTerminal ? null : candidateNext,
    lastError: reason.slice(0, 512),
  };
}

/**
 * Mark the row pending again, bumping the attempt counter and scheduling
 * the next try. After `MAX_ATTEMPTS` the row is parked at terminal
 * `failed` to keep the alarm from hot-looping. A row that has already
 * reached a terminal status wins and is returned unchanged.
 */
export function markRetry(db: DrizzleSqliteDODatabase, params: MarkRetryParams): OutboxRow {
  const existing = selectByRequestId(db, params.requestId);
  if (!existing) {
    const error = new Error('markRetry: unknown request_id');
    (error as Error & { code: string }).code = 'ATTENTION_OUTBOX_UNKNOWN_REQUEST';
    throw error;
  }
  const next = applyRetry(existing, params.now, params.reason);
  if (next === existing) {
    return existing;
  }

  db.update(attentionOutbox)
    .set({
      status: next.status,
      attempt_count: next.attemptCount,
      next_attempt_at: next.nextAttemptAt,
      last_error: next.lastError,
    })
    .where(eq(attentionOutbox.request_id, params.requestId))
    .run();

  return selectByRequestId(db, params.requestId) as OutboxRow;
}

/**
 * Pure: compute the next row for a stale `in_flight` recovery (alarm
 * restart or crash between lease and ack). The row is bumped to
 * `pending` with a fresh `nextAttemptAt`; the same two terminal
 * triggers as `applyRetry` apply — the cap or the absolute dispatch
 * window. Downstream dispatch is keyed on the stable request id, so a
 * recovered row cannot double-push.
 */
export function applyStaleInFlightRecovery(existing: OutboxRow, now: number): OutboxRow {
  const nextAttemptCount = existing.attemptCount + 1;
  const capReached = nextAttemptCount >= MAX_ATTEMPTS;
  const deadline = dispatchDeadline(existing.raisedAt);
  const candidateNext = computeNextAttemptAt(nextAttemptCount, now);
  const windowExpired = now >= deadline || candidateNext >= deadline;
  const isTerminal = capReached || windowExpired;
  if (isTerminal) {
    return {
      ...existing,
      status: 'failed',
      attemptCount: nextAttemptCount,
      nextAttemptAt: null,
      lastError: 'stale_in_flight_recovered',
    };
  }
  return {
    ...existing,
    status: 'pending',
    attemptCount: nextAttemptCount,
    nextAttemptAt: candidateNext,
    lastError: 'stale_in_flight_recovered',
  };
}

export type RecoverStaleInFlightParams = {
  now: number;
};

/**
 * Recover any rows still in `in_flight` — typically because the DO was
 * restarted (or the alarm was lost) between the lease and the dispatch
 * ack. Each stale row is bumped to `pending` with a fresh schedule, or
 * parked at `failed` once `MAX_ATTEMPTS` is reached. Returns the rows
 * that were recovered (caller can use this to reschedule the alarm).
 */
export function recoverStaleInFlightRows(
  db: DrizzleSqliteDODatabase,
  params: RecoverStaleInFlightParams
): OutboxRow[] {
  const candidates = db
    .select()
    .from(attentionOutbox)
    .where(eq(attentionOutbox.status, 'in_flight'))
    .all();
  const recovered: OutboxRow[] = [];
  for (const row of candidates) {
    const existing = rowToOutbox(row);
    const next = applyStaleInFlightRecovery(existing, params.now);
    db.update(attentionOutbox)
      .set({
        status: next.status,
        attempt_count: next.attemptCount,
        next_attempt_at: next.nextAttemptAt,
        last_error: next.lastError,
      })
      .where(eq(attentionOutbox.request_id, existing.requestId))
      .run();
    recovered.push(next);
  }
  return recovered;
}

/**
 * Earliest `next_attempt_at` across pending rows that are still
 * dispatchable (have a `next_attempt_at` set). Returns null when no
 * pending row is scheduled. Used by the alarm scheduler to pick a
 * non-clobbering alarm time without re-doing the full claim.
 */
export function earliestScheduledAttemptAt(db: DrizzleSqliteDODatabase): number | null {
  const row = db
    .select({ next_attempt_at: attentionOutbox.next_attempt_at })
    .from(attentionOutbox)
    .where(and(eq(attentionOutbox.status, 'pending'), isNotNull(attentionOutbox.next_attempt_at)))
    .orderBy(asc(attentionOutbox.next_attempt_at))
    .limit(1)
    .get();
  return row?.next_attempt_at ?? null;
}

/**
 * True while at least one row is still pending dispatch (including
 * rows currently in_flight that may yet be returned by the alarm loop).
 * Used by the DO alarm to keep scheduling attempts until the outbox
 * drains.
 */
export function hasPendingAttempts(db: DrizzleSqliteDODatabase): boolean {
  const row = db
    .select({ request_id: attentionOutbox.request_id })
    .from(attentionOutbox)
    .where(eq(attentionOutbox.status, 'pending'))
    .limit(1)
    .get();
  return Boolean(row);
}

/**
 * True when at least one row is currently leased to the dispatch loop.
 * Used to detect a stuck `in_flight` row that the alarm needs to
 * recover. (We never use this for hot-loop scheduling — terminal
 * failures have a clear `failed` state to prevent that.)
 */
export function hasInFlightRows(db: DrizzleSqliteDODatabase): boolean {
  const row = db
    .select({ request_id: attentionOutbox.request_id })
    .from(attentionOutbox)
    .where(eq(attentionOutbox.status, 'in_flight'))
    .limit(1)
    .get();
  return Boolean(row);
}

/**
 * Read the current outbox row for a request id. Returns null when the
 * request id was never raised. Intended for the orchestration layer
 * (e.g. resolving pending pushes from a different signal) and tests.
 */
export function getOutboxRow(db: DrizzleSqliteDODatabase, requestId: string): OutboxRow | null {
  return selectByRequestId(db, requestId);
}

function selectByRequestId(db: DrizzleSqliteDODatabase, requestId: string): OutboxRow | null {
  const row = db
    .select()
    .from(attentionOutbox)
    .where(eq(attentionOutbox.request_id, requestId))
    .get();
  return row ? rowToOutbox(row) : null;
}

function rowToOutbox(row: typeof attentionOutbox.$inferSelect): OutboxRow {
  // These values are controlled by this DO's validated writes and
  // free-text SQLite columns, so targeted casts are sufficient; no
  // per-row Zod reparse is needed.
  return {
    requestId: row.request_id,
    reason: row.reason as AttentionReason,
    status: row.status as OutboxStatus,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    raisedAt: row.raised_at,
    resolvedAt: row.resolved_at,
  };
}
