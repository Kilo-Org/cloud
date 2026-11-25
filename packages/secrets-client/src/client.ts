import {
  BUNDLE_CACHE_SECONDS,
  BUNDLE_MAX_STALE_SECONDS,
  BUNDLE_REVALIDATE_AFTER_SECONDS,
  BundleResultSchema,
  type BundleRequest,
  type BundleResult,
  type OkBundle,
} from '@kilocode/sts-contracts';
import { SecretUnavailableError } from './errors';
import type { Secrets, SecretsExecutionContext, SecretsSnapshot } from './types';

/** Sends one bundle request and returns the validated result; a transport error rejects. */
export type BundleTransport = (request: BundleRequest) => Promise<BundleResult>;

const CACHE_TTL_MS = BUNDLE_CACHE_SECONDS * 1000;
const REVALIDATE_AFTER_MS = BUNDLE_REVALIDATE_AFTER_SECONDS * 1000;
const MAX_STALE_MS = BUNDLE_MAX_STALE_SECONDS * 1000;
/**
 * An attempt that has not settled this long after it started counts as a failure, and the
 * next attempt waits out the backoff. The attempt keeps running while the request that started
 * it lives; a success it returns later still lands unless a newer attempt's success already did.
 */
export const ATTEMPT_TIMEOUT_MS = 5_000;
/**
 * The isolate's first-load window, from its first attempt. Readers with no bundle wait inside
 * it, across failed attempts and backoff; it covers STS filling an empty bundle object.
 */
export const FIRST_LOAD_DEADLINE_MS = 25_000;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_CAP_MS = 240_000;

/**
 * Delay before the attempt that follows the nth consecutive failure: 5 s doubling to 240 s,
 * minus up to 25 % jitter so instances that failed together spread their retries.
 */
function backoffMs(failures: number): number {
  const step = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));
  return step - Math.random() * step * 0.25;
}

type NotModifiedResult = Extract<BundleResult, { status: 'not_modified' }>;
type UnavailableResult = Extract<BundleResult, { status: 'unavailable' }>;

type Outcome =
  | { kind: 'ok'; result: OkBundle }
  | { kind: 'not_modified'; result: NotModifiedResult }
  | { kind: 'denied' }
  | { kind: 'unavailable'; result: UnavailableResult }
  | { kind: 'transport_error'; cause: unknown };

type CachedBundle = {
  etag: string;
  /** Local receipt time of the last response that confirmed these values; ages the cache. */
  receivedAt: number;
  stale: boolean;
  fetchedAt: string;
  values: Record<string, string>;
  missing: ReadonlySet<string>;
};

/**
 * Plain data, shared by every request in the isolate. The promise of the call lives only in the
 * request that started the attempt (`Owned`), because workerd ties a promise to the request
 * that created it: once that request ends, its pending calls are cancelled and the
 * continuations of its promises are dropped, even ones another request registered.
 */
type Attempt = {
  id: number;
  startedAt: number;
  /** The bundle this attempt revalidates; null for a first load. */
  base: CachedBundle | null;
};

/** An attempt this read started, with the promise only this read may await or hand to `waitUntil`. */
type Owned = { attempt: Attempt; settled: Promise<void> };

/** The failures since the last success; `count` sets the backoff. */
type Failure = { error: SecretUnavailableError; count: number; retryAt: number };

/** `failure` is null for the first attempt since a success, which a reader past the cache lifetime waits for. */
type Running = { state: 'running'; attempt: Attempt; failure: Failure | null };
type BackingOff = { state: 'backing_off'; failure: Failure };
type Fetch = { state: 'idle' } | Running | BackingOff;

type Cache =
  | { phase: 'empty' }
  | { phase: 'cold'; windowEndsAt: number; fetch: Running | BackingOff }
  | { phase: 'ready'; bundle: CachedBundle; fetch: Fetch }
  | { phase: 'denied'; error: SecretUnavailableError };

/**
 * How often a read that waits for another request's attempt checks the shared cache. It cannot
 * await that request's promise (see `Attempt`), so it looks again on its own timer.
 */
const POLL_MS = 25;

export function createSecrets(transport: BundleTransport): Secrets {
  let nextAttemptId = 1;
  /** Id of the attempt whose success the cache holds; an older success never replaces it. */
  let appliedSuccessId = 0;
  let cache: Cache = { phase: 'empty' };
  /**
   * Attempts still awaiting an answer, including timed-out ones whose success can still land.
   * An attempt whose request was cancelled never counts down; a cold read then waits out the
   * first-load window instead of failing early, which stays bounded.
   */
  let inFlight = 0;

  /** The attempt whose failure the cache would record; any other attempt's failure is dropped. */
  function running(): Running | null {
    if (cache.phase !== 'cold' && cache.phase !== 'ready') return null;
    return cache.fetch.state === 'running' ? cache.fetch : null;
  }

  function succeed(attempt: Attempt, bundle: CachedBundle): void {
    if (cache.phase === 'denied' || attempt.id <= appliedSuccessId) return;
    appliedSuccessId = attempt.id;
    cache = { phase: 'ready', bundle, fetch: { state: 'idle' } };
  }

  function fail(
    attempt: Attempt,
    error: SecretUnavailableError,
    at: number,
    retryAfterMs: number
  ): void {
    const current = running();
    if (current === null || current.attempt !== attempt) return;
    const count = (current.failure?.count ?? 0) + 1;
    const failure = { error, count, retryAt: at + Math.max(backoffMs(count), retryAfterMs) };
    if (cache.phase === 'cold') cache = { ...cache, fetch: { state: 'backing_off', failure } };
    if (cache.phase === 'ready') cache = { ...cache, fetch: { state: 'backing_off', failure } };
  }

  function timeOut(current: Running): void {
    fail(
      current.attempt,
      new SecretUnavailableError('unavailable', {
        cause: new Error(`STS did not answer within ${ATTEMPT_TIMEOUT_MS} ms`),
      }),
      current.attempt.startedAt + ATTEMPT_TIMEOUT_MS,
      0
    );
  }

  function apply(attempt: Attempt, outcome: Outcome): void {
    const at = Date.now();
    switch (outcome.kind) {
      case 'ok':
        succeed(attempt, toCachedBundle(outcome.result, at));
        return;
      case 'not_modified': {
        const base = attempt.base;
        if (base === null || outcome.result.etag !== base.etag) {
          fail(
            attempt,
            new SecretUnavailableError('unavailable', {
              cause: new Error('STS answered not_modified for an ETag this client did not send'),
            }),
            at,
            0
          );
          return;
        }
        if (cache.phase === 'ready' && cache.bundle.etag !== base.etag) return;
        succeed(attempt, {
          ...base,
          receivedAt: at,
          stale: outcome.result.stale,
          fetchedAt: outcome.result.fetchedAt,
        });
        return;
      }
      case 'denied':
        if (running()?.attempt !== attempt) return;
        cache = { phase: 'denied', error: new SecretUnavailableError('denied') };
        return;
      case 'unavailable':
        fail(
          attempt,
          new SecretUnavailableError('unavailable'),
          at,
          outcome.result.retryAfterSeconds * 1000
        );
        return;
      case 'transport_error':
        fail(attempt, new SecretUnavailableError('unavailable', { cause: outcome.cause }), at, 0);
        return;
    }
  }

  /** Starts an attempt in the calling request; the caller stores `owned.attempt` in the cache. */
  function start(at: number): Owned {
    const attempt: Attempt = {
      id: nextAttemptId++,
      startedAt: at,
      base: cache.phase === 'ready' ? cache.bundle : null,
    };
    inFlight++;
    const settled = requestBundle(transport, attempt.base?.etag).then(outcome => {
      inFlight--;
      apply(attempt, outcome);
    });
    return { attempt, settled };
  }

  /**
   * Waits one poll interval, or less when `deadline` comes first, so the caller looks at the
   * shared cache again. A read that started `attempt` itself also wakes when its own promise
   * settles; it never awaits another request's promise. The timer is cleared or has fired
   * before this returns, so none outlives the read.
   */
  async function waitFor(attempt: Attempt | null, own: Owned | null, deadline: number) {
    const timer = Promise.withResolvers<void>();
    const handle = setTimeout(timer.resolve, Math.max(0, Math.min(POLL_MS, deadline - Date.now())));
    const mine = attempt !== null && own?.attempt === attempt ? own : null;
    await (mine ? Promise.race([mine.settled, timer.promise]) : timer.promise);
    clearTimeout(handle);
  }

  function usableStale(bundle: CachedBundle, at: number): CachedBundle {
    if (at - bundle.receivedAt >= MAX_STALE_MS) {
      throw new SecretUnavailableError('unavailable', {
        cause: new Error('the held bundle is past the 24 hour stale limit'),
      });
    }
    return bundle;
  }

  async function currentBundle(ctx?: SecretsExecutionContext): Promise<CachedBundle> {
    const arrivedAt = Date.now();
    let own: Owned | null = null;
    for (;;) {
      const at = Date.now();
      switch (cache.phase) {
        case 'denied':
          throw cache.error;
        case 'empty':
          own = start(at);
          cache = {
            phase: 'cold',
            windowEndsAt: at + FIRST_LOAD_DEADLINE_MS,
            fetch: { state: 'running', attempt: own.attempt, failure: null },
          };
          continue;
        case 'cold': {
          // A reader waits at most until the first-load window ends, or 5 s for an attempt it
          // finds running after that; outside the window a backoff makes it fail at once.
          const giveUpAt = Math.max(cache.windowEndsAt, arrivedAt + ATTEMPT_TIMEOUT_MS);
          const fetch = cache.fetch;
          if (fetch.state === 'running') {
            const timesOutAt = fetch.attempt.startedAt + ATTEMPT_TIMEOUT_MS;
            if (at >= timesOutAt) {
              timeOut(fetch);
              continue;
            }
            if (at >= giveUpAt) {
              throw new SecretUnavailableError('unavailable', {
                cause: new Error('STS sent no bundle before this read gave up'),
              });
            }
            await waitFor(fetch.attempt, own, Math.min(timesOutAt, giveUpAt));
            continue;
          }
          const { failure } = fetch;
          if (at < failure.retryAt) {
            if (at >= cache.windowEndsAt) throw failure.error;
            if (failure.retryAt < cache.windowEndsAt) {
              await waitFor(null, own, failure.retryAt);
              continue;
            }
            if (inFlight === 0) throw failure.error;
            await waitFor(null, own, cache.windowEndsAt);
            continue;
          }
          if (at >= giveUpAt) throw failure.error;
          own = start(at);
          cache = { ...cache, fetch: { state: 'running', attempt: own.attempt, failure } };
          continue;
        }
        case 'ready': {
          const bundle = cache.bundle;
          const age = at - bundle.receivedAt;
          if (age < REVALIDATE_AFTER_MS) return bundle;
          const fetch = cache.fetch;
          switch (fetch.state) {
            case 'idle':
              own = start(at);
              cache = {
                ...cache,
                fetch: { state: 'running', attempt: own.attempt, failure: null },
              };
              continue;
            case 'backing_off':
              if (at < fetch.failure.retryAt) return usableStale(bundle, at);
              own = start(at);
              cache = {
                ...cache,
                fetch: { state: 'running', attempt: own.attempt, failure: fetch.failure },
              };
              continue;
            case 'running': {
              const timesOutAt = fetch.attempt.startedAt + ATTEMPT_TIMEOUT_MS;
              if (at >= timesOutAt) {
                timeOut(fetch);
                continue;
              }
              if (fetch.failure === null && age >= CACHE_TTL_MS) {
                await waitFor(fetch.attempt, own, timesOutAt);
                continue;
              }
              // Only the request that started the revalidation keeps it alive; another
              // request's promise is never handed to this request's waitUntil.
              if (own?.attempt === fetch.attempt) ctx?.waitUntil(own.settled);
              return usableStale(bundle, at);
            }
          }
        }
      }
    }
  }

  function value(bundle: CachedBundle, name: string): string {
    const found = bundle.values[name];
    if (found !== undefined) return found;
    throw new SecretUnavailableError(bundle.missing.has(name) ? 'missing' : 'not_granted', {
      secretName: name,
    });
  }

  return {
    async get(name, ctx) {
      return value(await currentBundle(ctx), name);
    },
    async snapshot(ctx): Promise<SecretsSnapshot> {
      const bundle = await currentBundle(ctx);
      return {
        stale: bundle.stale || Date.now() - bundle.receivedAt >= CACHE_TTL_MS,
        fetchedAt: bundle.fetchedAt,
        etag: bundle.etag,
      };
    },
  };
}

function toCachedBundle(result: OkBundle, receivedAt: number): CachedBundle {
  return {
    etag: result.etag,
    receivedAt,
    stale: result.stale,
    fetchedAt: result.fetchedAt,
    values: Object.fromEntries(
      Object.entries(result.secrets).map(([name, secret]) => [name, secret.value])
    ),
    missing: new Set(result.missing),
  };
}

async function requestBundle(
  transport: BundleTransport,
  ifNoneMatch: string | undefined
): Promise<Outcome> {
  const request: BundleRequest = ifNoneMatch === undefined ? {} : { ifNoneMatch };
  let result: BundleResult;
  try {
    result = BundleResultSchema.parse(await transport(request));
  } catch (cause) {
    return { kind: 'transport_error', cause };
  }
  switch (result.status) {
    case 'ok':
      return { kind: 'ok', result };
    case 'not_modified':
      return { kind: 'not_modified', result };
    case 'denied':
      return { kind: 'denied' };
    case 'unavailable':
      return { kind: 'unavailable', result };
  }
}
