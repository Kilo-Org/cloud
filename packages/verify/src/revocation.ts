import { ACCESS_TOKEN_ALGORITHM } from '@kilocode/sts-contracts';
import { base64url } from 'jose';
import { z } from 'zod';
import {
  abandoned,
  backoffMs,
  liveness,
  retryAfterSeconds,
  sleep,
  startOwned,
  type CallScope,
  type Liveness,
} from './flight';
import { UTS_FEED_KID_PREFIX } from './jwks';
import { decodeJws, hasJwsExtension, verifyEd25519 } from './jws';

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
/**
 * A feed refresh (the head, then the list when its hash changed) that has not answered by then
 * counts as a failure. It matches the feed Worker's 1-second fail-over to the second feed object.
 */
export const FEED_FETCH_TIMEOUT_MS = 1_000;
/** After a failed fetch, the next fetch waits this long. */
export const FEED_RETRY_MS = 5_000;
/** While the held copy still serves short tokens, each further failure doubles the wait, up to this. */
export const FEED_MAX_RETRY_MS = 30_000;
/** A head issued further than this in the future counts as a failed fetch: the design 5.6 clock skew. */
export const FEED_MAX_FUTURE_MS = 5_000;

/** JWS `typ` of a signed feed head. */
export const FEED_HEAD_TYPE = 'kilo-feed-head+jwt';

/**
 * The payload of a signed feed head (design 5.6): when a feed object signed it, as a JWT
 * NumericDate in seconds, and the base64url SHA-256 of the list bytes it covers.
 */
export const FeedHeadPayloadSchema = z.looseObject({
  iat: z.number().int().nonnegative(),
  list_hash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

/** The list as UTS serves it: UTF-8 JSON. Times are JWT NumericDates in seconds. */
export const RevocationListWireSchema = z.looseObject({
  /** Per subject: tokens issued at or before this time are revoked. */
  revoked_before: z.record(z.string().min(1), z.number().int().nonnegative()),
  /** Revoked grant and session ids, as carried in a token's `sid`. */
  revoked_sids: z.array(z.string().min(1)),
  /** Signing key ids removed in an emergency rotation. */
  revoked_kids: z.array(z.string().min(1)),
  /** Revoked PAT ids; an entry overrides every PAT cache layer. */
  revoked_pat_ids: z.array(z.string().min(1)),
  /** Blocked accounts, by subject. */
  blocked_accounts: z.array(z.string().min(1)),
});
export type RevocationListWire = z.infer<typeof RevocationListWireSchema>;

/** A verified head. `issuedAt` is a JWT NumericDate in seconds. */
export type FeedHead = { issuedAt: number; listHash: string };

/** The parsed revocation list, held in memory. Times are JWT NumericDates in seconds. */
export type RevocationList = {
  revokedBefore: ReadonlyMap<string, number>;
  revokedSids: ReadonlySet<string>;
  revokedKids: ReadonlySet<string>;
  revokedPatIds: ReadonlySet<string>;
  blockedAccounts: ReadonlySet<string>;
};

/**
 * The UTS revocation feed (phase 3 implements the transport: a service binding on Workers, HTTPS
 * on Vercel and Fly). It returns raw bytes; the library verifies them. Any rejection is a failed
 * fetch.
 */
export type RevocationFeedSource = {
  /** The current head: a compact JWS, `typ` `FEED_HEAD_TYPE`, signed under a feed `kid`. */
  head(signal: AbortSignal): Promise<string>;
  /** The list bytes whose SHA-256 is `listHash` (cacheable by that hash). */
  list(listHash: string, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>>;
};

/** Looks up a feed key of the UTS key set by `kid`; null when the set holds none under it. */
export type FeedKeyLookup = (kid: string) => CryptoKey | null;

/** A verified head with its verified, parsed list. */
export type OpenedFeed = { head: FeedHead; list: RevocationList };

const FeedHeadHeaderSchema = z.looseObject({
  alg: z.literal(ACCESS_TOKEN_ALGORITHM),
  typ: z.literal(FEED_HEAD_TYPE),
  kid: z.string().startsWith(UTS_FEED_KID_PREFIX),
});

/** Verifies a signed head under a feed key (design 5.6); throws when it does not verify. */
export async function verifyFeedHead(compact: string, feedKey: FeedKeyLookup): Promise<FeedHead> {
  const jws = decodeJws(compact);
  if (jws === null || hasJwsExtension(jws.header)) throw new Error('malformed feed head');
  const header = FeedHeadHeaderSchema.parse(jws.header);
  const key = feedKey(header.kid);
  if (key === null) throw new Error('feed head signed under an unknown feed key');
  if (!(await verifyEd25519(key, jws))) throw new Error('feed head signature does not verify');
  const payload = FeedHeadPayloadSchema.parse(jws.payload);
  return { issuedAt: payload.iat, listHash: payload.list_hash };
}

/** Checks list bytes against the head's hash and parses them; throws on any mismatch. */
export async function parseRevocationList(
  listHash: string,
  bytes: Uint8Array<ArrayBuffer>
): Promise<RevocationList> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  if (base64url.encode(digest) !== listHash) throw new Error('list does not match the head hash');
  const wire = RevocationListWireSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  return {
    revokedBefore: new Map(Object.entries(wire.revoked_before)),
    revokedSids: new Set(wire.revoked_sids),
    revokedKids: new Set(wire.revoked_kids),
    revokedPatIds: new Set(wire.revoked_pat_ids),
    blockedAccounts: new Set(wire.blocked_accounts),
  };
}

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
  /** Whether no copy was ever held. */
  cold(): boolean;
  /** Takes a head and list loaded elsewhere (the UTS bootstrap); false when the head does not count. */
  install(opened: OpenedFeed, at: number): boolean;
};

/** `headAt`: when the head was signed, in ms, never later than when it was fetched. */
type Copy = OpenedFeed & { fetchedAt: number; headAt: number };
type Attempt = Liveness & { id: number };
type Failure = { attemptId: number; retryAt: number; consecutive: number };

/**
 * The isolate's copy of the feed. `feedKey` reads the feed keys of the held UTS key set; the caller
 * makes sure that set is loaded before it reads the feed.
 */
export function createRevocationFeed(
  source: RevocationFeedSource,
  feedKey: (kid: string, now: number) => CryptoKey | null
): RevocationFeed {
  let copy: Copy | null = null;
  let attempt: Attempt | null = null;
  let failure: Failure | null = null;
  let nextAttemptId = 1;

  /**
   * Records `done` as failed: past its timeout, answered with an error or a head that does not
   * count, or dropped because its request was cancelled. The retry wait doubles per consecutive
   * failure while the copy still serves short tokens.
   */
  function fail(done: Attempt, at: number): void {
    if (attempt?.id !== done.id) return;
    attempt = null;
    const consecutive = (failure?.consecutive ?? 0) + 1;
    const serving = copy !== null && at - copy.headAt <= FEED_SHORT_CREDENTIAL_MAX_HEAD_AGE_MS;
    const wait = serving ? backoffMs(FEED_RETRY_MS, FEED_MAX_RETRY_MS, consecutive) : FEED_RETRY_MS;
    failure = { attemptId: done.id, retryAt: at + wait, consecutive };
  }

  /**
   * Takes `opened` as the copy unless its head does not count: over 30 s old, more than 5 s in the
   * future, older than the held head, or signed in the same second as the held head over another
   * list. `iat` has one-second resolution and two feed objects sign heads, so of two lists signed
   * in one second neither is known to be the newer; the held one stays until a later head comes.
   */
  function adopt(opened: OpenedFeed, at: number): boolean {
    const signedAt = opened.head.issuedAt * 1000;
    const counts =
      at - signedAt <= FEED_MAX_FETCHED_HEAD_AGE_MS &&
      signedAt - at <= FEED_MAX_FUTURE_MS &&
      (copy === null ||
        opened.head.issuedAt > copy.head.issuedAt ||
        (opened.head.issuedAt === copy.head.issuedAt &&
          opened.head.listHash === copy.head.listHash));
    if (!counts) return false;
    copy = { ...opened, fetchedAt: at, headAt: Math.min(signedAt, at) };
    return true;
  }

  function start(scope: CallScope, at: number): Attempt {
    const started: Attempt = { ...liveness(scope, at), id: nextAttemptId++ };
    attempt = started;
    startOwned(scope, started, FEED_FETCH_TIMEOUT_MS, async answered => {
      try {
        const signal = AbortSignal.timeout(FEED_FETCH_TIMEOUT_MS);
        const head = await verifyFeedHead(await source.head(signal), kid =>
          feedKey(kid, Date.now())
        );
        const held = copy;
        const list =
          held !== null && held.head.listHash === head.listHash
            ? held.list
            : await parseRevocationList(head.listHash, await source.list(head.listHash, signal));
        // A valid answer counts even after its call timed out; it then clears only older failures.
        if (!adopt({ head, list }, Date.now())) {
          fail(started, Date.now());
        } else {
          if (attempt?.id === started.id) attempt = null;
          if (failure !== null && failure.attemptId <= started.id) failure = null;
        }
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
      if (
        attempt !== null &&
        (now >= attempt.startedAt + FEED_FETCH_TIMEOUT_MS || abandoned(attempt, scope, now))
      ) {
        // Past its timeout, or its request was cancelled and it will never answer: a failed
        // fetch, so the retry wait applies before the next one.
        fail(attempt, Math.min(now, attempt.startedAt + FEED_FETCH_TIMEOUT_MS));
        continue;
      }
      const canStart = attempt === null && (failure === null || now >= failure.retryAt);
      const headAge = copy === null ? Number.POSITIVE_INFINITY : now - copy.headAt;

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

  return {
    read,
    cold: () => copy === null,
    install(opened, at) {
      if (!adopt(opened, at)) return false;
      failure = null;
      return true;
    },
  };
}

/** The head-age limit for a token of this lifetime (design 7 fail-closed rules). */
export function maxHeadAgeForLifetime(lifetimeSeconds: number): number {
  return lifetimeSeconds <= SHORT_CREDENTIAL_MAX_LIFETIME_SECONDS
    ? FEED_SHORT_CREDENTIAL_MAX_HEAD_AGE_MS
    : FEED_LONG_CREDENTIAL_MAX_HEAD_AGE_MS;
}
