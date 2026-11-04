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

/** Events requested per poll. Small on purpose: this iteration only logs. */
export const PAGE_LIMIT = 10;

/** Fallback when `SCIM_POLL_INTERVAL_SECONDS` is absent or unparseable. */
export const DEFAULT_INTERVAL_SECONDS = 60;

/**
 * A sub-second interval would leave the Durable Object no idle window to
 * hibernate in, billing its full 128 MB allocation continuously.
 */
export const MIN_INTERVAL_SECONDS = 10;

export const MAX_INTERVAL_SECONDS = 3600;
