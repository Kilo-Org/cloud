import { Ed25519PublicJwkSchema, JWKS_PATH } from '@kilocode/sts-contracts';
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

/**
 * A key set lives 5 minutes (design 7): the UTS key set's `max-age=300`. STS answers its key set
 * with `no-store`; the verifier still keeps an STS set for 5 minutes.
 */
export const JWKS_TTL_MS = 5 * 60_000;
/** A request that finds the set older than 4 minutes starts a background refresh. */
export const JWKS_REFRESH_AFTER_MS = 4 * 60_000;
/**
 * The last good UTS set serves past its lifetime only while UTS is unreachable, up to 24 hours. An
 * STS set never serves past its lifetime, so an STS `kid` removal reaches every verifier within 5
 * minutes (design 7).
 */
export const JWKS_MAX_STALE_MS = 24 * 60 * 60_000;
/** An unknown `kid` refreshes the set at most once per 5 minutes. */
export const UNKNOWN_KID_REFRESH_INTERVAL_MS = 5 * 60_000;
/** A key-set fetch that has not answered by then counts as a failure. */
export const JWKS_FETCH_TIMEOUT_MS = 5_000;
/**
 * A request that holds a last good UTS set waits this long for the refresh of an expired set. An
 * issuer that has not answered by then counts as unreachable for that request, which then uses
 * the last good set; a request without one waits for the whole fetch timeout.
 */
export const JWKS_STALE_WAIT_MS = 1_000;
/** After a failed fetch, the next fetch waits this long. */
export const JWKS_RETRY_MS = 5_000;
/** While the held set still serves, each further failure doubles the retry wait, up to this. */
export const JWKS_MAX_RETRY_MS = 60_000;

/**
 * The `kid` prefix of every UTS token-signing key. UTS must publish its token keys under it; a
 * UTS token under any other `kid` is refused before any key-set fetch.
 */
export const UTS_TOKEN_KID_PREFIX = 'uts-token-';
/**
 * The `kid` prefix of every revocation-feed key in the UTS key set. UTS must publish its feed keys
 * under it. A key under this prefix never verifies a token, from any issuer, and the feed accepts
 * a head signed only under it.
 */
export const UTS_FEED_KID_PREFIX = 'uts-feed-';

/**
 * Fetches an issuer's key set and returns the parsed JSON body; any rejection is a fetch failure.
 * The cache validates the body, so a source never needs to.
 */
export type JwksSource = (signal: AbortSignal) => Promise<unknown>;

/** The subset of `fetch` a key-set source uses; a Worker service binding's `fetch` fits it. */
export type FetchLike = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> }
) => Promise<Response>;

/**
 * The default source: `GET <issuer>/.well-known/jwks.json` over HTTPS (or through `fetcher`, such
 * as a service binding). A non-200 answer or a body that is not JSON is a failure.
 */
export function httpJwksSource(
  issuer: string,
  fetcher: FetchLike = (url, init) => fetch(url, init)
): JwksSource {
  const url = `${issuer.replace(/\/+$/, '')}${JWKS_PATH}`;
  return async signal => {
    const response = await fetcher(url, { signal, headers: { accept: 'application/json' } });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error(`key set answered HTTP ${response.status}`);
    }
    const body: unknown = await response.json();
    return body;
  };
}

const JwksDocumentSchema = z.object({ keys: z.array(z.unknown()) });

/** Whose key set: STS publishes token keys only; UTS publishes token keys and feed keys. */
export type KeySetKind = 'sts' | 'uts';

/** The keys of one key-set body, by `kid`. */
export type ImportedKeys = {
  tokenKeys: ReadonlyMap<string, CryptoKey>;
  /** UTS revocation-feed keys; always empty for STS. */
  feedKeys: ReadonlyMap<string, CryptoKey>;
};

/**
 * The Ed25519 keys of a key-set body, split by `kid` prefix: a `UTS_FEED_KID_PREFIX` key is a feed
 * key in a UTS set and skipped in an STS set; a UTS token key must carry `UTS_TOKEN_KID_PREFIX`.
 * Entries of another type and UTS entries under neither prefix are skipped; a duplicate `kid`
 * refuses the set.
 */
export async function importKeySet(body: unknown, kind: KeySetKind): Promise<ImportedKeys> {
  const document = JwksDocumentSchema.parse(body);
  const tokenKeys = new Map<string, CryptoKey>();
  const feedKeys = new Map<string, CryptoKey>();
  const seen = new Set<string>();
  for (const entry of document.keys) {
    const parsed = Ed25519PublicJwkSchema.safeParse(entry);
    if (!parsed.success) continue;
    const { kid, x } = parsed.data;
    if (seen.has(kid)) throw new Error(`key set lists kid ${kid} twice`);
    seen.add(kid);
    const isFeedKey = kid.startsWith(UTS_FEED_KID_PREFIX);
    const target = isFeedKey
      ? kind === 'uts'
        ? feedKeys
        : null
      : kind === 'sts' || kid.startsWith(UTS_TOKEN_KID_PREFIX)
        ? tokenKeys
        : null;
    if (target === null) continue;
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'OKP', crv: 'Ed25519', x },
      { name: 'Ed25519' },
      false,
      ['verify']
    );
    target.set(kid, key);
  }
  return { tokenKeys, feedKeys };
}

export type KeyLookup =
  | { status: 'key'; key: CryptoKey }
  | { status: 'unknown_kid' }
  | { status: 'unavailable'; retryAfterSeconds: number };

export type KeySetReady =
  | { status: 'ready' }
  | { status: 'unavailable'; retryAfterSeconds: number };

export type KeySetCache = {
  /** Resolves a token key in this issuer's set, refreshing per design 7; `scope` collects the calls it starts. */
  key(kid: string, scope: CallScope): Promise<KeyLookup>;
  /** Makes sure a usable set is held, refreshing per design 7 like `key` does for a known `kid`. */
  ready(scope: CallScope): Promise<KeySetReady>;
  /** A feed key of the held set, while that set is within its 24-hour bound. No I/O. */
  feedKey(kid: string, now: number): CryptoKey | null;
  /** Whether no set was ever loaded. */
  cold(): boolean;
  /** Takes a set loaded elsewhere (the UTS bootstrap), unless a newer one is held. */
  install(keys: ImportedKeys, at: number): void;
  /** Starts a fetch when cold, idle and outside the retry wait, without waiting for it. */
  prefetch(scope: CallScope): void;
};

type KeySet = ImportedKeys & { fetchedAt: number };
type Attempt = Liveness & { id: number };
type Failure = { attemptId: number; retryAt: number; consecutive: number };

/**
 * One issuer's key set, shared by every request in the isolate. State is plain data (see
 * `flight.ts`); concurrent refreshes merge into one fetch.
 */
export function createKeySetCache(source: JwksSource, kind: KeySetKind): KeySetCache {
  /** How long the held set serves after it was fetched: 24 h for UTS, its lifetime for STS. */
  const servesForMs = kind === 'uts' ? JWKS_MAX_STALE_MS : JWKS_TTL_MS;
  let set: KeySet | null = null;
  let attempt: Attempt | null = null;
  let failure: Failure | null = null;
  let unknownKidRefreshAt: number | null = null;
  let nextAttemptId = 1;
  let appliedAttemptId = 0;

  function succeed(done: Attempt, keys: ImportedKeys, at: number): void {
    if (attempt?.id === done.id) attempt = null;
    if (done.id <= appliedAttemptId) return;
    appliedAttemptId = done.id;
    set = { ...keys, fetchedAt: at };
    failure = null;
  }

  /**
   * Records `done` as failed: past its timeout, answered with an error, or dropped because its
   * request was cancelled. The retry wait doubles per consecutive failure while a last good set
   * serves; without one it stays at `JWKS_RETRY_MS`.
   */
  function fail(done: Attempt, at: number): void {
    if (attempt?.id !== done.id) return;
    attempt = null;
    const consecutive = (failure?.consecutive ?? 0) + 1;
    const serving = set !== null && at - set.fetchedAt < servesForMs;
    const wait = serving ? backoffMs(JWKS_RETRY_MS, JWKS_MAX_RETRY_MS, consecutive) : JWKS_RETRY_MS;
    failure = { attemptId: done.id, retryAt: at + wait, consecutive };
  }

  function start(scope: CallScope, at: number): Attempt {
    const started: Attempt = { ...liveness(scope, at), id: nextAttemptId++ };
    attempt = started;
    startOwned(scope, started, JWKS_FETCH_TIMEOUT_MS, async answered => {
      try {
        const body = await source(AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS));
        succeed(started, await importKeySet(body, kind), Date.now());
      } catch {
        fail(started, Date.now());
      }
      answered();
    });
    return started;
  }

  function unavailable(now: number): { status: 'unavailable'; retryAfterSeconds: number } {
    return {
      status: 'unavailable',
      retryAfterSeconds: retryAfterSeconds(failure?.retryAt ?? now, now),
    };
  }

  /** `kid` null: the caller needs a usable set, not a token key (the feed path). */
  async function lookup(kid: string | null, scope: CallScope): Promise<KeyLookup | KeySetReady> {
    /** The refresh this lookup started or joined. */
    let refreshFor: number | null = null;
    for (;;) {
      const now = Date.now();
      if (
        attempt !== null &&
        (now >= attempt.startedAt + JWKS_FETCH_TIMEOUT_MS || abandoned(attempt, scope, now))
      ) {
        // Past its timeout, or its request was cancelled and it will never answer: a failed
        // fetch. A cancelled unknown-kid refresh still counts against that limit.
        fail(attempt, Math.min(now, attempt.startedAt + JWKS_FETCH_TIMEOUT_MS));
        continue;
      }
      const backingOff = failure !== null && now < failure.retryAt;
      const age = set === null ? Number.POSITIVE_INFINITY : now - set.fetchedAt;
      /** What the held set answers for this lookup, while it still serves. */
      let held: { status: 'ready' } | { status: 'key'; key: CryptoKey } | undefined;
      if (set !== null && age < servesForMs) {
        const key = kid === null ? undefined : set.tokenKeys.get(kid);
        if (kid === null) held = { status: 'ready' };
        else if (key !== undefined) held = { status: 'key', key };
      }

      if (set === null || age >= JWKS_TTL_MS) {
        // Cold or expired: refresh synchronously. With a last good set that answers this lookup,
        // wait at most JWKS_STALE_WAIT_MS; after that, or once the refresh failed, the issuer is
        // unreachable and the last good set serves.
        if (attempt !== null) {
          refreshFor ??= attempt.id;
          const until =
            attempt.startedAt + (held === undefined ? JWKS_FETCH_TIMEOUT_MS : JWKS_STALE_WAIT_MS);
          if (held !== undefined && now >= until) return held;
          await sleep(scope, until);
          continue;
        }
        if (!backingOff) {
          refreshFor ??= start(scope, now).id;
          continue;
        }
        return held ?? unavailable(now);
      }

      if (age >= JWKS_REFRESH_AFTER_MS && attempt === null && !backingOff) start(scope, now);
      if (held !== undefined) return held;

      // Unknown kid on a fresh set: one refresh, at most once per interval.
      if (attempt !== null) {
        refreshFor ??= attempt.id;
        await sleep(scope, attempt.startedAt + JWKS_FETCH_TIMEOUT_MS);
        continue;
      }
      if (refreshFor !== null) {
        return failure?.attemptId === refreshFor ? unavailable(now) : { status: 'unknown_kid' };
      }
      if (
        unknownKidRefreshAt !== null &&
        now - unknownKidRefreshAt < UNKNOWN_KID_REFRESH_INTERVAL_MS
      ) {
        return { status: 'unknown_kid' };
      }
      if (backingOff) return unavailable(now);
      unknownKidRefreshAt = now;
      refreshFor = start(scope, now).id;
    }
  }

  return {
    async key(kid, scope) {
      const found = await lookup(kid, scope);
      if (found.status === 'ready') throw new Error('unreachable: a kid lookup answers a key');
      return found;
    },
    async ready(scope) {
      const found = await lookup(null, scope);
      if (found.status === 'unavailable' || found.status === 'ready') return found;
      throw new Error('unreachable: a set lookup answers ready or unavailable');
    },
    feedKey(kid, now) {
      if (set === null || now - set.fetchedAt >= servesForMs) return null;
      return set.feedKeys.get(kid) ?? null;
    },
    cold: () => set === null,
    install(keys, at) {
      if (set !== null && set.fetchedAt > at) return;
      set = { ...keys, fetchedAt: at };
      failure = null;
    },
    prefetch(scope) {
      const now = Date.now();
      const backingOff = failure !== null && now < failure.retryAt;
      if (set === null && attempt === null && !backingOff) start(scope, now);
    },
  };
}
