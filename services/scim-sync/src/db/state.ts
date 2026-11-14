import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { and, eq, isNotNull, lt, sql } from 'drizzle-orm';

import type { AttemptClass, AttemptOutcome } from '../dispatch/app-client';
import type { CursorSource, EventFailureState } from '../types';
import { CURSOR_KEY, PARKED_EVENT_RETENTION_MS, SEED_CURSOR_KEY } from '../util/constants';
import {
  directoryConflicts,
  eventFailures,
  parkedActivations,
  parkedEvents,
  syncState,
} from './sqlite-schema';

export type Db = DrizzleSqliteDODatabase<Record<string, never>>;

export type ResolvedCursor = {
  /** Null means request without `after`, which returns the oldest events. */
  cursor: string | null;
  source: CursorSource;
};

/**
 * Reports which cursor the next poll will run on, without writing.
 *
 * Stored state wins, *unless* `WORKOS_EVENT_CURSOR` differs from the
 * `seed_cursor` that produced it — in which case the var wins. That makes
 * changing the var and redeploying the operator's reset action, while an
 * unchanged var never overrides a cursor the loop has advanced. Without the
 * seed the two rules are incompatible: a var that always loses cannot reset,
 * and one that always wins re-applies the same backlog on every deploy.
 *
 * The var can only ever be an event id. `after` and `range_start` are mutually
 * exclusive in the Events API, so recovery from a cursor older than the 90-day
 * retention window is a separate operator action rather than a second meaning
 * for this var.
 */
export function peekCursor(db: Db, configured: string | null): ResolvedCursor {
  const seed = read(db, SEED_CURSOR_KEY);
  if (configured !== seed) {
    return { cursor: configured, source: configured === null ? 'none' : 'var' };
  }

  const stored = read(db, CURSOR_KEY);
  return { cursor: stored, source: stored === null ? 'none' : 'stored' };
}

/**
 * Resolves the cursor for a poll, rewriting both rows when the configured
 * value wins so that the override applies once rather than on every tick.
 *
 * An override also drops the held failure, because the row describes an event
 * the new cursor may never reach again. Left behind, a forward reset past the
 * held event leaves `/status.eventFailure` non-null forever — only that event
 * applying or parking clears it, and neither can happen once the cursor is
 * past it — and a rewind *onto* it would carry the old `attempts` and
 * `first_failed_at` into `recordFailure`, so a conflict could be parked on its
 * first attempt instead of getting the retry budget the reset was meant to
 * grant. An operator reset is a deliberate "start from here", and the directory
 * records go with it: a replayed conflict is measured from the new position
 * rather than against a window that was already spent.
 */
export function resolveCursor(db: Db, configured: string | null): ResolvedCursor {
  const overrides = configured !== read(db, SEED_CURSOR_KEY);
  const resolved = peekCursor(db, configured);
  if (overrides) {
    writeCursor(db, configured);
    clearHeldFailure(db);
    clearAllDirectoryLimits(db);
  }
  return resolved;
}

/**
 * Commits one event as applied. Called after every call that event mapped to
 * succeeded, and nothing else writes the cursor: a crash mid-page therefore
 * replays exactly the last event, which the endpoints are idempotent for.
 *
 * Writes the seed alongside it so the committed cursor stays attributable to
 * the var that produced it. Both rows in one statement, with no `await`
 * between them, so the pair cannot be observed half-written.
 */
export function commitCursor(db: Db, eventId: string, seed: string | null): void {
  db.insert(syncState)
    .values([
      { key: CURSOR_KEY, value: eventId },
      { key: SEED_CURSOR_KEY, value: seed ?? '' },
    ])
    .onConflictDoUpdate({ target: syncState.key, set: { value: sql`excluded.value` } })
    .run();
}

/**
 * Records that the loop is stuck on an event, preserving `first_failed_at` so
 * the conflict retry budget measures from the first failure rather than the
 * latest attempt, and `attempts` so the backoff grows.
 *
 * At most one row exists: the stream is serial, so a held event blocks
 * everything behind it, and an event that applies clears its row. An id
 * different from the stored one means the previous holder resolved, so the
 * stale row is dropped rather than left to age out.
 */
export function recordFailure(
  db: Db,
  event: { id: string; event: string },
  outcome: AttemptOutcome,
  now: number
): EventFailureState {
  const existing = currentFailure(db);
  if (existing !== null && existing.eventId !== event.id) {
    // Scoped to the resolved event rather than a bare delete: at most one row
    // exists, but a `where`-less delete is one typo from clearing live state.
    db.delete(eventFailures).where(eq(eventFailures.event_id, existing.eventId)).run();
  }

  const carried = existing !== null && existing.eventId === event.id ? existing : null;
  const row = {
    event_id: event.id,
    event_type: event.event,
    attempts: (carried?.attempts ?? 0) + 1,
    last_class: outcome.class,
    last_status: outcome.status,
    last_error: outcome.reason ?? '',
    first_failed_at: carried?.firstFailedAt ?? now,
    last_attempt_at: now,
  };

  db.insert(eventFailures)
    .values(row)
    .onConflictDoUpdate({
      target: eventFailures.event_id,
      set: {
        attempts: row.attempts,
        last_class: row.last_class,
        last_status: row.last_status,
        last_error: row.last_error,
        last_attempt_at: row.last_attempt_at,
      },
    })
    .run();

  return {
    eventId: row.event_id,
    eventType: row.event_type,
    attempts: row.attempts,
    lastClass: outcome.class,
    lastStatus: row.last_status,
    lastError: row.last_error,
    firstFailedAt: row.first_failed_at,
    lastAttemptAt: row.last_attempt_at,
  };
}

export function currentFailure(db: Db): EventFailureState | null {
  const row = db.select().from(eventFailures).limit(1).get();
  if (row === undefined) return null;

  return {
    eventId: row.event_id,
    eventType: row.event_type,
    attempts: row.attempts,
    // Written by `recordFailure` from an `AttemptClass`, and the only values
    // that reach it are held classes.
    lastClass: row.last_class === 'conflict' ? 'conflict' : 'unavailable',
    lastStatus: row.last_status,
    lastError: row.last_error,
    firstFailedAt: row.first_failed_at,
    lastAttemptAt: row.last_attempt_at,
  };
}

/** Clears the held row once its event applies, or once it is parked. */
export function clearFailure(db: Db, eventId: string): void {
  db.delete(eventFailures).where(eq(eventFailures.event_id, eventId)).run();
}

/**
 * Drops whatever failure is held, without knowing its event id. Only the
 * cursor override needs this: every other clear names the event it resolved,
 * and at most one row exists because the stream is serial.
 */
function clearHeldFailure(db: Db): void {
  const existing = currentFailure(db);
  if (existing !== null) clearFailure(db, existing.eventId);
}

/**
 * Drops every directory's records. Only the cursor override needs this, for the
 * same reason as `clearHeldFailure`: a reset is a deliberate "start from here",
 * so a replayed conflict is measured from the new position rather than against a
 * window that was spent before it.
 */
function clearAllDirectoryLimits(db: Db): void {
  // `isNotNull` on the primary key is the whole table: a where-less delete is
  // what the lint rule forbids, and there is no narrower condition here.
  db.delete(directoryConflicts).where(isNotNull(directoryConflicts.directory_id)).run();
  db.delete(parkedActivations).where(isNotNull(parkedActivations.directory_id)).run();
}

/**
 * Steps over an event the loop gave up on. The park row and the cleared
 * failure row are written here; the caller commits the cursor past the event,
 * which is what lets the stream continue.
 *
 * `record` carries the class and the reason the decision settled on, which is
 * not always the attempt's own: a conflict can be parked as terminal when no
 * later event can clear it, and its reason then names the directory rule rather
 * than only the app's answer.
 *
 * The row describes the **latest** park decision. An operator who rewinds
 * `WORKOS_EVENT_CURSOR` and parks the same event again gets this park's class,
 * status, reason and attempt count, so the record names the current failure
 * instead of the first one, and the retention window is measured from this
 * `parked_at`, so the row keeps a full window rather than inheriting the age of
 * a park from weeks earlier.
 */
export function parkEvent(
  db: Db,
  event: { id: string; event: string },
  outcome: AttemptOutcome,
  record: { class: AttemptClass; reason: string | null },
  attempts: number,
  now: number
): void {
  const row = {
    event_id: event.id,
    event_type: event.event,
    class: record.class,
    status: outcome.status,
    error: record.reason ?? '',
    attempts,
    parked_at: now,
  };

  db.insert(parkedEvents)
    .values(row)
    .onConflictDoUpdate({
      target: parkedEvents.event_id,
      set: {
        event_type: row.event_type,
        class: row.class,
        status: row.status,
        error: row.error,
        attempts: row.attempts,
        parked_at: row.parked_at,
      },
    })
    .run();
  clearFailure(db, event.id);
}

/**
 * Counts the parked rows still retained. Expiry is a range delete from the
 * alarm, so this is the number of rows inside the retention window, which is
 * the number an operator can still act on.
 */
export function parkedCount(db: Db): number {
  return (
    db
      .select({ count: sql<number>`count(*)` })
      .from(parkedEvents)
      .get()?.count ?? 0
  );
}

/**
 * Expires parked rows older than the retention window and reports how many it
 * removed.
 *
 * The comparison is strictly older than the cutoff: a row parked exactly
 * `PARKED_EVENT_RETENTION_MS` ago is kept by this tick and removed by a later
 * one. Every row carries the `parked_at` its window is measured from, so a row
 * written before this policy expires once its cutoff passes. The comparison is
 * a range on `parked_at`, which the table's index serves, so neither statement
 * scans the table.
 *
 * Only `parked_events` is affected. The cursor, `event_failures`,
 * `directory_conflicts`, `parked_activations`, and every directory row at
 * WorkOS are untouched, so expiry drops a recovery record and never data the
 * loop applied.
 *
 * The count is read before the delete because drizzle's durable-sqlite `run()`
 * returns `void`, and asking the delete to `returning` the removed ids would
 * hold one id per deleted row in memory for a tick that removes many. The two
 * statements run back to back inside one synchronous Durable Object turn, so
 * nothing can park a row between the count and the delete. A throw between them
 * propagates to the alarm's guard, which logs it, and the next tick counts and
 * deletes again with a later cutoff: a lost count costs a log line, never a
 * missed row.
 */
export function pruneParkedEvents(db: Db, now: number): number {
  const cutoff = now - PARKED_EVENT_RETENTION_MS;
  const removed =
    db
      .select({ count: sql<number>`count(*)` })
      .from(parkedEvents)
      .where(lt(parkedEvents.parked_at, cutoff))
      .get()?.count ?? 0;
  db.delete(parkedEvents).where(lt(parkedEvents.parked_at, cutoff)).run();
  return removed;
}

/** The conflict window a directory has open, keyed on the event that opened it. */
export type ConflictWindow = {
  directoryId: string;
  /** The event whose conflict opened the window, and the only one that closes it. */
  eventId: string;
  /** When that event first conflicted, which is what the budget is measured from. */
  firstConflictAt: number;
};

/**
 * Opens a directory's conflict window, or reports the one it already has.
 *
 * One window per directory, and the row names the event that opened it, so the
 * window closes when that event applies and stays open while it does not.
 */
export function openConflictWindow(
  db: Db,
  directoryId: string,
  eventId: string,
  now: number
): ConflictWindow {
  const existing = db
    .select()
    .from(directoryConflicts)
    .where(eq(directoryConflicts.directory_id, directoryId))
    .get();

  if (existing !== undefined) {
    return {
      directoryId: existing.directory_id,
      eventId: existing.event_id,
      firstConflictAt: existing.first_conflict_at,
    };
  }

  db.insert(directoryConflicts)
    .values({ directory_id: directoryId, event_id: eventId, first_conflict_at: now })
    .run();
  return { directoryId, eventId, firstConflictAt: now };
}

/**
 * Closes the window when the event that opened it applies.
 *
 * A `where`-less delete would clear every directory's window; the pair of keys
 * keeps it to the one event.
 */
export function closeConflictWindow(db: Db, directoryId: string, eventId: string): void {
  db.delete(directoryConflicts)
    .where(
      and(
        eq(directoryConflicts.directory_id, directoryId),
        eq(directoryConflicts.event_id, eventId)
      )
    )
    .run();
}

/**
 * Drops both records for one directory: an activation that applied binds its
 * organization, so neither the conflict window nor the parked-activation marker
 * describes it any more.
 */
export function clearDirectoryLimits(db: Db, directoryId: string): void {
  db.delete(directoryConflicts).where(eq(directoryConflicts.directory_id, directoryId)).run();
  db.delete(parkedActivations).where(eq(parkedActivations.directory_id, directoryId)).run();
}

/**
 * Records that this directory's activation was parked, so no organization is
 * bound for it and no later event binds one. Keeps the first park: the marker
 * means the same thing however many activations park afterwards.
 */
export function markActivationParked(db: Db, directoryId: string, now: number): void {
  db.insert(parkedActivations)
    .values({ directory_id: directoryId, parked_at: now })
    .onConflictDoNothing()
    .run();
}

/** When this directory's activation was parked, or null when none was. */
export function activationParkedAt(db: Db, directoryId: string): number | null {
  const row = db
    .select({ parkedAt: parkedActivations.parked_at })
    .from(parkedActivations)
    .where(eq(parkedActivations.directory_id, directoryId))
    .get();
  return row?.parkedAt ?? null;
}

function read(db: Db, key: string): string | null {
  const row = db
    .select({ value: syncState.value })
    .from(syncState)
    .where(eq(syncState.key, key))
    .get();
  if (row === undefined) return null;
  // A blank var is "no cursor", so it round-trips as the empty string rather
  // than as a missing row: an operator clearing the var to re-read the oldest
  // retained events must differ from the seed that set one.
  return row.value === '' ? null : row.value;
}

function writeCursor(db: Db, configured: string | null): void {
  db.insert(syncState)
    .values([
      { key: CURSOR_KEY, value: configured ?? '' },
      { key: SEED_CURSOR_KEY, value: configured ?? '' },
    ])
    .onConflictDoUpdate({ target: syncState.key, set: { value: sql`excluded.value` } })
    .run();
}
