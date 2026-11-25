/** Refresher cadence: one manager bulk read every four minutes (design 4.4). */
export const REFRESH_INTERVAL_MS = 4 * 60 * 1000;

/** Delay before the first alarm an entry schedules. */
export const STARTUP_ALARM_DELAY_MS = 5_000;

/** Retry delay after a failed relay or a failed refresh. */
export const RELAY_RETRY_MS = 60 * 1000;

/** How often a Durable Object wakes only to delete relayed rows past retention. */
export const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** A failed audit append refuses the read; the caller retries after this many seconds. */
export const AUDIT_RETRY_AFTER_SECONDS = 30;

/** No bundle and no manager: the caller keeps its last copy and retries after this. */
export const MANAGER_RETRY_AFTER_SECONDS = 60;
