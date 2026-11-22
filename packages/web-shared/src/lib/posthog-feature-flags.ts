import 'server-only';

import PostHogClient from '@kilocode/web-shared/lib/posthog';

import { captureException, startSpan } from '@sentry/nextjs';

const posthogClient = PostHogClient();

/** How long one resolved flag value serves every read of the same key. */
const FLAG_CACHE_TTL_MS = 30_000;

/**
 * Upper bound on one flag read, as the caller waits for it. posthog-node takes no
 * per-call signal, and its own flag request deadline is 3000 ms, so the bound the
 * request path relies on lives here.
 */
const FLAG_READ_TIMEOUT_MS = 1_000;

/**
 * After a read outlives the deadline or throws, every read of that key answers
 * with its caller's default for this window. A short window reports one failure
 * per window instead of one per request, and keeps an unreachable PostHog from
 * costing a deadline on every request path.
 */
const FLAG_FAILURE_BACKOFF_MS = 30_000;

/**
 * Keys carry a distinct id and optionally person properties, so a user- or
 * email-keyed flag would otherwise grow this map without limit in a long-lived
 * isolate. The least recently used key is evicted first.
 */
const MAX_CACHED_FLAGS = 500;

/** A resolved PostHog flag value; `undefined` means the flag has no value. */
type FlagValue = string | boolean | undefined;

/** One read attempt, settled: either the SDK's answer or the reason there is none. */
type FlagReadResult = { ok: true; value: FlagValue } | { ok: false; error: unknown };

/** One key's cache state. A key is in exactly one of these states. */
type FlagCacheEntry =
  | { kind: 'fresh'; value: FlagValue; readAt: number }
  | { kind: 'failed'; retryAfterMs: number }
  | { kind: 'reading'; result: Promise<FlagReadResult> };

/** Sentinel for the deadline race; a symbol cannot collide with a flag value. */
const READ_TIMED_OUT = Symbol('flag-read-timed-out');

const flagCache = new Map<string, FlagCacheEntry>();

type FlagRead = {
  flagName: string;
  distinctId: string;
  /** Span operation recorded around the PostHog read. */
  op: string;
  /** Sentry `source` tag applied to the reported failure. */
  source: string;
  /** Exact `console.error` text kept byte-identical per caller. */
  logMessage: string;
  /** Sentry `extra` payload for the reported failure. */
  extra: Record<string, unknown>;
  personProperties?: Record<string, string>;
};

/**
 * Canonical cache key. Person properties take part in targeting, so they take
 * part in the key; sorting the pairs makes their order irrelevant, and
 * `JSON.stringify` keeps the encoding injective so no two property sets can
 * share a key. An absent and an empty object are the same key.
 */
function cacheKey({ flagName, distinctId, personProperties }: FlagRead): string {
  const properties = personProperties
    ? JSON.stringify(
        Object.entries(personProperties).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0
        )
      )
    : '';
  return `${flagName}\u0000${distinctId}\u0000${properties}`;
}

/** Store an entry as the most recently used key, keeping the map under its cap. */
function storeEntry(key: string, entry: FlagCacheEntry): void {
  flagCache.delete(key);
  flagCache.set(key, entry);
  while (flagCache.size > MAX_CACHED_FLAGS) {
    const oldest = flagCache.keys().next();
    if (oldest.done) break;
    flagCache.delete(oldest.value);
  }
}

/**
 * One PostHog read, bounded by `FLAG_READ_TIMEOUT_MS`. Never rejects: a deadline
 * or a thrown error becomes `{ ok: false }` so the entry can record it once.
 *
 * The SDK accepts no signal, so a read that outlives the deadline keeps running;
 * the shared client's `featureFlagsRequestTimeoutMs` releases its request one
 * second later, and its answer is dropped here.
 */
async function readFromPostHog({
  flagName,
  distinctId,
  personProperties,
  op,
}: FlagRead): Promise<FlagReadResult> {
  const deadline = Promise.withResolvers<typeof READ_TIMED_OUT>();
  const timer = setTimeout(deadline.resolve, FLAG_READ_TIMEOUT_MS, READ_TIMED_OUT);

  try {
    const value = await Promise.race([
      startSpan({ name: flagName, op }, async () => {
        return await posthogClient.getFeatureFlag(flagName, distinctId, { personProperties });
      }),
      deadline.promise,
    ]);
    if (value === READ_TIMED_OUT) {
      return {
        ok: false,
        error: new Error(`PostHog flag read did not answer within ${FLAG_READ_TIMEOUT_MS}ms`),
      };
    }
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Shared PostHog read-and-report wrapper. Reuses one resolved answer per flag,
 * distinct id and person properties for `FLAG_CACHE_TTL_MS`, shares one read
 * between concurrent callers, and bounds each read. On failure it logs and
 * reports with the initiating caller's tag and extra payload, then returns
 * `undefined` so each caller applies its own failure default.
 */
async function readFlag(meta: FlagRead): Promise<FlagValue> {
  const key = cacheKey(meta);
  const entry = flagCache.get(key);
  const now = Date.now();

  if (entry?.kind === 'fresh' && now - entry.readAt < FLAG_CACHE_TTL_MS) {
    storeEntry(key, entry);
    return entry.value;
  }
  if (entry?.kind === 'failed' && now < entry.retryAfterMs) {
    storeEntry(key, entry);
    return undefined;
  }
  if (entry?.kind === 'reading') {
    storeEntry(key, entry);
    const result = await entry.result;
    return result.ok ? result.value : undefined;
  }

  const result = readFromPostHog(meta);
  storeEntry(key, { kind: 'reading', result });
  const settled = await result;

  if (settled.ok) {
    storeEntry(key, { kind: 'fresh', value: settled.value, readAt: Date.now() });
    return settled.value;
  }

  console.error(meta.logMessage, meta.flagName, settled.error);
  captureException(settled.error, {
    tags: { source: meta.source },
    extra: meta.extra,
  });
  storeEntry(key, { kind: 'failed', retryAfterMs: Date.now() + FLAG_FAILURE_BACKOFF_MS });
  return undefined;
}

/** Drops every cached flag read. Tests call this between cases. */
export function resetFeatureFlagCache(): void {
  flagCache.clear();
}

/**
 * Server helper to check if a PostHog feature flag is enabled (boolean flags).
 * Call it from server components, route handlers, or other server modules.
 * @param flagName - The name of the PostHog feature flag to check
 * @param distinctId - Optional distinct ID for the feature flag request (defaults to 'server-config-fetch')
 * @returns Boolean indicating if the flag is enabled, or false if not found/error
 */
export async function isFeatureFlagEnabled(
  flagName: string,
  distinctId: string = 'server-config-fetch'
): Promise<boolean> {
  return Boolean(
    await readFlag({
      flagName,
      distinctId,
      op: 'posthog-feature-flag',
      source: 'posthog_feature_flag_enabled',
      logMessage: "Error checking feature flag '%s':",
      extra: { flagName, distinctId },
    })
  );
}

export async function isFeatureFlagEnabledOrDevelopment(
  flagName: string,
  distinctId: string = 'server-config-fetch'
): Promise<boolean> {
  return (
    process.env.NODE_ENV === 'development' || (await isFeatureFlagEnabled(flagName, distinctId))
  );
}

/**
 * Strict boolean-only release toggle check.
 * Intended for authorization decisions where multivariate feature flag variants must not grant access.
 * @param flagName - The name of the PostHog feature flag to check
 * @param distinctId - Optional distinct ID for the feature flag request (defaults to 'server-config-fetch')
 * @returns true only when PostHog returns the boolean value true; false for all other values/errors
 */
export async function isReleaseToggleEnabled(
  flagName: string,
  distinctId: string = 'server-config-fetch',
  personProperties?: Record<string, string>
): Promise<boolean> {
  return (
    (await readFlag({
      flagName,
      distinctId,
      op: 'posthog-feature-flag-boolean',
      source: 'posthog_feature_flag_boolean_enabled',
      logMessage: 'Error checking boolean feature flag:',
      extra: { flagName },
      personProperties,
    })) === true
  );
}
