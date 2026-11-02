import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Single-row table holding the WorkOS Events API stream position.
 *
 * The WorkOS Events API is environment-scoped (one API key = one stream) and
 * WorkOS prescribes a single serial consumer, so there is exactly one stream
 * position per deployment. `id` is pinned to `SINGLETON_POLL_STATE_ID`.
 */
export const pollState = sqliteTable('poll_state', {
  id: integer('id').primaryKey(),
  /**
   * The `after` cursor for the next request: the ID of the last event handled.
   * Null until the first event is handled; a null cursor means the next poll
   * enters the stream with `range_start` instead.
   */
  cursor: text('cursor'),
  /** `created_at` of the last handled event, for stream-lag observability. */
  last_event_created_at: text('last_event_created_at'),
  /**
   * ISO instant the stream was first entered. Persisted so a restart before
   * the first event does not silently re-enter at a later `range_start` and
   * skip events that arrived in between.
   */
  range_start: text('range_start'),
  /** Unix seconds of the last completed poll attempt, successful or not. */
  last_polled_at: integer('last_polled_at'),
  /** Unix seconds of the last poll that returned at least one event. */
  last_event_at: integer('last_event_at'),
  /** Lifetime count of events observed, for sanity-checking throughput. */
  events_seen: integer('events_seen').notNull().default(0),
  /** Consecutive failed polls; drives the backoff interval and resets on success. */
  consecutive_failures: integer('consecutive_failures').notNull().default(0),
  /** Message of the most recent failure. Never holds a credential or header. */
  last_error: text('last_error'),
  updated_at: integer('updated_at')
    .notNull()
    .default(sql`(unixepoch())`),
});

export type PollStateRow = typeof pollState.$inferSelect;
