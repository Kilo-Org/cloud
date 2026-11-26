/**
 * Decision D10: Vercel instances share the exchanged STS token through the Vercel Runtime Cache
 * instead of each exchanging its own, because `https://oidc.vercel.com/~token` answers 429 after
 * about 100 exchanges per burst, refilling within about 65 seconds, for a whole deployment (proof
 * runs 1 and 2). Web APIs only and no imports, so the slice-4 client can copy or import this file.
 *
 * One request:
 * 1. The key is the SHA-256 of an optional `keyPrefix` (the proof run salts it per run), the base
 *    token's `owner_id`, `project_id`, `environment`, `custom_environment_id` and `deployment_id`
 *    (decoded, not verified), and the audience. Vercel renews the base token during a
 *    deployment's life, even mid-wave (proof run 2: two `iat` values 33 s apart on one
 *    deployment), so the key leaves the token itself out: every instance of a deployment shares
 *    one key per region and audience whichever base token it holds, and a cached token is used
 *    until its own `exp` minus 60 s even when a newer base token has arrived. A base token
 *    missing one of those claims fails the request.
 * 2. A cached token is used only when it decodes to the same five claims, `aud` equal to the
 *    audience, and `exp` equal to the entry's: code that can write the cache but holds another
 *    deployment's token cannot make this deployment present it. A forged entry can still fail
 *    the caller's STS call (STS checks the signature); code that writes this project's cache runs
 *    with the project's own trust.
 * 3. Instance memory, then the shared cache: a hit is used. On a miss, a base token with under
 *    60 seconds left fails the request at once: no exchange, no waiting.
 * 4. Otherwise wait a random 0..`jitterMs` and read again, so a cold wave spreads out.
 * 5. Still a miss: claim the exchange. Write a claim marker unless one exists, wait `settleMs`, and
 *    read it back; only the request whose marker is still there exchanges (the Runtime Cache has no
 *    lock, so the last writer wins). A marker that does not read back at all means the cache keeps
 *    nothing (degraded mode); the request then exchanges, at most once per request, and a 429 in
 *    that mode fails it at once, because no other instance can share a token through the cache.
 *    With `claim: false` every request that reaches this step exchanges, at most once per request.
 * 6. The exchanger exchanges its own base token and stores `{ token, exp }` with a TTL until 60
 *    seconds before `exp`. The exchange keeps the base token's `exp`, so an early refresh could
 *    not get a later one; the next exchange happens on the first miss after that, with whatever
 *    newer base token the claim winner holds.
 * 7. Every other request, and an exchanger that got 429, polls the shared cache with exponential
 *    backoff and jitter instead of exchanging again. The marker expires after `claimTtlSeconds`;
 *    a poller that then finds neither a token nor a marker claims again, so a lost exchanger or a
 *    429 costs one more exchange per marker lifetime, never a burst.
 * 8. No token by `deadlineMs`: the request fails, and the caller's STS call fails with it. Every
 *    cache call, wait and exchange ends at the deadline: one still running then is abandoned (the
 *    exchange is aborted), so no token is handed out after it.
 *
 * Cache cost per request: a memory hit reads nothing; a cache hit is 1 read; a miss that reaches
 * the claim is 4 reads (read, read after jitter, claim check, read-back) and 1 write (the marker;
 * 2 for the exchanger, which also writes the token), then 2 reads per poll step (claim check and
 * token read; 3 reads and 1 write in the step where the marker has expired and it claims again).
 */

/** The part of `getCache()` from `@vercel/functions` this uses. */
export type SharedCache = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, options: { ttl: number }): Promise<void>;
};

/** One call to the exchange for the given base token and audience; `signal` aborts it. */
export type Exchange = (
  baseToken: string,
  audience: string,
  signal: AbortSignal
) => Promise<ExchangeAttempt>;

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
  /** Mixed into the cache and memory key; the proof run salts each run so runs do not share. */
  keyPrefix: string;
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
  keyPrefix: '',
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

export type Clock = {
  now(): number;
  /** Resolves after `ms`, or at once when `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  random(): number;
};

/** A token with less left is never handed out nor kept: the caller's STS call and the clock skew need it. */
const MIN_REMAINING_SECONDS = 60;

type Entry = { token: string; exp: number };

/** What an operation bounded by the deadline answers when the deadline comes first. */
const LATE: unique symbol = Symbol('late');

const SYSTEM_CLOCK: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
    return promise;
  },
  random: () => Math.random(),
};

/** A JWT's claims, decoded without verifying it; `null` when it is not a JWT. */
function claimsOf(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (part === undefined) return null;
  try {
    const claims: unknown = JSON.parse(atob(part.replaceAll('-', '+').replaceAll('_', '/')));
    return typeof claims === 'object' && claims !== null && !Array.isArray(claims)
      ? { ...claims }
      : null;
  } catch {
    return null;
  }
}

/** The base-token claims that stay the same across renewals within one deployment. */
const DEPLOYMENT_CLAIMS = [
  'owner_id',
  'project_id',
  'environment',
  'custom_environment_id',
  'deployment_id',
] as const;

/** Those claims as one string, or `null` when a required one is missing or not a string. */
function deploymentOf(claims: Record<string, unknown> | null): string | null {
  if (claims === null) return null;
  const parts: string[] = [];
  for (const name of DEPLOYMENT_CLAIMS) {
    const value = claims[name];
    if (value === undefined && name === 'custom_environment_id') parts.push('');
    else if (typeof value === 'string' && value !== '') parts.push(value);
    else return null;
  }
  return parts.join('\n');
}

function asEntry(value: unknown, deployment: string, audience: string): Entry | null {
  if (typeof value !== 'object' || value === null) return null;
  if (!('token' in value) || typeof value.token !== 'string') return null;
  if (!('exp' in value) || typeof value.exp !== 'number') return null;
  const claims = claimsOf(value.token);
  if (claims === null || claims.aud !== audience || claims.exp !== value.exp) return null;
  if (deploymentOf(claims) !== deployment) return null;
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

/** Seconds to keep an exchanged token: until 60 seconds before `exp`; `null` when that has passed. */
export function cacheTtlSeconds(exp: number, nowSeconds: number): number | null {
  const left = exp - MIN_REMAINING_SECONDS - nowSeconds;
  return left > 0 ? left : null;
}

/** The `exp` claim of a JWT, read without verifying it (the token came from the exchange). */
export function expOf(token: string): number | null {
  const exp = claimsOf(token)?.exp;
  return typeof exp === 'number' ? exp : null;
}

async function cacheKey(keyPrefix: string, deployment: string, audience: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${keyPrefix}\n${deployment}\n${audience}`)
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
    const deadline = started + settings.deadlineMs;
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
    // Runs `operation` until the deadline. When the deadline comes first it answers `LATE` and
    // aborts the operation's signal; a cache call that ignores the signal is abandoned.
    const beforeDeadline = async <T>(
      operation: (signal: AbortSignal) => Promise<T>
    ): Promise<T | typeof LATE> => {
      const left = deadline - clock.now();
      if (left <= 0) return LATE;
      const settled = new AbortController();
      try {
        return await Promise.race([
          operation(settled.signal),
          clock.sleep(left, settled.signal).then((): typeof LATE => LATE),
        ]);
      } finally {
        settled.abort();
      }
    };
    const wait = async (ms: number): Promise<void> => {
      const capped = Math.max(0, Math.min(ms, deadline - clock.now()));
      await clock.sleep(capped);
      report.waitedMs += capped;
    };
    // A cache that throws counts as a miss; one that cannot write leaves the token in memory only.
    // A read the deadline cuts short is a miss too.
    const read = async (key: string): Promise<unknown> => {
      if (clock.now() >= deadline) return null;
      const readStarted = clock.now();
      report.cacheReads += 1;
      try {
        const value = await beforeDeadline(async () => await cache.get(key));
        return value === LATE ? null : value;
      } catch {
        return null;
      } finally {
        report.cacheReadMsMax = Math.max(report.cacheReadMsMax, clock.now() - readStarted);
      }
    };
    const write = async (key: string, value: unknown, ttl: number): Promise<void> => {
      if (clock.now() >= deadline) return;
      report.cacheWrites += 1;
      try {
        await beforeDeadline(async () => await cache.set(key, value, { ttl }));
      } catch {
        // Polling requests then wait for the next claim; this request still has its token.
      }
    };

    const baseClaims = claimsOf(baseToken);
    const deployment = deploymentOf(baseClaims);
    if (deployment === null) return fail('the base token lacks a deployment claim');
    const key = await cacheKey(settings.keyPrefix, deployment, audience);
    const claimKey = `${key}:claim`;
    const owner = crypto.randomUUID();
    const readShared = async (): Promise<Entry | null> => {
      const entry = asEntry(await read(key), deployment, audience);
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
    const baseExp = baseClaims?.exp;
    if (typeof baseExp !== 'number') return fail('the base token has no exp');
    if (baseExp - MIN_REMAINING_SECONDS <= nowSeconds()) {
      return fail('the base token expires within 60 seconds');
    }
    await wait(Math.floor(clock.random() * settings.jitterMs));
    entry = await readShared();
    if (entry !== null) return keep('cache_after_jitter', entry);

    let nextExchangeAt = clock.now();
    let markerMissing = false;
    const mayExchange = async (): Promise<boolean> => {
      if (!settings.claim) return clock.now() >= nextExchangeAt;
      // A marker, this request's own after a 429 included, means someone holds the claim.
      if (isClaim(await read(claimKey))) return false;
      await write(claimKey, { owner }, settings.claimTtlSeconds);
      await wait(settings.settleMs);
      const marker = await read(claimKey);
      markerMissing = marker === null;
      if (markerMissing) return clock.now() >= nextExchangeAt;
      report.claimed ||= isClaim(marker) && marker.owner === owner;
      return isClaim(marker) && marker.owner === owner;
    };

    let pollMs = settings.pollStartMs;
    while (clock.now() < deadline) {
      if ((await mayExchange()) && clock.now() < deadline) {
        report.exchangeAttempts += 1;
        nextExchangeAt = clock.now() + settings.exchangeRetryMs;
        const attempt = await beforeDeadline(
          async signal => await exchange(baseToken, audience, signal)
        );
        if (attempt === LATE) break;
        if (attempt.kind === 'failed') return fail(attempt.detail);
        if (attempt.kind === 'rate_limited') {
          report.rateLimited += 1;
          // Degraded mode: the cache keeps nothing, so polling it cannot bring a token.
          if (markerMissing) {
            return fail('the exchange answered 429 and the shared cache keeps nothing');
          }
        } else {
          const exchanged = asEntry(
            { token: attempt.token, exp: expOf(attempt.token) },
            deployment,
            audience
          );
          if (exchanged === null) {
            return fail('the exchanged token does not carry this deployment and audience');
          }
          const ttl = cacheTtlSeconds(exchanged.exp, nowSeconds());
          if (ttl === null) return fail('the exchanged token expires within 60 seconds');
          this.remember(key, exchanged, ttl);
          await write(key, exchanged, ttl);
          // A write the deadline cut short: the token stays in memory for the next request.
          if (clock.now() >= deadline) break;
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
