import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

/**
 * The loop's state. Five tables, each answering one operator question: where
 * the stream is, what it is stuck on, how long each directory may hold it, what
 * it gave up on, and which directories it gave up on.
 */

/**
 * `cursor` is the id of the last event every call of which succeeded, and
 * `seed_cursor` is the `WORKOS_EVENT_CURSOR` value that produced it. Keeping
 * the seed is what lets an unchanged var leave live state alone while a changed
 * one resets the stream: see `decideCursor`.
 */
export const syncState = sqliteTable('sync_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

/**
 * The one event the loop is currently stuck on. At most one row: the stream is
 * consumed serially, so a held event blocks everything behind it. Deleted the
 * moment that event applies.
 */
export const eventFailures = sqliteTable('event_failures', {
  event_id: text('event_id').primaryKey(),
  event_type: text('event_type').notNull(),
  attempts: integer('attempts').notNull(),
  last_class: text('last_class').notNull(),
  last_status: integer('last_status'),
  last_error: text('last_error').notNull(),
  first_failed_at: integer('first_failed_at').notNull(),
  last_attempt_at: integer('last_attempt_at').notNull(),
});

/**
 * The one conflict window a directory has open, and the event whose conflict
 * opened it.
 *
 * The loop holds a single environment-wide cursor, and `event_failures`
 * measures a hold per event. This table measures the same hold per directory:
 * once `first_conflict_at` is a budget old, that directory's events have used
 * their stream time, and its later conflicts park at once.
 *
 * The window belongs to the one event that opened it and closes when that event
 * applies. Nothing else clears it.
 */
export const directoryConflicts = sqliteTable('directory_conflicts', {
  directory_id: text('directory_id').primaryKey(),
  event_id: text('event_id').notNull(),
  first_conflict_at: integer('first_conflict_at').notNull(),
});

/**
 * Directories whose `dsync.activated` the loop parked. Such a directory has no
 * bound organization, and this row lets the loop park its
 * `directory_not_found` conflicts at once. Cleared by an activation that
 * applies, or by an operator cursor reset.
 */
export const parkedActivations = sqliteTable('parked_activations', {
  directory_id: text('directory_id').primaryKey(),
  parked_at: integer('parked_at').notNull(),
});

/**
 * Events the loop gave up on and stepped over. Nothing reads these back: they
 * exist so that an event the directory can never satisfy is recoverable by an
 * operator rather than silently lost, and so `/status` can report a count.
 */
export const parkedEvents = sqliteTable('parked_events', {
  event_id: text('event_id').primaryKey(),
  event_type: text('event_type').notNull(),
  class: text('class').notNull(),
  status: integer('status'),
  error: text('error').notNull(),
  attempts: integer('attempts').notNull(),
  parked_at: integer('parked_at').notNull(),
});
