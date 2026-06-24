import { captureException } from '@sentry/nextjs';
import { NextResponse } from 'next/server';
import type { ZodType } from 'zod';

import { redisClient } from '@/lib/redis';
import type { RedisKey } from '@/lib/redis-keys';
import { executeSnowflakeStatement, resolveSnowflakeConfig } from '@/lib/snowflake';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const CACHE_TTL_SECONDS = 60;

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
      'Cache-Control': `public, s-maxage=${CACHE_TTL_SECONDS}`,
    },
  });
}

export async function getPublicSnowflakeReport<Usage>({
  cacheKey,
  errorMessage,
  parseRows,
  query,
  schema,
  source,
}: PublicSnowflakeReportOptions<Usage>): Promise<NextResponse> {
  try {
    const cached = await redisClient.get<string>(cacheKey);
    if (cached !== null) {
      return successResponse(schema.parse(JSON.parse(cached)));
    }
  } catch (error) {
    captureException(error, {
      tags: { source, operation: 'redis-read' },
    });
  }

  const config = resolveSnowflakeConfig();
  if (!config) {
    return NextResponse.json(
      { error: 'Snowflake is not configured' },
      {
        status: 503,
        headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store' },
      }
    );
  }

  try {
    const rows = await executeSnowflakeStatement({
      config,
      statement: query,
      timeoutSeconds: 30,
    });
    const usage = schema.parse(parseRows(rows));

    try {
      await redisClient.set(cacheKey, JSON.stringify(usage), {
        ex: CACHE_TTL_SECONDS,
      });
    } catch (error) {
      captureException(error, {
        tags: { source, operation: 'redis-write' },
      });
    }

    return successResponse(usage);
  } catch (error) {
    captureException(error, {
      tags: { source },
    });
    return NextResponse.json(
      { error: errorMessage },
      {
        status: 502,
        headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store' },
      }
    );
  }
}

export function publicSnowflakeReportOptions(): NextResponse {
  return new NextResponse(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}
