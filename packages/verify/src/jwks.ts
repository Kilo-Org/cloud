import { Ed25519PublicJwkSchema, JWKS_PATH } from '@kilocode/sts-contracts';
import { z } from 'zod';
import {
  abandoned,
  liveness,
  retryAfterSeconds,
  sleep,
  startOwned,
  type CallScope,
  type Liveness,
} from './flight';

/** A key set lives 5 minutes (design 7, matching the issuer's `max-age=300`). */
export const JWKS_TTL_MS = 5 * 60_000;
/** A request that finds the set older than 4 minutes starts a background refresh. */
export const JWKS_REFRESH_AFTER_MS = 4 * 60_000;
/** The last good set serves past its lifetime only while the issuer is unreachable, up to 24 hours. */
export const JWKS_MAX_STALE_MS = 24 * 60 * 60_000;
/** An unknown `kid` refreshes the set at most once per 5 minutes. */
export const UNKNOWN_KID_REFRESH_INTERVAL_MS = 5 * 60_000;
/** A key-set fetch that has not answered by then counts as a failure. */
export const JWKS_FETCH_TIMEOUT_MS = 5_000;
/** After a failed fetch, the next fetch waits this long; requests meanwhile serve the last good set. */
export const JWKS_RETRY_MS = 5_000;

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

/**
 * The token-signing keys of a key-set body: each Ed25519 entry with a `kid`. Other entries, such as
 * revocation-feed keys or keys of another type, are skipped; a duplicate `kid` refuses the set.
 */
export async function importKeySet(body: unknown): Promise<Map<string, CryptoKey>> {
  const document = JwksDocumentSchema.parse(body);
  const keys = new Map<string, CryptoKey>();
  for (const entry of document.keys) {
    const parsed = Ed25519PublicJwkSchema.safeParse(entry);
    if (!parsed.success) continue;
    const { kid, x } = parsed.data;
    if (keys.has(kid)) throw new Error(`key set lists kid ${kid} twice`);
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'OKP', crv: 'Ed25519', x },
      { name: 'Ed25519' },
      false,
      ['verify']
    );
    keys.set(kid, key);
  }
  return keys;
}

export type KeyLookup =
  | { status: 'key'; key: CryptoKey }
  | { status: 'unknown_kid' }
  | { status: 'unavailable'; retryAfterSeconds: number };

export type KeySetCache = {
  /** Resolves `kid` in this issuer's set, refreshing per design 7; `scope` collects the calls it starts. */
  key(kid: string, scope: CallScope): Promise<KeyLookup>;
};

type KeySet = { keys: ReadonlyMap<string, CryptoKey>; fetchedAt: number };
/** `forUnknownKid`: the refresh an unknown `kid` started, which counts against its rate limit. */
type Attempt = Liveness & { id: number; forUnknownKid: boolean };
type Failure = { attemptId: number; retryAt: number };

/**
 * One issuer's key set, shared by every request in the isolate. State is plain data (see
 * `flight.ts`); concurrent refreshes merge into one fetch.
 */
export function createKeySetCache(source: JwksSource): KeySetCache {
  let set: KeySet | null = null;
  let attempt: Attempt | null = null;
  let failure: Failure | null = null;
  let unknownKidRefreshAt: number | null = null;
  let nextAttemptId = 1;
  let appliedAttemptId = 0;

  function succeed(done: Attempt, keys: Map<string, CryptoKey>, at: number): void {
    if (attempt?.id === done.id) attempt = null;
    if (done.id <= appliedAttemptId) return;
    appliedAttemptId = done.id;
    set = { keys, fetchedAt: at };
    failure = null;
  }

  function fail(done: Attempt, at: number): void {
    if (attempt?.id !== done.id) return;
    attempt = null;
    failure = { attemptId: done.id, retryAt: at + JWKS_RETRY_MS };
  }

  function start(scope: CallScope, at: number, forUnknownKid = false): Attempt {
    const started: Attempt = { ...liveness(scope, at), id: nextAttemptId++, forUnknownKid };
    attempt = started;
    startOwned(scope, started, JWKS_FETCH_TIMEOUT_MS, async answered => {
      try {
        const body = await source(AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS));
        succeed(started, await importKeySet(body), Date.now());
      } catch {
        fail(started, Date.now());
      }
      answered();
    });
    return started;
  }

  function unavailable(now: number): KeyLookup {
    return {
      status: 'unavailable',
      retryAfterSeconds: retryAfterSeconds(failure?.retryAt ?? now, now),
    };
  }

  async function key(kid: string, scope: CallScope): Promise<KeyLookup> {
    /** The refresh this lookup started or joined for an unknown `kid`. */
    let refreshFor: number | null = null;
    for (;;) {
      const now = Date.now();
      if (attempt !== null && now >= attempt.startedAt + JWKS_FETCH_TIMEOUT_MS) {
        fail(attempt, attempt.startedAt + JWKS_FETCH_TIMEOUT_MS);
        continue;
      }
      if (attempt !== null && abandoned(attempt, scope, now)) {
        // Its request was cancelled, so it will never answer. That says nothing about the issuer:
        // no backoff, and an unknown-kid refresh that never ran does not count against the limit.
        if (attempt.forUnknownKid) unknownKidRefreshAt = null;
        if (refreshFor === attempt.id) refreshFor = null;
        attempt = null;
        continue;
      }
      const backingOff = failure !== null && now < failure.retryAt;
      const age = set === null ? Number.POSITIVE_INFINITY : now - set.fetchedAt;

      if (set === null || age >= JWKS_TTL_MS) {
        // Cold or expired: refresh synchronously; once that fails, the issuer is unreachable. That
        // refresh also answers an unknown kid, so it never triggers a second one.
        if (attempt !== null) {
          refreshFor ??= attempt.id;
          await sleep(scope, attempt.startedAt + JWKS_FETCH_TIMEOUT_MS);
          continue;
        }
        if (!backingOff) {
          refreshFor ??= start(scope, now).id;
          continue;
        }
        if (set === null || age >= JWKS_MAX_STALE_MS) return unavailable(now);
        const stale = set.keys.get(kid);
        return stale === undefined ? unavailable(now) : { status: 'key', key: stale };
      }

      if (age >= JWKS_REFRESH_AFTER_MS && attempt === null && !backingOff) start(scope, now);
      const found = set.keys.get(kid);
      if (found !== undefined) return { status: 'key', key: found };

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
      refreshFor = start(scope, now, true).id;
    }
  }

  return { key };
}
