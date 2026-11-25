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
 * An attempt that has not settled this long after it started counts as failed: a reader that
 * arrives later starts a new attempt instead of joining it, and a reader that holds a bundle
 * stops waiting and serves that bundle. The attempt keeps running; a success it returns later
 * still lands unless a newer attempt's success already did.
 */
export const ATTEMPT_TIMEOUT_MS = 5_000;
/**
 * The longest a reader with no bundle waits, across restarted attempts, before it fails
 * retryable. It covers STS filling an empty bundle object from the manager.
 */
export const FIRST_LOAD_DEADLINE_MS = 25_000;
/** Retry floor after a transport error, which carries no `retryAfterSeconds` of its own. */
const TRANSPORT_RETRY_MS = 5_000;

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

type Attempt = {
  id: number;
  startedAt: number;
  /** The bundle this attempt revalidates; null for a first load. */
  base: CachedBundle | null;
  /** Settles after the outcome is applied; never rejects. */
  outcome: Promise<void>;
};

/**
 * Revalidation of a held bundle. `running` is the first attempt since the last success, which
 * a reader past the cache lifetime waits for. After a failure the client is degraded:
 * `backing_off` and `retrying` never make a reader wait, they serve the held bundle.
 */
type Revalidation =
  | { state: 'idle' }
  | { state: 'running'; attempt: Attempt }
  | { state: 'backing_off'; retryAt: number }
  | { state: 'retrying'; attempt: Attempt };

type Cache =
  | { phase: 'empty' }
  | { phase: 'loading'; attempt: Attempt }
  | { phase: 'unavailable'; error: SecretUnavailableError; retryAt: number }
  | { phase: 'denied'; error: SecretUnavailableError }
  | { phase: 'ready'; bundle: CachedBundle; revalidation: Revalidation };

export function createSecrets(transport: BundleTransport): Secrets {
  let nextAttemptId = 1;
  /** Id of the attempt whose success the cache holds; an older success never replaces it. */
  let appliedSuccessId = 0;
  let cache: Cache = { phase: 'empty' };
  let settled = Promise.withResolvers<void>();

  /** The attempt whose failure the cache would record; an older attempt's failure is dropped. */
  function trackedAttempt(): Attempt | null {
    if (cache.phase === 'loading') return cache.attempt;
    if (cache.phase !== 'ready') return null;
    const revalidation = cache.revalidation;
    return revalidation.state === 'running' || revalidation.state === 'retrying'
      ? revalidation.attempt
      : null;
  }

  function succeed(attempt: Attempt, bundle: CachedBundle): void {
    if (cache.phase === 'denied' || attempt.id <= appliedSuccessId) return;
    appliedSuccessId = attempt.id;
    cache = { phase: 'ready', bundle, revalidation: { state: 'idle' } };
  }

  function fail(attempt: Attempt, error: SecretUnavailableError, retryAt: number): void {
    if (trackedAttempt() !== attempt) return;
    cache =
      cache.phase === 'ready'
        ? { phase: 'ready', bundle: cache.bundle, revalidation: { state: 'backing_off', retryAt } }
        : { phase: 'unavailable', error, retryAt };
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
            at + TRANSPORT_RETRY_MS
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
        if (trackedAttempt() !== attempt) return;
        cache = { phase: 'denied', error: new SecretUnavailableError('denied') };
        return;
      case 'unavailable':
        fail(
          attempt,
          new SecretUnavailableError('unavailable'),
          at + outcome.result.retryAfterSeconds * 1000
        );
        return;
      case 'transport_error':
        fail(
          attempt,
          new SecretUnavailableError('unavailable', { cause: outcome.cause }),
          at + TRANSPORT_RETRY_MS
        );
        return;
    }
  }

  function startAttempt(base: CachedBundle | null, at: number): Attempt {
    const attempt: Attempt = {
      id: nextAttemptId++,
      startedAt: at,
      base,
      outcome: Promise.resolve(),
    };
    attempt.outcome = requestBundle(transport, base?.etag).then(outcome => {
      apply(attempt, outcome);
      const waiters = settled;
      settled = Promise.withResolvers<void>();
      waiters.resolve();
    });
    return attempt;
  }

  /** Resolves when any attempt settles or at `deadline`, whichever comes first. */
  function settledOrAt(deadline: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
    void settled.promise.then(() => {
      clearTimeout(timer);
      resolve();
    });
    return promise;
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
    const giveUpAt = Date.now() + FIRST_LOAD_DEADLINE_MS;
    for (;;) {
      const at = Date.now();
      switch (cache.phase) {
        case 'empty':
          cache = { phase: 'loading', attempt: startAttempt(null, at) };
          continue;
        case 'denied':
          throw cache.error;
        case 'unavailable':
          if (at < cache.retryAt) throw cache.error;
          cache = { phase: 'loading', attempt: startAttempt(null, at) };
          continue;
        case 'loading': {
          if (at >= giveUpAt) {
            throw new SecretUnavailableError('unavailable', {
              cause: new Error(`STS sent no bundle within ${FIRST_LOAD_DEADLINE_MS} ms`),
            });
          }
          const timesOutAt = cache.attempt.startedAt + ATTEMPT_TIMEOUT_MS;
          if (at >= timesOutAt) {
            cache = { phase: 'loading', attempt: startAttempt(null, at) };
            continue;
          }
          await settledOrAt(Math.min(timesOutAt, giveUpAt));
          continue;
        }
        case 'ready': {
          const bundle = cache.bundle;
          const age = at - bundle.receivedAt;
          if (age < REVALIDATE_AFTER_MS) return bundle;
          const revalidation = cache.revalidation;
          switch (revalidation.state) {
            case 'idle':
              cache = {
                phase: 'ready',
                bundle,
                revalidation: { state: 'running', attempt: startAttempt(bundle, at) },
              };
              continue;
            case 'backing_off':
              if (at < revalidation.retryAt) return usableStale(bundle, at);
              cache = {
                phase: 'ready',
                bundle,
                revalidation: { state: 'retrying', attempt: startAttempt(bundle, at) },
              };
              continue;
            case 'running':
            case 'retrying': {
              const timesOutAt = revalidation.attempt.startedAt + ATTEMPT_TIMEOUT_MS;
              if (at >= timesOutAt) {
                cache = {
                  phase: 'ready',
                  bundle,
                  revalidation: { state: 'backing_off', retryAt: timesOutAt },
                };
                continue;
              }
              if (age < CACHE_TTL_MS || revalidation.state === 'retrying') {
                ctx?.waitUntil(revalidation.attempt.outcome);
                return usableStale(bundle, at);
              }
              await settledOrAt(timesOutAt);
              continue;
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
