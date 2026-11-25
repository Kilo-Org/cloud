/**
 * Decision D10: Vercel instances share the exchanged STS token through the Vercel Runtime Cache
 * instead of each exchanging its own, because `https://oidc.vercel.com/~token` answers 429 after
 * about 100 exchanges per burst, refilling within about 65 seconds, for a whole deployment (proof
 * run 1). Web APIs only and no imports, so the slice-4 client can copy or import this file.
 *
 * One request:
 * 1. The key is the SHA-256 of the base token and the audience. Every instance of a deployment
 *    carries the same base token, so a region's instances share one key per audience; a new base
 *    token (a new deployment, or Vercel renewing it) is a new key.
 * 2. Instance memory, then the shared cache: a hit is used.
 * 3. On a miss, wait a random 0..`jitterMs` and read again, so a cold wave spreads out.
 * 4. Still a miss: claim the exchange. Write a claim marker unless one exists, wait `settleMs`, and
 *    read it back; only the request whose marker is still there exchanges (the Runtime Cache has no
 *    lock, so the last writer wins). A marker that does not read back at all means the cache keeps
 *    nothing; the request then exchanges, at most once per `exchangeRetryMs`. With `claim: false`
 *    every request that reaches this step exchanges, at most once per `exchangeRetryMs`.
 * 5. The exchanger stores `{ token, exp }` with a TTL until 10 minutes before `exp`. The exchange
 *    keeps the base token's `exp`, so exchanging an old base token again cannot get a later one:
 *    with under 10 minutes left the token is kept, in the cache and in memory, until 60 seconds
 *    before `exp` instead of being exchanged on every request.
 * 6. Every other request, and an exchanger that got 429, polls the shared cache with exponential
 *    backoff and jitter instead of exchanging again. The marker expires after `claimTtlSeconds`;
 *    a poller that then finds neither a token nor a marker claims again, so a lost exchanger or a
 *    429 costs one more exchange per marker lifetime, never a burst.
 * 7. No token by `deadlineMs`: the request fails, and the caller's STS call fails with it.
 */

/** The part of `getCache()` from `@vercel/functions` this uses. */
export type SharedCache = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, options: { ttl: number }): Promise<void>;
};

/** One call to the exchange for the given base token and audience. */
export type Exchange = (baseToken: string, audience: string) => Promise<ExchangeAttempt>;

export type ExchangeAttempt =
  | { kind: 'token'; token: string }
  | { kind: 'rate_limited' }
  | { kind: 'failed'; detail: string };

export type SharedTokenSettings = {
  jitterMs: number;
  claim: boolean;
  settleMs: number;
  claimTtlSeconds: number;
  pollStartMs: number;
  pollMaxMs: number;
  exchangeRetryMs: number;
  deadlineMs: number;
};

export const DEFAULT_SETTINGS: SharedTokenSettings = {
  jitterMs: 500,
  claim: true,
  settleMs: 150,
  claimTtlSeconds: 10,
  pollStartMs: 50,
  pollMaxMs: 800,
  exchangeRetryMs: 20_000,
  deadlineMs: 20_000,
};

export type TokenSource = 'memory' | 'cache' | 'cache_after_jitter' | 'exchanged' | 'poll';

export type SharedTokenReport = {
  source: TokenSource | null;
  timeToTokenMs: number;
  /** Time spent in the jitter, the claim settle and the poll backoff. */
  waitedMs: number;
  exchangeAttempts: number;
  rateLimited: number;
  /** This request won a claim. */
  claimed: boolean;
  cacheReads: number;
  cacheReadMsMax: number;
  cacheWrites: number;
};

export type SharedTokenResult =
  | { status: 'ok'; token: string; exp: number; report: SharedTokenReport }
  | { status: 'failed'; detail: string; report: SharedTokenReport };

export type Clock = { now(): number; sleep(ms: number): Promise<void>; random(): number };

/** D10: the shared entry lives until 10 minutes before the token's `exp`. */
const REFRESH_MARGIN_SECONDS = 600;
/** A token with less left is never handed out: the caller's STS call and the clock skew need it. */
const MIN_REMAINING_SECONDS = 60;

type Entry = { token: string; exp: number };

const SYSTEM_CLOCK: Clock = {
  now: () => Date.now(),
  sleep: ms => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ms);
    return promise;
  },
  random: () => Math.random(),
};

function asEntry(value: unknown): Entry | null {
  if (typeof value !== 'object' || value === null) return null;
  if (!('token' in value) || typeof value.token !== 'string') return null;
  if (!('exp' in value) || typeof value.exp !== 'number') return null;
  return { token: value.token, exp: value.exp };
}

function isClaim(value: unknown): value is { owner: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'owner' in value &&
    typeof value.owner === 'string'
  );
}

/**
 * Seconds to keep an exchanged token: until 10 minutes before `exp`, or, with less left, until 60
 * seconds before `exp`; `null` when even that has passed.
 */
export function cacheTtlSeconds(exp: number, nowSeconds: number): number | null {
  const beforeMargin = exp - REFRESH_MARGIN_SECONDS - nowSeconds;
  if (beforeMargin > 0) return beforeMargin;
  const beforeEnd = exp - MIN_REMAINING_SECONDS - nowSeconds;
  return beforeEnd > 0 ? beforeEnd : null;
}

/** The `exp` claim of a JWT, read without verifying it (the token came from the exchange). */
export function expOf(token: string): number | null {
  const part = token.split('.')[1];
  if (part === undefined) return null;
  try {
    const claims: unknown = JSON.parse(atob(part.replaceAll('-', '+').replaceAll('_', '/')));
    return typeof claims === 'object' &&
      claims !== null &&
      'exp' in claims &&
      typeof claims.exp === 'number'
      ? claims.exp
      : null;
  } catch {
    return null;
  }
}

async function cacheKey(baseToken: string, audience: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${baseToken}\n${audience}`)
  );
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0'));
  return `sts-exchange:${hex.join('')}`;
}

/**
 * The exchanged-token source of one instance. Keep one per instance (module scope): its memory
 * holds finished tokens only, never a pending exchange.
 */
export class SharedExchangedToken {
  private readonly memory = new Map<string, Entry & { untilMs: number }>();
  private readonly cache: SharedCache;
  private readonly settings: SharedTokenSettings;
  private readonly clock: Clock;

  constructor(
    cache: SharedCache,
    options: { settings?: Partial<SharedTokenSettings>; clock?: Clock } = {}
  ) {
    this.cache = cache;
    this.settings = { ...DEFAULT_SETTINGS, ...options.settings };
    this.clock = options.clock ?? SYSTEM_CLOCK;
  }

  private remember(key: string, entry: Entry, ttlSeconds: number): void {
    const now = this.clock.now();
    for (const [stored, value] of this.memory) {
      if (value.untilMs <= now) this.memory.delete(stored);
    }
    this.memory.set(key, { ...entry, untilMs: now + ttlSeconds * 1000 });
  }

  async get(
    baseToken: string,
    audience: string,
    exchange: Exchange,
    overrides: Partial<SharedTokenSettings> = {}
  ): Promise<SharedTokenResult> {
    const settings = { ...this.settings, ...overrides };
    const { cache, clock } = this;
    const started = clock.now();
    const nowSeconds = () => Math.floor(clock.now() / 1000);
    const report: SharedTokenReport = {
      source: null,
      timeToTokenMs: 0,
      waitedMs: 0,
      exchangeAttempts: 0,
      rateLimited: 0,
      claimed: false,
      cacheReads: 0,
      cacheReadMsMax: 0,
      cacheWrites: 0,
    };
    const finish = (source: TokenSource, entry: Entry): SharedTokenResult => {
      report.source = source;
      report.timeToTokenMs = clock.now() - started;
      return { status: 'ok', token: entry.token, exp: entry.exp, report };
    };
    const fail = (detail: string): SharedTokenResult => {
      report.timeToTokenMs = clock.now() - started;
      return { status: 'failed', detail, report };
    };
    const wait = async (ms: number): Promise<void> => {
      await clock.sleep(ms);
      report.waitedMs += ms;
    };
    // A cache that throws counts as a miss; one that cannot write leaves the token in memory only.
    const read = async (key: string): Promise<unknown> => {
      const readStarted = clock.now();
      report.cacheReads += 1;
      try {
        return await cache.get(key);
      } catch {
        return null;
      } finally {
        report.cacheReadMsMax = Math.max(report.cacheReadMsMax, clock.now() - readStarted);
      }
    };
    const write = async (key: string, value: unknown, ttl: number): Promise<void> => {
      report.cacheWrites += 1;
      try {
        await cache.set(key, value, { ttl });
      } catch {
        // Polling requests then wait for the next claim; this request still has its token.
      }
    };

    const key = await cacheKey(baseToken, audience);
    const claimKey = `${key}:claim`;
    const owner = crypto.randomUUID();
    const readShared = async (): Promise<Entry | null> => {
      const entry = asEntry(await read(key));
      return entry !== null && entry.exp - MIN_REMAINING_SECONDS > nowSeconds() ? entry : null;
    };

    const remembered = this.memory.get(key);
    if (remembered !== undefined && remembered.untilMs > clock.now()) {
      return finish('memory', remembered);
    }
    const keep = (source: TokenSource, entry: Entry): SharedTokenResult => {
      const ttl = cacheTtlSeconds(entry.exp, nowSeconds());
      if (ttl !== null) this.remember(key, entry, ttl);
      return finish(source, entry);
    };

    let entry = await readShared();
    if (entry !== null) return keep('cache', entry);
    await wait(Math.floor(clock.random() * settings.jitterMs));
    entry = await readShared();
    if (entry !== null) return keep('cache_after_jitter', entry);

    let nextExchangeAt = clock.now();
    const mayExchange = async (): Promise<boolean> => {
      if (!settings.claim) return clock.now() >= nextExchangeAt;
      // A marker, this request's own after a 429 included, means someone holds the claim.
      if (isClaim(await read(claimKey))) return false;
      await write(claimKey, { owner }, settings.claimTtlSeconds);
      await wait(settings.settleMs);
      const marker = await read(claimKey);
      if (marker === null) return clock.now() >= nextExchangeAt;
      report.claimed ||= isClaim(marker) && marker.owner === owner;
      return isClaim(marker) && marker.owner === owner;
    };

    const deadline = started + settings.deadlineMs;
    let pollMs = settings.pollStartMs;
    while (clock.now() < deadline) {
      if (await mayExchange()) {
        report.exchangeAttempts += 1;
        nextExchangeAt = clock.now() + settings.exchangeRetryMs;
        const attempt = await exchange(baseToken, audience);
        if (attempt.kind === 'failed') return fail(attempt.detail);
        if (attempt.kind === 'rate_limited') {
          report.rateLimited += 1;
        } else {
          const exp = expOf(attempt.token);
          if (exp === null) return fail('the exchanged token has no exp');
          const ttl = cacheTtlSeconds(exp, nowSeconds());
          if (ttl === null) return fail('the exchanged token expires within 60 seconds');
          const exchanged = { token: attempt.token, exp };
          await write(key, exchanged, ttl);
          this.remember(key, exchanged, ttl);
          return finish('exchanged', exchanged);
        }
      }
      await wait(Math.floor(pollMs / 2 + clock.random() * (pollMs / 2)));
      pollMs = Math.min(pollMs * 2, settings.pollMaxMs);
      entry = await readShared();
      if (entry !== null) return keep('poll', entry);
    }
    return fail('no token before the deadline');
  }
}
