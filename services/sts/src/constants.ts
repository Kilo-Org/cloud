/** Refresher cadence: one read of each manager folder every four minutes (design 4.4). */
export const REFRESH_INTERVAL_MS = 4 * 60 * 1000;

/** A bundle older than two refresh intervals is served marked stale, whatever its flag says. */
export const STALE_AFTER_MS = 2 * REFRESH_INTERVAL_MS;

/**
 * A stored manager read this young fills an empty bundle object without a new read. One minute
 * above the cadence covers an alarm that runs a little late.
 */
export const SNAPSHOT_FILL_MAX_AGE_MS = REFRESH_INTERVAL_MS + 60 * 1000;

/** Webhooks in one window merge into one refresh at the window's end (design 4.2). */
export const WEBHOOK_MERGE_WINDOW_MS = 30 * 1000;

/** A webhook whose signed timestamp is further than this from now is refused (design 4.2). */
export const WEBHOOK_MAX_SKEW_MS = 5 * 60 * 1000;

/** A webhook body above this size is refused before any signature work. */
export const WEBHOOK_MAX_BODY_BYTES = 64 * 1024;

/** A bundle request body is `{ ifNoneMatch }`; anything above this is refused unread. */
export const BUNDLE_REQUEST_MAX_BODY_BYTES = 4 * 1024;

/**
 * A Worker isolate reloads the webhook secret from the refresher at most this often, after a
 * signature that fails or a load that failed, so a forged flood costs at most one refresher hop
 * per isolate per minute.
 */
export const WEBHOOK_KEY_RELOAD_MS = 60 * 1000;

/** First retry after a failed manager read; each further failure doubles it, up to the cap. */
export const BACKOFF_BASE_MS = 15 * 1000;
export const BACKOFF_CAP_MS = REFRESH_INTERVAL_MS;

/**
 * Bound on one manager request. A fill makes at most a login and one parallel pair of reads, so it
 * finishes inside the secrets client's 25-second first-load window.
 */
export const MANAGER_FETCH_TIMEOUT_MS = 8_000;

/** Bound on one provider discovery or key-set fetch while verifying a workload token. */
export const PROVIDER_FETCH_TIMEOUT_MS = 5_000;

/** A policy change after a deploy refreshes this soon, so new grants arrive without waiting. */
export const POLICY_CHANGE_REFRESH_DELAY_MS = 5_000;

/** A bundle object asks the refresher to confirm its alarm at most this often. */
export const REFRESHER_CHECK_INTERVAL_MS = 60 * 1000;

/** A delivery's audit row is relayed this long after the append. */
export const RELAY_DELAY_MS = 5_000;

/** Retry delay after a failed relay. */
export const RELAY_RETRY_MS = 60 * 1000;

/** Relayed audit rows stay this long, so a lost queue message can be sent again (design 8.5). */
export const AUDIT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Per-minute 304 counters stay this long. */
export const DELIVERY_COUNTER_RETENTION_MS = 24 * 60 * 60 * 1000;

/** A Durable Object deletes rows past retention at most this often. */
export const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** A failed audit append refuses the read; the caller retries after this many seconds. */
export const AUDIT_RETRY_AFTER_SECONDS = 30;

/** No bundle and no manager: the caller keeps its last copy and retries after this. */
export const MANAGER_RETRY_AFTER_SECONDS = 60;

/** A provider key set or discovery document is unreachable: the caller retries after this. */
export const VERIFIER_RETRY_AFTER_SECONDS = 30;

/** A bundle object call failed (an error or a reset): the caller retries after this. */
export const BUNDLE_OBJECT_RETRY_AFTER_SECONDS = 30;
