import {
  abandoned,
  liveness,
  retryAfterSeconds,
  sleep,
  startOwned,
  type CallScope,
  type Liveness,
} from './flight';

/** A request starts a background feed refresh this long after the last successful fetch. */
export const FEED_REFRESH_AFTER_MS = 10_000;
/** A request waits for a refresh once the held signed head is older than this. */
export const FEED_WAIT_AFTER_MS = 30_000;
/** A fetched head older than this counts as a failed fetch. */
export const FEED_MAX_FETCHED_HEAD_AGE_MS = 30_000;
/** Head-age limit for a token that lives 10 minutes or less. */
export const FEED_SHORT_CREDENTIAL_MAX_HEAD_AGE_MS = 10 * 60_000;
/** Head-age limit for a longer-lived credential (PAT, 1-hour CI token, 1-hour sandbox fallback). */
export const FEED_LONG_CREDENTIAL_MAX_HEAD_AGE_MS = 60_000;
/** Lifetime up to which a token counts as short for the head-age limit. */
export const SHORT_CREDENTIAL_MAX_LIFETIME_SECONDS = 10 * 60;
/** A feed fetch that has not answered by then counts as a failure. */
export const FEED_FETCH_TIMEOUT_MS = 5_000;
/** After a failed fetch, the next fetch waits this long. */
export const FEED_RETRY_MS = 5_000;
/** A head issued further than this in the future counts as a failed fetch. */
const FEED_MAX_FUTURE_MS = 60_000;

/** The signed head: when a feed object signed it and the hash of the list it covers. */
export type FeedHead = { issuedAt: number; listHash: string };

/** The parsed revocation list (design 5.6). Times are JWT NumericDates in seconds. */
export type RevocationList = {
  /** Per subject: tokens issued at or before this time are revoked. */
  revokedBefore: ReadonlyMap<string, number>;
  /** Revoked grant and session ids, as carried in a token's `sid`. */
  revokedSids: ReadonlySet<string>;
  /** Signing key ids removed in an emergency rotation. */
  revokedKids: ReadonlySet<string>;
  /** Revoked PAT ids; an entry overrides every PAT cache layer. */
  revokedPatIds: ReadonlySet<string>;
  /** Blocked accounts, by subject. */
  blockedAccounts: ReadonlySet<string>;
};

/** `list` is null when the head's `listHash` equals the held head's: the held list still applies. */
export type FeedFetch = { head: FeedHead; list: RevocationList | null };

/**
 * The UTS revocation feed (phase 3 implements it: a service binding on Workers, HTTPS on Vercel
 * and Fly, or the bootstrap endpoint at cold start). `fetch` must verify the head signature against
 * the UTS feed keys and a new list against `head.listHash` before it resolves; it fetches the list
 * only when the hash differs from `held`. Any rejection is a failed fetch.
 */
export type RevocationFeedSource = {
  fetch(held: FeedHead | null, signal: AbortSignal): Promise<FeedFetch>;
};

export type FeedRead =
  | { status: 'ok'; list: RevocationList }
  | { status: 'unavailable'; retryAfterSeconds: number };

export type RevocationFeed = {
  /**
   * The held list when its signed head is at most `maxHeadAgeMs` old, after the request-driven
   * revalidation of design 7: a background refresh 10 s after the last fetch, a wait once the head
   * is over 30 s old.
   */
  read(maxHeadAgeMs: number, scope: CallScope): Promise<FeedRead>;
};

type Copy = { head: FeedHead; list: RevocationList; fetchedAt: number };
type Attempt = Liveness & { id: number };
type Failure = { attemptId: number; retryAt: number };

export function createRevocationFeed(source: RevocationFeedSource): RevocationFeed {
  let copy: Copy | null = null;
  let attempt: Attempt | null = null;
  let failure: Failure | null = null;
  let nextAttemptId = 1;

  function fail(done: Attempt, at: number): void {
    if (attempt?.id !== done.id) return;
    attempt = null;
    failure = { attemptId: done.id, retryAt: at + FEED_RETRY_MS };
  }

  /**
   * Applies a fetch, or records it as failed: a head over 30 s old or far in the future, a head
   * older than the held one, or an unchanged-list answer whose hash is not the held list's.
   */
  function apply(done: Attempt, fetched: FeedFetch, at: number): void {
    const head = fetched.head;
    const held = copy;
    const list =
      fetched.list ?? (held !== null && held.head.listHash === head.listHash ? held.list : null);
    const acceptable =
      list !== null &&
      at - head.issuedAt <= FEED_MAX_FETCHED_HEAD_AGE_MS &&
      head.issuedAt - at <= FEED_MAX_FUTURE_MS &&
      (held === null || head.issuedAt >= held.head.issuedAt);
    if (!acceptable) {
      fail(done, at);
      return;
    }
    copy = { head, list, fetchedAt: at };
    if (attempt?.id === done.id) attempt = null;
    if (failure !== null && failure.attemptId < done.id) failure = null;
  }

  function start(scope: CallScope, at: number): Attempt {
    const started: Attempt = { ...liveness(scope, at), id: nextAttemptId++ };
    attempt = started;
    const held = copy?.head ?? null;
    startOwned(scope, started, FEED_FETCH_TIMEOUT_MS, async answered => {
      try {
        const fetched = await source.fetch(held, AbortSignal.timeout(FEED_FETCH_TIMEOUT_MS));
        apply(started, fetched, Date.now());
      } catch {
        fail(started, Date.now());
      }
      answered();
    });
    return started;
  }

  async function read(maxHeadAgeMs: number, scope: CallScope): Promise<FeedRead> {
    let waited = false;
    for (;;) {
      const now = Date.now();
      if (attempt !== null && now >= attempt.startedAt + FEED_FETCH_TIMEOUT_MS) {
        fail(attempt, attempt.startedAt + FEED_FETCH_TIMEOUT_MS);
        continue;
      }
      if (attempt !== null && abandoned(attempt, scope, now)) {
        // Its request was cancelled, so it will never answer; this request may start its own.
        attempt = null;
        waited = false;
        continue;
      }
      const canStart = attempt === null && (failure === null || now >= failure.retryAt);
      const headAge = copy === null ? Number.POSITIVE_INFINITY : now - copy.head.issuedAt;

      if (headAge > FEED_WAIT_AFTER_MS) {
        if (attempt !== null) {
          waited = true;
          await sleep(scope, attempt.startedAt + FEED_FETCH_TIMEOUT_MS);
          continue;
        }
        if (canStart && !waited) {
          waited = true;
          start(scope, now);
          continue;
        }
      } else if (copy !== null && now - copy.fetchedAt >= FEED_REFRESH_AFTER_MS && canStart) {
        start(scope, now);
      }

      if (copy === null || headAge > maxHeadAgeMs) {
        return {
          status: 'unavailable',
          retryAfterSeconds: retryAfterSeconds(failure?.retryAt ?? now, now),
        };
      }
      return { status: 'ok', list: copy.list };
    }
  }

  return { read };
}

/** The head-age limit for a token of this lifetime (design 7 fail-closed rules). */
export function maxHeadAgeForLifetime(lifetimeSeconds: number): number {
  return lifetimeSeconds <= SHORT_CREDENTIAL_MAX_LIFETIME_SECONDS
    ? FEED_SHORT_CREDENTIAL_MAX_HEAD_AGE_MS
    : FEED_LONG_CREDENTIAL_MAX_HEAD_AGE_MS;
}
