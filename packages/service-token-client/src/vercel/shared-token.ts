/**
 * Decision D10 (design 4.4, Q49): Vercel instances share the exchanged STS token through the
 * Vercel Runtime Cache instead of each exchanging its own, because `https://oidc.vercel.com/~token`
 * answers 429 after about 100 exchanges per burst, refilling within about 65 seconds, for a whole
 * project or team (proof runs 1 to 3). Web APIs only and no imports: `vercelIdentity` uses it, and
 * the proof harness in `services/sts/proof/vercel-exchange` copies this one file at deploy time.
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
 *    audience, `exp` equal to the entry's, and the issuer and `act` STS requires of an exchanged
 *    token (the team slug issuer of its `owner`, `act.aud` that team's default audience, nothing
 *    nested): code that can write the cache but holds another deployment's token cannot make this
 *    deployment present it. An exchanged token that fails the same check is never stored nor
 *    served. A forged or stale entry can still fail the caller's STS call (STS checks the
 *    signature); the caller then calls `invalidate`, which drops it from memory and the cache so
 *    the next request exchanges again (once per STS refusal). Code that writes this project's
 *    cache runs with the project's own trust.
 * 2a. When STS refuses a token this instance exchanged itself, `invalidate` writes a refusal
 *    marker for the deployment and audience that lives `refusedTtlSeconds` (the client's
 *    `DENIED_RECHECK_MS`, 60 s). While it lives no instance of the deployment drops a cached token
 *    STS refused, nor exchanges: each answers from its client's denied state. A deployment STS
 *    refuses outright (a policy naming the wrong project or environment) so costs at most one
 *    exchange per marker lifetime and region, not one per claim-marker lifetime.
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
 * 8. No token by `deadlineMs`: the request fails, and the caller's STS call fails with it.
 *
 * Cache cost per request: a memory hit reads nothing; a cache hit is 1 read; a miss that reaches
 * the claim is 4 reads (read, read after jitter, claim check, read-back) and 1 write (the marker;
 * for the exchanger 1 more read, the refusal marker, and 1 more write, the token), then 2 reads
 * per poll step (claim check and token read; 3 reads and 1 write in the step where the marker has
 * expired and it claims again). `invalidate` adds 1 write for a token this instance exchanged, and
 * 1 or 2 reads and at most 1 delete for one it took from the cache.
 */

/** The part of `getCache()` from `@vercel/functions` this uses. */
export type SharedCache = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, options: { ttl: number }): Promise<void>;
  delete(key: string): Promise<void>;
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
  /** Lifetime of the refusal marker (step 2a); equals the client's `DENIED_RECHECK_MS`. */
  refusedTtlSeconds: number;
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
  refusedTtlSeconds: 60,
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

export type Clock = { now(): number; sleep(ms: number): Promise<void>; random(): number };

/** A token with less left is never handed out nor kept: the caller's STS call and the clock skew need it. */
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

/** The exchange's issuer: the team slug form `https://oidc.vercel.com/<team slug>`. */
const VERCEL_ISSUER_PREFIX = 'https://oidc.vercel.com/';

/**
 * STS's checks of an exchanged token besides its signature and deployment (`services/sts` README,
 * "Vercel"): the issuer is the team slug form of its own `owner`, and `act` names that team's
 * default audience, the base token's, with no nested `act`. A token that fails them is never
 * stored nor served: STS would refuse it, and for a token this instance exchanged `invalidate`
 * would keep it and write the refusal marker.
 */
function isExchangedFunctionToken(claims: Record<string, unknown>): boolean {
  const owner = claims.owner;
  if (typeof owner !== 'string' || owner === '' || owner.includes('/')) return false;
  if (claims.iss !== `${VERCEL_ISSUER_PREFIX}${owner}`) return false;
  const act = claims.act;
  if (typeof act !== 'object' || act === null || Array.isArray(act) || 'act' in act) return false;
  return 'aud' in act && act.aud === `https://vercel.com/${owner}`;
}

function asEntry(value: unknown, deployment: string, audience: string): Entry | null {
  if (typeof value !== 'object' || value === null) return null;
  if (!('token' in value) || typeof value.token !== 'string') return null;
  if (!('exp' in value) || typeof value.exp !== 'number') return null;
  const claims = claimsOf(value.token);
  if (claims === null || claims.aud !== audience || claims.exp !== value.exp) return null;
  if (deploymentOf(claims) !== deployment || !isExchangedFunctionToken(claims)) return null;
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

function isRefused(value: unknown): value is { refused: true } {
  return (
    typeof value === 'object' && value !== null && 'refused' in value && value.refused === true
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
  /** `shared`: the token came from the Runtime Cache, not from this instance's own exchange. */
  private readonly memory = new Map<string, Entry & { untilMs: number; shared: boolean }>();
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

  private remember(key: string, entry: Entry, ttlSeconds: number, shared: boolean): void {
    const now = this.clock.now();
    for (const [stored, value] of this.memory) {
      if (value.untilMs <= now) this.memory.delete(stored);
    }
    this.memory.set(key, { ...entry, untilMs: now + ttlSeconds * 1000, shared });
  }

  /**
   * Called after STS refused `token` (`identity_rejected`). A token this instance took from the
   * Runtime Cache is dropped from memory and, if the cache still holds it, from the cache, and
   * `true` returned, so the next `get` reads or exchanges a fresh one; unless a refusal marker
   * lives (step 2a): then it is kept and `false` returned. A token this instance exchanged itself
   * is kept and `false` returned, and the refusal marker written: Vercel issued it for this
   * deployment, so exchanging again would get the same refusal and spend the project's exchange
   * budget, which previews share with production.
   */
  async invalidate(token: string): Promise<boolean> {
    const claims = claimsOf(token);
    const deployment = deploymentOf(claims);
    const audience = claims?.aud;
    if (deployment === null || typeof audience !== 'string') return false;
    const key = await cacheKey(this.settings.keyPrefix, deployment, audience);
    const remembered = this.memory.get(key);
    if (remembered?.token !== token) return false;
    // A cache that fails keeps no marker and no deletion; this instance still exchanges no more.
    if (!remembered.shared) {
      await this.cache
        .set(`${key}:refused`, { refused: true }, { ttl: this.settings.refusedTtlSeconds })
        .catch(() => undefined);
      return false;
    }
    if (isRefused(await this.cache.get(`${key}:refused`).catch(() => null))) return false;
    this.memory.delete(key);
    try {
      if (asEntry(await this.cache.get(key), deployment, audience)?.token === token) {
        await this.cache.delete(key);
      }
    } catch {
      // A cache that fails keeps the entry until its TTL; this instance no longer serves it.
    }
    return true;
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
      if (ttl !== null) this.remember(key, entry, ttl, true);
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

    const deadline = started + settings.deadlineMs;
    let pollMs = settings.pollStartMs;
    while (clock.now() < deadline) {
      if (await mayExchange()) {
        // Step 2a: no exchange while STS refuses this deployment's freshly exchanged token.
        if (isRefused(await read(`${key}:refused`))) {
          return fail('STS refused a token freshly exchanged for this deployment and audience');
        }
        report.exchangeAttempts += 1;
        nextExchangeAt = clock.now() + settings.exchangeRetryMs;
        const attempt = await exchange(baseToken, audience);
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
            return fail(
              'the exchanged token is not one STS accepts for this deployment and audience'
            );
          }
          const ttl = cacheTtlSeconds(exchanged.exp, nowSeconds());
          if (ttl === null) return fail('the exchanged token expires within 60 seconds');
          await write(key, exchanged, ttl);
          this.remember(key, exchanged, ttl, false);
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
