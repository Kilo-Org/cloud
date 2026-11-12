/**
 * Shared constants for the SCIM sync service
 */

import type { EventName } from '@workos-inc/node';

/**
 * The WorkOS Events API is scoped to the environment its API key belongs to,
 * and WorkOS prescribes a single serial consumer of the stream, so the
 * namespace holds exactly one instance under this name.
 */
export const SCIM_SYNC_DO_NAME = 'scim-sync';

/** Durable Object storage key for the last poll result. */
export const LAST_POLL_KEY = 'lastPoll';

/** `sync_state` keys. */
export const CURSOR_KEY = 'cursor';
export const SEED_CURSOR_KEY = 'seed_cursor';

/**
 * Directory Sync events, as named by the SDK's `EventName` union. Listing them
 * is required: the Events API rejects a request with no `events` filter, and
 * the filter is an allowlist, so an event type missing here is never returned.
 *
 * These ten match both the SDK's union and the published catalog at
 * https://workos.com/docs/events. SDK 12.x adds `dsync.token.created` and
 * `dsync.token.revoked`, which are not typeable at the catalog-pinned 11.x.
 */
export const DSYNC_EVENTS: EventName[] = [
  'dsync.activated',
  'dsync.deleted',
  'dsync.user.created',
  'dsync.user.updated',
  'dsync.user.deleted',
  'dsync.group.created',
  'dsync.group.updated',
  'dsync.group.deleted',
  'dsync.group.user_added',
  'dsync.group.user_removed',
];

/**
 * Events requested per poll. 100 is the documented maximum of the Events API's
 * `limit` parameter ("Accepts values between 1 and 100", default 10 —
 * https://workos.com/docs/reference/events/list). An initial sync of a real
 * directory is tens of thousands of events, so the page size and the drain
 * loop below are what decide whether the backlog clears in minutes or days.
 */
export const PAGE_LIMIT = 100;

/**
 * Wall-clock budget for one poll. The loop keeps fetching pages while the
 * previous one came back full and this much time remains, so a backlog drains
 * across consecutive pages instead of one page per interval. Well inside the
 * Durable Object alarm's wall-clock allowance, and short enough that a poll
 * cannot overlap the one-second re-arm it schedules.
 */
export const DRAIN_BUDGET_MS = 20_000;

/**
 * How long a retryable conflict may hold the cursor before the event is parked.
 *
 * Two budgets, both measured from a first failure, because the namespace holds
 * one instance and every tenant queues behind its cursor:
 *
 * - the event's own, from its first failure, which is what a single conflicting
 *   event may hold;
 * - its directory's, from that directory's first conflict, which is what one
 *   directory may hold in aggregate. Once it is spent, the directory's later
 *   conflicts park at once, so a directory's events hold the cursor for about
 *   one budget however many of them conflict.
 *
 * A conflict names a missing dependency, which an event *behind* the cursor can
 * supply — but not one that is ahead of it, and nothing else ever will. An hour
 * is long enough to cover an app deploy or a database failover and short enough
 * that a permanently unsatisfiable event does not stall the directory
 * indefinitely.
 */
export const CONFLICT_RETRY_BUDGET_MS = 60 * 60 * 1000;

/** Re-arm delay when a full page says events probably remain. */
export const CATCH_UP_DELAY_SECONDS = 1;

/** Ceiling for the held-failure backoff. */
export const MAX_RETRY_DELAY_SECONDS = 300;

/**
 * Per-request bound on a call to the app. No internal retry: the alarm is the
 * retry, so a request that hangs must fail the event rather than consume the
 * drain budget.
 */
export const REQUEST_TIMEOUT_MS = 15_000;

/** Fallback when `SCIM_POLL_INTERVAL_SECONDS` is absent or unparseable. */
export const DEFAULT_INTERVAL_SECONDS = 60;

/**
 * A sub-second interval would leave the Durable Object no idle window to
 * hibernate in, billing its full 128 MB allocation continuously.
 */
export const MIN_INTERVAL_SECONDS = 10;

export const MAX_INTERVAL_SECONDS = 3600;
