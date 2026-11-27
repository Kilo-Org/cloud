import { captureException } from '@sentry/nextjs';
import { NextResponse } from 'next/server';
import type { ZodType } from 'zod';

import { createCachedFetch } from '@kilocode/web-shared/lib/cached-fetch';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import type { RedisKey } from '@kilocode/web-shared/lib/redis-keys';
import { executeSnowflakeStatement, resolveSnowflakeConfig } from '@/lib/snowflake';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// The Vercel edge cache and the in-process cache share one short TTL, so a new
// report reaches readers within minutes of the source changing.
const CACHE_TTL_SECONDS = 300;
const IN_MEMORY_CACHE_TTL_MS = CACHE_TTL_SECONDS * 1000;
// Redis fronts only slow or costly sources, so it keeps a longer TTL to bound
// how often instances query them.
const REDIS_CACHE_TTL_SECONDS = 3600;

type PublicReportOptions<Usage> = {
  /**
   * Shares the report across instances through Redis. Only worth it for a slow
   * or costly source; a cheap one relies on the edge and in-process caches.
   */
  cacheKey?: RedisKey;
  errorMessage: string;
  /** Loads the report from its source. Throws when the source fails. */
  load: () => Promise<Usage>;
  schema: ZodType<Usage>;
  source: string;
  /** Answers 503 without loading when the source is not configured. */
  unavailable?: () => string | null;
};

function successResponse<Usage>(usage: Usage): NextResponse {
  return NextResponse.json(usage, {
    headers: {
      ...CORS_HEADERS,
      'Cache-Control': `public, s-maxage=${CACHE_TTL_SECONDS}, stale-while-revalidate=${CACHE_TTL_SECONDS}`,
    },
  });
}

/**
 * Load the report, through Redis when the report has a `cacheKey`. Throws on
 * source failure so the in-process cache keeps serving the last-known-good
 * value (or `null` when nothing has been cached).
 */
async function fetchReport<Usage>(options: PublicReportOptions<Usage>): Promise<Usage> {
  const { cacheKey } = options;
  if (cacheKey) {
    try {
      const cached = await redisClient.get<string>(cacheKey);
      if (cached !== null) {
        return options.schema.parse(JSON.parse(cached));
      }
    } catch (error) {
      captureException(error, {
        tags: { source: options.source, operation: 'redis-read' },
      });
    }
  }

  try {
    const usage = options.schema.parse(await options.load());

    if (cacheKey) {
      try {
        await redisClient.set(cacheKey, JSON.stringify(usage), {
          ex: REDIS_CACHE_TTL_SECONDS,
        });
      } catch (error) {
        captureException(error, {
          tags: { source: options.source, operation: 'redis-write' },
        });
      }
    }

    return usage;
  } catch (error) {
    captureException(error, {
      tags: { source: options.source },
    });
    throw error;
  }
}

/**
 * Builds a cached GET handler for a public report.
 *
 * Caching cascades through up to three layers: the Vercel edge cache
 * (`s-maxage`) and an in-process `createCachedFetch`, both expiring after five
 * minutes, and, with a `cacheKey`, Redis in front of the source for one hour.
 * The in-process cache is created once per report (module scope) and stores
 * pure data, so it is safe to share across requests.
 */
export function createPublicReport<Usage>(options: PublicReportOptions<Usage>) {
  const getCachedReport = createCachedFetch<Usage | null>(
    () => fetchReport(options),
    IN_MEMORY_CACHE_TTL_MS,
    null,
    { name: `publicReport[${options.source}]` }
  );

  return async function GET(): Promise<NextResponse> {
    const unavailable = options.unavailable?.();
    if (unavailable) {
      return NextResponse.json(
        { error: unavailable },
        {
          status: 503,
          headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store' },
        }
      );
    }

    const usage = await getCachedReport();
    if (usage === null) {
      return NextResponse.json(
        { error: options.errorMessage },
        {
          status: 502,
          headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store' },
        }
      );
    }

    return successResponse(usage);
  };
}

/** A public report loaded with one Snowflake statement. */
export function createPublicSnowflakeReport<Usage>({
  query,
  parseRows,
  ...options
}: Omit<PublicReportOptions<Usage>, 'load' | 'unavailable'> & {
  query: string;
  parseRows: (rows: string[][]) => Usage | Promise<Usage>;
}) {
  return createPublicReport({
    ...options,
    unavailable: () => (resolveSnowflakeConfig() ? null : 'Snowflake is not configured'),
    load: async () => {
      const config = resolveSnowflakeConfig();
      if (!config) {
        throw new Error('Snowflake is not configured');
      }
      const rows = await executeSnowflakeStatement({
        config,
        statement: query,
        timeoutSeconds: 30,
      });
      return await parseRows(rows);
    },
  });
}

export function publicReportOptions(): NextResponse {
  return new NextResponse(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}
