import { ai_gateway_metadata_cache } from '@kilocode/db';
import { eq } from 'drizzle-orm';
import { createCachedFetch } from '@kilocode/web-shared/lib/cached-fetch';
import type { db, readDb } from '@kilocode/web-shared/lib/drizzle';
import { warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';

const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export type MetadataSource<T> = {
  url: string;
  parse: (raw: unknown) => T;
  headers?: () => Record<string, string>;
  timeoutMs?: number;
  /**
   * When set, a 404 means the resource does not exist rather than that the fetch failed: this value
   * stands in for the body, so the absence is parsed and stored like any other response.
   */
  rawWhenNotFound?: unknown;
};

export type MetadataDb = typeof db | typeof readDb;

export async function fetchMetadata<T>(
  source: MetadataSource<T>,
  options: { signal?: AbortSignal } = {}
): Promise<{ raw: unknown; data: T }> {
  const timeout = AbortSignal.timeout(source.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
  const response = await fetch(source.url, {
    method: 'GET',
    headers: { accept: 'application/json', ...source.headers?.() },
    cache: 'no-store',
    signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
  });
  if (response.status === 404 && source.rawWhenNotFound !== undefined) {
    return { raw: source.rawWhenNotFound, data: source.parse(source.rawWhenNotFound) };
  }
  if (!response.ok) {
    throw new Error(`Fetching ${source.url} failed: ${response.status} ${response.statusText}`);
  }
  const raw: unknown = await response.json();
  return { raw, data: source.parse(raw) };
}

export function assertMinimumCount(url: string, count: number, minimum: number) {
  if (count < minimum) {
    throw new Error(`Suspicious: ${url} returned ${count} entries, fewer than ${minimum}`);
  }
}

/**
 * A stored row is used however old it is. The table exists so that metadata survives an upstream
 * outage, so an out-of-date row must not trigger a live fetch: only a missing or unparseable row
 * does. A row that stops being refreshed because the cron job or its deployment is broken is
 * reported by the stale alert in the refresh job, and that failure should be fixed rather than
 * worked around here.
 */
export async function readStoredMetadata<T>(
  source: MetadataSource<T>,
  fromDb: MetadataDb
): Promise<T | null> {
  try {
    const [row] = await fromDb
      .select({ data: ai_gateway_metadata_cache.data })
      .from(ai_gateway_metadata_cache)
      .where(eq(ai_gateway_metadata_cache.url, source.url))
      .limit(1);
    return row ? source.parse(row.data) : null;
  } catch (error) {
    warnExceptInTest(`[metadata-cache] stored ${source.url} is unusable`, error);
    return null;
  }
}

export async function getMetadata<T>(
  source: MetadataSource<T>,
  fromDb: MetadataDb,
  fetchFallback: () => Promise<T> = async () => (await fetchMetadata(source)).data
): Promise<T> {
  return (await readStoredMetadata(source, fromDb)) ?? (await fetchFallback());
}

export function createCachedMetadataReader<T>(
  source: MetadataSource<T>,
  options: { fromDb: MetadataDb; ttlMs: number; fetchFallback?: () => Promise<T> }
) {
  let lastError: unknown = null;
  const create = () =>
    createCachedFetch<T | null>(
      () => getMetadata(source, options.fromDb, options.fetchFallback),
      options.ttlMs,
      null,
      {
        name: `metadata-cache ${source.url}`,
        onRefreshFailure: ({ error }) => {
          lastError = error;
        },
      }
    );
  let cached = create();

  return {
    async get(): Promise<T> {
      const value = await cached();
      if (value === null) {
        throw lastError instanceof Error
          ? lastError
          : new Error(`Metadata from ${source.url} is unavailable`);
      }
      return value;
    },
    reset() {
      lastError = null;
      cached = create();
    },
  };
}
