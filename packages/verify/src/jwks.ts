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
 * A key set lives 5 minutes (design 7, matching the issuer's `max-age=300`), counted from the read
 * of its newest keys: its fetch minus the response's `Age`.
 */
export const JWKS_TTL_MS = 5 * 60_000;
/** A request that finds the set older than 4 minutes (±20 %) starts a background refresh. */
export const JWKS_REFRESH_AFTER_MS = 4 * 60_000;
/**
 * The last good UTS set serves past its lifetime only while UTS is unreachable, up to 24 hours
 * after the read of its oldest keys (`Kilo-Key-Set-Oldest-Age`). An STS set never serves past its
 * lifetime, so an STS `kid` removal reaches every verifier within 5 minutes (design 7).
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
 * Each background-refresh point and each retry wait moves by up to this share of itself, either
 * way, at random, so verifiers do not refresh in lockstep (design 7).
 */
export const JWKS_JITTER = 0.2;
/** The UTS response header with the age of the set's oldest keys; `Age` carries the newest. */
export const KEY_SET_OLDEST_AGE_HEADER = 'kilo-key-set-oldest-age';

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
 * The ages of a UTS key set when the feed Worker answered, in whole seconds (design 5.7, Q55):
 * `newest` since its newest signer keys were read (the `Age` header), `oldest` since its oldest
 * ones were (`Kilo-Key-Set-Oldest-Age`), `0 <= newest <= oldest`.
 */
export type KeySetAges = { newest: number; oldest: number };

const KeySetAgesSchema = z
  .object({ newest: z.int().min(0), oldest: z.int().min(0) })
  .refine(ages => ages.oldest >= ages.newest);

/** `value` as valid key-set ages, or null. */
export function parseKeySetAges(value: unknown): KeySetAges | null {
  const parsed = KeySetAgesSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Fetches an issuer's key set: the parsed JSON body and the response's ages in whole seconds,
 * null when absent: `age` (the `Age` header) and `oldestAge` (`Kilo-Key-Set-Oldest-Age`). Any
 * rejection is a fetch failure. The cache validates all three, so a source never needs to. A UTS
 * set needs both ages, `age <= oldestAge`; an STS set counts a missing `age` as 0 (STS sends
 * none, but a proxy may add one) and ignores `oldestAge`. Invalid ages are a failed refresh.
 */
export type JwksSource = (
  signal: AbortSignal
) => Promise<{ body: unknown; age: number | null; oldestAge: number | null }>;

/** The subset of `fetch` a key-set source uses; a Worker service binding's `fetch` fits it. */
export type FetchLike = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> }
) => Promise<Response>;

/**
 * The default source: `GET <issuer>/.well-known/jwks.json` over HTTPS (or through `fetcher`, such
 * as a service binding). A non-200 answer, a body that is not JSON, or an `Age` or
 * `Kilo-Key-Set-Oldest-Age` header that is not whole non-negative seconds is a failure. No HTTP
 * cache sits in between (design 5.7).
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
    return {
      body,
      age: headerSeconds(response.headers, 'age'),
      oldestAge: headerSeconds(response.headers, KEY_SET_OLDEST_AGE_HEADER),
    };
  };
}

/** An HTTP delta-seconds header (RFC 9111): null when absent; any other form fails the fetch. */
function headerSeconds(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  if (value === null) return null;
  if (!/^[0-9]+$/.test(value)) throw new Error(`key set answered a malformed ${name} header`);
  return Number(value);
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
  /** Whether no set is held. */
  cold(): boolean;
  /**
   * Takes a UTS set loaded elsewhere (the bootstrap), with the ages it was answered with and when
   * its call started, unless the held set has newer keys or this one no longer serves.
   */
  install(keys: ImportedKeys, keyAges: KeySetAges, fetchedAt: number): void;
  /** Starts a fetch when cold, idle and outside the retry wait, without waiting for it. */
  prefetch(scope: CallScope): void;
};

/** One loaded set; every time is on this instance's clock, in ms. */
type KeySet = ImportedKeys & {
  /** When its newest keys were read: the 5-minute lifetime counts from it. */
  newestReadAt: number;
  /** When a request starts a background refresh: 4 minutes after `newestReadAt`, ±20 %. */
  refreshAt: number;
  /** When it stops serving: 24 hours after the read of its oldest keys (UTS), its expiry (STS). */
  servesUntil: number;
  /** Between two sets with the same `newestReadAt`, the later load wins. */
  loadId: number;
};
type Attempt = Liveness & { id: number };
/** The refresh state: one fetch at a time, then the retry wait after a failed one. */
type Refresh =
  | { state: 'idle' }
  | { state: 'fetching'; attempt: Attempt; failuresBefore: number }
  | {
      state: 'failed';
      attempt: { id: number; startedAt: number };
      retryAt: number;
      consecutive: number;
    };

/** `ms` moved by up to ±`JWKS_JITTER` of itself, at random. */
function jittered(ms: number): number {
  return ms + Math.round(ms * JWKS_JITTER * (2 * Math.random() - 1));
}

/**
 * One issuer's key set, shared by every request in the isolate. State is plain data (see
 * `flight.ts`); concurrent refreshes merge into one fetch.
 */
export function createKeySetCache(source: JwksSource, kind: KeySetKind): KeySetCache {
  let set: KeySet | null = null;
  let refresh: Refresh = { state: 'idle' };
  let unknownKidRefreshAt: number | null = null;
  /** Numbers fetches and installs in the order they start. */
  let nextLoadId = 1;

  /**
   * A set as of `fetchedAt`, the start of its call, so the time a call takes never makes keys
   * look younger. An STS set ignores `ages.oldest`.
   */
  function load(keys: ImportedKeys, ages: KeySetAges, fetchedAt: number, loadId: number): KeySet {
    const newestReadAt = fetchedAt - ages.newest * 1000;
    return {
      ...keys,
      newestReadAt,
      refreshAt: newestReadAt + jittered(JWKS_REFRESH_AFTER_MS),
      servesUntil:
        kind === 'uts'
          ? fetchedAt - ages.oldest * 1000 + JWKS_MAX_STALE_MS
          : newestReadAt + JWKS_TTL_MS,
      loadId,
    };
  }

  /**
   * Holds `loaded` unless it no longer serves, or the held set still serves and has newer keys
   * (the same newest read: the later load wins).
   */
  function hold(loaded: KeySet, now: number): boolean {
    if (now >= loaded.servesUntil) return false;
    if (
      set !== null &&
      now < set.servesUntil &&
      (loaded.newestReadAt < set.newestReadAt ||
        (loaded.newestReadAt === set.newestReadAt && loaded.loadId < set.loadId))
    ) {
      return false;
    }
    set = loaded;
    return true;
  }

  /** A set past its refresh point when it arrives brings no newer keys (design 7). */
  const fresh = (loaded: KeySet, now: number): boolean =>
    now < loaded.refreshAt && now < loaded.servesUntil;

  /**
   * Records `done` as failed: past its timeout, answered with an error or a stale set, or dropped
   * because its request was cancelled. The retry wait doubles per consecutive failure while a
   * last good set serves; without one it stays at `JWKS_RETRY_MS`. Both get the jitter.
   */
  function fail(done: Attempt, at: number): void {
    if (refresh.state !== 'fetching' || refresh.attempt.id !== done.id) return;
    const consecutive = refresh.failuresBefore + 1;
    const serving = set !== null && at < set.servesUntil;
    const wait = serving ? backoffMs(JWKS_RETRY_MS, JWKS_MAX_RETRY_MS, consecutive) : JWKS_RETRY_MS;
    refresh = {
      state: 'failed',
      attempt: { id: done.id, startedAt: done.startedAt },
      retryAt: at + jittered(wait),
      consecutive,
    };
  }

  /**
   * Applies the answer of `done`. A stale set still becomes the last good set when it has the
   * newest keys and still serves, but the refresh counts as failed. A late answer changes the
   * refresh state only while that state is still about `done`.
   */
  function answered(done: Attempt, loaded: KeySet, now: number): void {
    hold(loaded, now);
    if (!fresh(loaded, now)) {
      fail(done, now);
      return;
    }
    if (refresh.state !== 'idle' && refresh.attempt.id === done.id) refresh = { state: 'idle' };
  }

  function start(scope: CallScope, at: number): Attempt {
    const started: Attempt = { ...liveness(scope, at), id: nextLoadId++ };
    refresh = {
      state: 'fetching',
      attempt: started,
      failuresBefore: refresh.state === 'failed' ? refresh.consecutive : 0,
    };
    startOwned(scope, started, JWKS_FETCH_TIMEOUT_MS, async answer => {
      try {
        const { body, age, oldestAge } = await source(AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS));
        const keys = await importKeySet(body, kind);
        // STS sends no `Age`, but a proxy in between may add one; it never sends the oldest age.
        const ages = parseKeySetAges(
          kind === 'uts'
            ? { newest: age, oldest: oldestAge }
            : { newest: age ?? 0, oldest: age ?? 0 }
        );
        if (ages === null) throw new Error('key set without valid ages');
        answered(started, load(keys, ages, started.startedAt, started.id), Date.now());
      } catch {
        fail(started, Date.now());
      }
      answer();
    });
    return started;
  }

  /**
   * Whether a failed fetch's retry wait holds the next one back. The 24-hour limit of a UTS set is
   * a refresh point: the first lookup past it refreshes at once, even inside the retry wait of a
   * fetch that started before it, and refuses only if that refresh fails too.
   */
  function backingOff(now: number): boolean {
    if (refresh.state !== 'failed' || now >= refresh.retryAt) return false;
    return !(
      kind === 'uts' &&
      set !== null &&
      now >= set.servesUntil &&
      refresh.attempt.startedAt < set.servesUntil
    );
  }

  function unavailable(now: number): { status: 'unavailable'; retryAfterSeconds: number } {
    return {
      status: 'unavailable',
      retryAfterSeconds: retryAfterSeconds(refresh.state === 'failed' ? refresh.retryAt : now, now),
    };
  }

  /** `kid` null: the caller needs a usable set, not a token key (the feed path). */
  async function lookup(kid: string | null, scope: CallScope): Promise<KeyLookup | KeySetReady> {
    /** The refresh this lookup started or joined. */
    let refreshFor: number | null = null;
    for (;;) {
      const now = Date.now();
      const attempt = refresh.state === 'fetching' ? refresh.attempt : null;
      if (
        attempt !== null &&
        (now >= attempt.startedAt + JWKS_FETCH_TIMEOUT_MS || abandoned(attempt, scope, now))
      ) {
        // Past its timeout, or its request was cancelled and it will never answer: a failed
        // fetch. A cancelled unknown-kid refresh still counts against that limit.
        fail(attempt, Math.min(now, attempt.startedAt + JWKS_FETCH_TIMEOUT_MS));
        continue;
      }
      const waiting = backingOff(now);
      /** What the held set answers for this lookup, while it still serves. */
      let held: { status: 'ready' } | { status: 'key'; key: CryptoKey } | undefined;
      if (set !== null && now < set.servesUntil) {
        const key = kid === null ? undefined : set.tokenKeys.get(kid);
        if (kid === null) held = { status: 'ready' };
        else if (key !== undefined) held = { status: 'key', key };
      }

      if (set === null || now >= set.newestReadAt + JWKS_TTL_MS || now >= set.servesUntil) {
        // Cold, expired, or past the 24-hour limit: refresh synchronously. With a last good set
        // that answers this lookup, wait at most JWKS_STALE_WAIT_MS; after that, or once the
        // refresh failed, the issuer is unreachable and the last good set serves.
        if (attempt !== null) {
          refreshFor ??= attempt.id;
          const until =
            attempt.startedAt + (held === undefined ? JWKS_FETCH_TIMEOUT_MS : JWKS_STALE_WAIT_MS);
          if (held !== undefined && now >= until) return held;
          await sleep(scope, until);
          continue;
        }
        if (!waiting) {
          refreshFor ??= start(scope, now).id;
          continue;
        }
        return held ?? unavailable(now);
      }

      if (now >= set.refreshAt && attempt === null && !waiting) start(scope, now);
      if (held !== undefined) return held;

      // Unknown kid on a fresh set: one refresh, at most once per interval.
      if (attempt !== null) {
        refreshFor ??= attempt.id;
        await sleep(scope, attempt.startedAt + JWKS_FETCH_TIMEOUT_MS);
        continue;
      }
      if (refreshFor !== null) {
        return refresh.state === 'failed' && refresh.attempt.id === refreshFor
          ? unavailable(now)
          : { status: 'unknown_kid' };
      }
      if (
        unknownKidRefreshAt !== null &&
        now - unknownKidRefreshAt < UNKNOWN_KID_REFRESH_INTERVAL_MS
      ) {
        return { status: 'unknown_kid' };
      }
      if (waiting) return unavailable(now);
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
      if (set === null || now >= set.servesUntil) return null;
      return set.feedKeys.get(kid) ?? null;
    },
    cold: () => set === null,
    install(keys, keyAges, fetchedAt) {
      const now = Date.now();
      const loaded = load(keys, keyAges, fetchedAt, nextLoadId++);
      if (hold(loaded, now) && refresh.state === 'failed' && fresh(loaded, now)) {
        refresh = { state: 'idle' };
      }
    },
    prefetch(scope) {
      const now = Date.now();
      if (set === null && refresh.state !== 'fetching' && !backingOff(now)) start(scope, now);
    },
  };
}
