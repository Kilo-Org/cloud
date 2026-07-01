import { captureException } from '@sentry/nextjs';
import { NextResponse } from 'next/server';
import type { ZodType } from 'zod';

import { createCachedFetch } from '@/lib/cached-fetch';
import { redisClient } from '@/lib/redis';
import type { RedisKey } from '@/lib/redis-keys';
import { executeSnowflakeStatement, resolveSnowflakeConfig } from '@/lib/snowflake';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Single source of truth for every cache layer in front of Snowflake: the
// Vercel edge cache, the in-process cache, and the Redis cache all expire after
// one hour so the data served stays consistent across layers.
const CACHE_TTL_SECONDS = 3600;
const IN_MEMORY_CACHE_TTL_MS = CACHE_TTL_SECONDS * 1000;

type PublicSnowflakeReportOptions<Usage> = {
  cacheKey: RedisKey;
  errorMessage: string;
  parseRows: (rows: string[][]) => Usage;
  query: string;
  schema: ZodType<Usage>;
  source: string;
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
 * Read the report from Redis, falling back to Snowflake on a miss and
 * repopulating Redis. Throws on Snowflake failure so the in-process cache keeps
 * serving the last-known-good value (or `null` when nothing has been cached).
 */
async function fetchReport<Usage>(
  options: PublicSnowflakeReportOptions<Usage>
): Promise<Usage | null> {
  try {
    const cached = await redisClient.get<string>(options.cacheKey);
    if (cached !== null) {
      return options.schema.parse(JSON.parse(cached));
    }
  } catch (error) {
    captureException(error, {
      tags: { source: options.source, operation: 'redis-read' },
    });
  }

  const config = resolveSnowflakeConfig();
  if (!config) {
    return null;
  }

  try {
    const rows = await executeSnowflakeStatement({
      config,
      statement: options.query,
      timeoutSeconds: 30,
    });
    const usage = options.schema.parse(options.parseRows(rows));

    try {
      await redisClient.set(options.cacheKey, JSON.stringify(usage), {
        ex: CACHE_TTL_SECONDS,
      });
    } catch (error) {
      captureException(error, {
        tags: { source: options.source, operation: 'redis-write' },
      });
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
 * Builds a cached GET handler for a public Snowflake-backed report.
 *
 * Caching cascades through three layers, all expiring after one hour: the
 * Vercel edge cache (`s-maxage`), an in-process `createCachedFetch` so warm
 * instances avoid Redis entirely, and the Redis cache in front of Snowflake.
 * The in-process cache is created once per report (module scope) and stores
 * pure data, so it is safe to share across requests.
 */
export function createPublicSnowflakeReport<Usage>(options: PublicSnowflakeReportOptions<Usage>) {
  const getCachedReport = createCachedFetch<Usage | null>(
    () => fetchReport(options),
    IN_MEMORY_CACHE_TTL_MS,
    null
  );

  return async function GET(): Promise<NextResponse> {
    if (!resolveSnowflakeConfig()) {
      return NextResponse.json(
        { error: 'Snowflake is not configured' },
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

export function publicSnowflakeReportOptions(): NextResponse {
  return new NextResponse(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}
