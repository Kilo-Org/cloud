import { TRPCError } from '@trpc/server';

/**
 * Simple sliding-window rate limiter keyed by user + operation.
 *
 * Designed for use inside tRPC middleware. Each instance tracks request
 * timestamps per user and prunes expired entries on every check. Since
 * tRPC procedures run inside a Durable Object or a single worker isolate,
 * memory-based tracking is sufficient — there's no need for external state.
 */

type RateLimitEntry = {
  timestamps: number[];
};

type RateLimitConfig = {
  /** Maximum number of requests allowed within the window. */
  maxRequests: number;
  /** Time window in milliseconds. */
  windowMs: number;
};

/** Per-operation rate limit configs. */
export const RATE_LIMITS: Record<string, RateLimitConfig> = {
  'wasteland.claimWantedItem': { maxRequests: 10, windowMs: 60_000 },
  'wasteland.markWantedItemDone': { maxRequests: 10, windowMs: 60_000 },
  'wasteland.postWantedItem': { maxRequests: 5, windowMs: 60_000 },
  'wasteland.browseWantedBoard': { maxRequests: 60, windowMs: 60_000 },
};

// Global store — lives for the lifetime of the worker isolate.
// Keyed by `${userId}:${operation}`.
const store = new Map<string, RateLimitEntry>();

// Periodic cleanup: evict entries older than 2 minutes every 30 seconds
let lastCleanup = Date.now();
const CLEANUP_INTERVAL_MS = 30_000;
const ENTRY_TTL_MS = 120_000;

function cleanup(now: number): void {
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;
  const cutoff = now - ENTRY_TTL_MS;
  for (const [key, entry] of store) {
    entry.timestamps = entry.timestamps.filter(t => t > cutoff);
    if (entry.timestamps.length === 0) store.delete(key);
  }
}

/**
 * Check whether the request should be allowed under the rate limit.
 * Throws a TRPCError with code TOO_MANY_REQUESTS if the limit is exceeded.
 *
 * If no rate limit is configured for the given operation, the request is
 * always allowed.
 */
export function checkRateLimit(userId: string, operation: string): void {
  const config = RATE_LIMITS[operation];
  if (!config) return;

  const now = Date.now();
  cleanup(now);

  const key = `${userId}:${operation}`;
  let entry = store.get(key);
  if (!entry) {
    entry = { timestamps: [] };
    store.set(key, entry);
  }

  // Prune timestamps outside the current window
  const windowStart = now - config.windowMs;
  entry.timestamps = entry.timestamps.filter(t => t > windowStart);

  if (entry.timestamps.length >= config.maxRequests) {
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: `Rate limit exceeded for ${operation}. Max ${config.maxRequests} requests per ${config.windowMs / 1000}s.`,
    });
  }

  entry.timestamps.push(now);
}
