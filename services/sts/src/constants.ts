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
 * per isolate per minute once the secret is loaded. After a failed first load, one request per
 * minute retries and the others answer 503 meanwhile.
 */
export const WEBHOOK_KEY_RELOAD_MS = 60 * 1000;

/** First retry after a failed manager read; each further failure doubles it, up to the cap. */
export const BACKOFF_BASE_MS = 15 * 1000;
export const BACKOFF_CAP_MS = REFRESH_INTERVAL_MS;

/**
 * Bound on one manager request. A fill attempt makes at most a login and one parallel pair of
 * reads, so it takes at most 2 x 8 = 16 seconds and finishes inside the secrets client's 25-second
 * first-load window.
 */
export const MANAGER_FETCH_TIMEOUT_MS = 8_000;

/**
 * STS stops waiting for a bundle object after this long and answers `unavailable`. 20 s covers a
 * fill attempt's 16 s (MANAGER_FETCH_TIMEOUT_MS) plus the object hops. The secrets client counts an
 * attempt as failed after 5 s, but the attempt keeps running while the request that started it
 * lives and readers wait inside the client's 25-second first-load window, so a fill that succeeds
 * within this deadline still lands; an `unavailable` answer to an attempt the client already
 * counted as failed changes nothing. A fill that needs a second attempt (`withDORetry` in BundleDO
 * reruns it after a Durable Object error) can run past the deadline; that fill still finishes
 * inside the bundle object and serves the next read.
 */
export const BUNDLE_OBJECT_DEADLINE_MS = 20_000;

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

/** A bundle object call failed (an error, a reset or the deadline): the caller retries after this. */
export const BUNDLE_OBJECT_RETRY_AFTER_SECONDS = 30;

/** A mint request is at most 8 audience and scope pairs; anything above this is refused unread. */
export const TOKEN_REQUEST_MAX_BODY_BYTES = 4 * 1024;

/**
 * STS stops waiting for the token signer after this long and answers `unavailable`. A mint signs at
 * most 8 tokens and appends one row, with no call out of the object, so 5 s covers a cold start of
 * the object in the EU with room to spare; a caller cannot cancel an RPC (see serveBundle).
 */
export const TOKEN_SIGNER_DEADLINE_MS = 5_000;

/**
 * A failed mint (signer error, deadline, failed audit append): the caller retries after this. A
 * client renews at 80 % of a 5-minute token, so its current token still has 60 s left.
 */
export const TOKEN_SIGNER_RETRY_AFTER_SECONDS = 10;

/** A mint whose lifetime, capped at the attestation's `exp`, is below this is refused. */
export const MIN_TOKEN_LIFETIME_SECONDS = 60;

/** A token-signing key signs for 30 days (design 5.7). */
export const TOKEN_KEY_CURRENT_MS = 30 * 24 * 60 * 60 * 1000;

/** The next key is published this long before it signs, so every verifier holds it first. */
export const TOKEN_KEY_PUBLISH_AHEAD_MS = 7 * 24 * 60 * 60 * 1000;

/** A retired key stays published this long after the last token it signed expires. */
export const TOKEN_KEY_RETIRED_GRACE_MS = 10 * 60 * 1000;

/** Each isolate serves the token key set from memory this long; the response's max-age matches. */
export const TOKEN_JWKS_CACHE_MS = 5 * 60 * 1000;

/**
 * Token signer objects per environment. STS picks one at random per mint call, so the instances
 * of one workload spread over all of them, and the key set lists the keys of all of them. One
 * object has a soft limit of 1,000 requests per second
 * (https://developers.cloudflare.com/durable-objects/platform/limits/). At 200,000 caller
 * instances plus about 2,200 Vercel instances, each minting once per 4 minutes, STS makes about
 * 843 mint calls per second. The largest single workload may be the whole fleet; because the shard
 * is chosen per call, that still puts about 843 / 4 = 211 calls per second on each object, about
 * a fifth of the limit, whatever the split between workloads.
 */
export const TOKEN_SIGNER_SHARDS = 4;

/**
 * A token signer deletes a relayed audit row after this long. The audit queue is the record once
 * the relay sent a row; the short window keeps a busy shard's table near 211 rows/s x 1 h, about
 * 0.8 M rows, far below the 10 GB a Durable Object holds. An unrelayed row is never deleted.
 */
export const TOKEN_AUDIT_RETENTION_MS = 60 * 60 * 1000;

/** How often a token signer prunes; a prune that hits its batch bound runs again next alarm. */
export const TOKEN_AUDIT_PRUNE_INTERVAL_MS = 5 * 60 * 1000;

/** A lease or revoke request body is a grant and a lifetime, or a lease id; above this is refused. */
export const LEASE_REQUEST_MAX_BODY_BYTES = 1024;

/**
 * The lease object gives up on a lease whose creation took longer than this, measured from when
 * STS called the object (so the object's cold start and the call to it count), and checked again
 * after the `lease.created` row is written: it revokes the lease and answers `unavailable`, so no
 * lease outlives a caller that already stopped waiting. A creation is a login and one create call,
 * 8 seconds each at most.
 */
export const LEASE_CREATE_BUDGET_MS = 20_000;

/** STS stops waiting for the lease object after this long, past the object's own budget. */
export const LEASE_OBJECT_DEADLINE_MS = 25_000;

/**
 * A revocation Infisical could not take is retried by the lease object's alarm, until it succeeds
 * or the lease expires. The alarm retries a lease no sooner than this after its last attempt,
 * whether a caller or the alarm made it, or after Infisical's `Retry-After` on a 429 when longer.
 */
export const LEASE_REVOKE_RETRY_MS = 30_000;

/** Owed revocations one alarm retries, least recently tried first; the next alarm takes the rest. */
export const LEASE_REVOKE_RETRIES_PER_ALARM = 5;

/** A failed lease or revoke call: the caller retries after this many seconds. */
export const LEASE_RETRY_AFTER_SECONDS = 30;

/** Lease creations one workload may start per minute, whatever their outcome. */
export const LEASE_CREATES_PER_MINUTE = 4;

/**
 * Infisical's lease expiry may differ from the requested lifetime by this much (clock skew and the
 * call's own duration); a lease outside it is revoked at once.
 */
export const LEASE_EXPIRY_TOLERANCE_MS = 2 * 60 * 1000;

/** A lease row stays this long after the lease ended, for revoke answers and the rate count. */
export const LEASE_ROW_RETENTION_MS = 24 * 60 * 60 * 1000;
