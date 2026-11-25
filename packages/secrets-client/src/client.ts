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
import type { Secrets, SecretsClock, SecretsExecutionContext, SecretsSnapshot } from './types';

/** Sends one bundle request and returns the validated result; a transport error rejects. */
export type BundleTransport = (request: BundleRequest) => Promise<BundleResult>;

const CACHE_TTL_MS = BUNDLE_CACHE_SECONDS * 1000;
const REVALIDATE_AFTER_MS = BUNDLE_REVALIDATE_AFTER_SECONDS * 1000;
const MAX_STALE_MS = BUNDLE_MAX_STALE_SECONDS * 1000;
/**
 * An STS attempt that outlives this bound is abandoned so one stuck call cannot wedge every
 * read in the isolate. The abandoned attempt's result is dropped by the current-attempt guard.
 */
const ATTEMPT_TIMEOUT_MS = 5_000;
/** Retry floor after a transport error, which carries no `retryAfterSeconds` of its own. */
const TRANSPORT_RETRY_MS = 5_000;

export type SecretsOptions = {
  clock?: SecretsClock;
};

type DeniedResult = Extract<BundleResult, { status: 'denied' }>;
type NotModifiedResult = Extract<BundleResult, { status: 'not_modified' }>;
type UnavailableResult = Extract<BundleResult, { status: 'unavailable' }>;

type Outcome =
  | { kind: 'ok'; result: OkBundle }
  | { kind: 'not_modified'; result: NotModifiedResult }
  | { kind: 'denied'; result: DeniedResult }
  | { kind: 'unavailable'; result: UnavailableResult }
  | { kind: 'transport_error'; cause: unknown };

type CachedBundle = {
  etag: string;
  /** Local receipt time of the last response that carried these values; ages the cache. */
  receivedAt: number;
  stale: boolean;
  fetchedAt: string;
  values: Record<string, string>;
  missing: ReadonlySet<string>;
};

type Attempt = {
  id: number;
  startedAt: number;
  ifNoneMatch: string | undefined;
  /** The bundle this attempt revalidates; null for a first load. */
  base: CachedBundle | null;
  outcome: Promise<void>;
};

type Cache =
  | { phase: 'empty' }
  | { phase: 'loading'; attempt: Attempt }
  | { phase: 'ready'; bundle: CachedBundle; revalidating: Attempt | null; retryAt: number | null }
  | { phase: 'failed'; error: SecretUnavailableError; retryAt: number | null };

export function createSecrets(transport: BundleTransport, options: SecretsOptions = {}): Secrets {
  const clock = options.clock ?? Date.now;
  let nextAttemptId = 1;
  let cache: Cache = { phase: 'empty' };

  function isCurrent(attempt: Attempt): boolean {
    if (cache.phase === 'loading') return cache.attempt.id === attempt.id;
    if (cache.phase === 'ready') return cache.revalidating?.id === attempt.id;
    return false;
  }

  function fail(error: SecretUnavailableError, retryAt: number): void {
    cache =
      cache.phase === 'ready'
        ? { phase: 'ready', bundle: cache.bundle, revalidating: null, retryAt }
        : { phase: 'failed', error, retryAt };
  }

  function apply(attempt: Attempt, outcome: Outcome): void {
    if (!isCurrent(attempt)) return;
    const at = clock();
    switch (outcome.kind) {
      case 'ok':
        cache = {
          phase: 'ready',
          bundle: toCachedBundle(outcome.result, at),
          revalidating: null,
          retryAt: null,
        };
        return;
      case 'not_modified': {
        const base = attempt.base;
        if (base === null) {
          fail(
            new SecretUnavailableError('unavailable', {
              cause: new Error('STS answered not_modified for a request without ifNoneMatch'),
            }),
            at + TRANSPORT_RETRY_MS
          );
          return;
        }
        cache = {
          phase: 'ready',
          bundle: {
            ...base,
            etag: outcome.result.etag,
            receivedAt: at,
            stale: outcome.result.stale,
            fetchedAt: outcome.result.fetchedAt,
          },
          revalidating: null,
          retryAt: null,
        };
        return;
      }
      case 'denied':
        cache = { phase: 'failed', error: new SecretUnavailableError('denied'), retryAt: null };
        return;
      case 'unavailable':
        fail(
          new SecretUnavailableError('unavailable'),
          at + outcome.result.retryAfterSeconds * 1000
        );
        return;
      case 'transport_error':
        fail(
          new SecretUnavailableError('unavailable', { cause: outcome.cause }),
          at + TRANSPORT_RETRY_MS
        );
        return;
    }
  }

  function createAttempt(base: CachedBundle | null): Attempt {
    return {
      id: nextAttemptId++,
      startedAt: clock(),
      ifNoneMatch: base?.etag,
      base,
      outcome: Promise.resolve(),
    };
  }

  function begin(attempt: Attempt): void {
    attempt.outcome = requestBundle(transport, attempt.ifNoneMatch).then(outcome => {
      apply(attempt, outcome);
    });
  }

  function startLoad(): Attempt {
    const attempt = createAttempt(null);
    cache = { phase: 'loading', attempt };
    begin(attempt);
    return attempt;
  }

  function ensureRevalidation(bundle: CachedBundle, at: number): Attempt | null {
    if (cache.phase !== 'ready') return null;
    const running = cache.revalidating;
    if (running !== null && at - running.startedAt < ATTEMPT_TIMEOUT_MS) return running;
    if (cache.retryAt !== null && at < cache.retryAt) return null;
    const attempt = createAttempt(bundle);
    cache = { ...cache, revalidating: attempt };
    begin(attempt);
    return attempt;
  }

  function usableStale(bundle: CachedBundle, at: number): CachedBundle {
    if (at - bundle.receivedAt >= MAX_STALE_MS) {
      throw new SecretUnavailableError('unavailable');
    }
    return bundle;
  }

  async function currentBundle(ctx?: SecretsExecutionContext): Promise<CachedBundle> {
    for (;;) {
      const at = clock();
      switch (cache.phase) {
        case 'empty': {
          await startLoad().outcome;
          continue;
        }
        case 'loading': {
          if (at - cache.attempt.startedAt < ATTEMPT_TIMEOUT_MS) {
            await cache.attempt.outcome;
          } else {
            await startLoad().outcome;
          }
          continue;
        }
        case 'failed': {
          const retryAllowed =
            cache.error.retryable && (cache.retryAt === null || at >= cache.retryAt);
          if (!retryAllowed) throw cache.error;
          await startLoad().outcome;
          continue;
        }
        case 'ready': {
          const bundle = cache.bundle;
          const age = at - bundle.receivedAt;
          if (age < REVALIDATE_AFTER_MS) return bundle;
          const attempt = ensureRevalidation(bundle, at);
          if (attempt === null) return usableStale(bundle, at);
          if (age < CACHE_TTL_MS) {
            if (ctx) ctx.waitUntil(attempt.outcome);
            return bundle;
          }
          await attempt.outcome;
          continue;
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
        stale: bundle.stale || clock() - bundle.receivedAt >= CACHE_TTL_MS,
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
      return { kind: 'denied', result };
    case 'unavailable':
      return { kind: 'unavailable', result };
  }
}
