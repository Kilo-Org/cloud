/**
 * Internal API: production auto-request usage for the benchmark worker's daily
 * system-optimal policy re-evaluation.
 *
 * The benchmark worker cannot read Postgres, so it fetches the two production
 * numbers it derives policy settings from: mean uncached/cached input tokens
 * per auto request (the production token profile) and the median number of
 * requests per auto session (the switch horizon). `cache_hit_tokens` is a
 * subset of `input_tokens` — the same relationship `prodCacheReadShare` uses —
 * so uncached input is the difference.
 *
 * Auth: shared internal secret over `Authorization: Bearer <secret>`, the
 * header services/auto-routing-benchmark sends.
 *
 * URL: GET /api/internal/auto-routing-benchmark/production-profile
 */

import {
  ProductionAutoMetricsResponseSchema,
  ProductionAutoMetricsSchema,
} from '@kilocode/auto-routing-contracts';
import { auto_model, microdollar_usage, microdollar_usage_metadata } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { INTERNAL_API_SECRET } from '@kilocode/web-shared/lib/config.server';
import { timingSafeEqual } from '@kilocode/encryption';
import { extractBearerToken } from '@kilocode/worker-utils/extract-bearer-token';
import { eq, sql, and } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

const AUTO_MODEL_ID = 'kilo-auto/efficient';
const WINDOW_DAYS = 7;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export async function GET(req: NextRequest) {
  const token = extractBearerToken(req.headers.get('authorization'));
  if (!INTERNAL_API_SECRET || !token || !timingSafeEqual(token, INTERNAL_API_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const rows = await db
    .select({
      sessionId: sql<string | null>`${microdollar_usage_metadata.session_id}`,
      requests: sql<number>`count(*)::int`,
      uncachedInputTokens: sql<number>`sum(greatest(${microdollar_usage.input_tokens} - ${microdollar_usage.cache_hit_tokens}, 0))::double precision`,
      cachedInputTokens: sql<number>`sum(${microdollar_usage.cache_hit_tokens})::double precision`,
    })
    .from(microdollar_usage_metadata)
    .innerJoin(auto_model, eq(auto_model.auto_model_id, microdollar_usage_metadata.auto_model_id))
    .innerJoin(microdollar_usage, eq(microdollar_usage.id, microdollar_usage_metadata.id))
    .where(
      and(
        eq(auto_model.auto_model, AUTO_MODEL_ID),
        sql`${microdollar_usage.created_at} >= NOW() - make_interval(days => ${WINDOW_DAYS}::int)`
      )
    )
    .groupBy(microdollar_usage_metadata.session_id);

  let sampleRequests = 0;
  let uncachedInputTokens = 0;
  let cachedInputTokens = 0;
  const sessionTurns: number[] = [];
  for (const row of rows) {
    sampleRequests += row.requests;
    uncachedInputTokens += row.uncachedInputTokens;
    cachedInputTokens += row.cachedInputTokens;
    if (row.sessionId !== null) sessionTurns.push(row.requests);
  }
  if (sampleRequests === 0) {
    return NextResponse.json(ProductionAutoMetricsResponseSchema.parse({ metrics: null }));
  }

  const metrics = ProductionAutoMetricsSchema.parse({
    windowDays: WINDOW_DAYS,
    sampleRequests,
    uncachedInputTokens: uncachedInputTokens / sampleRequests,
    cachedInputTokens: cachedInputTokens / sampleRequests,
    medianTurnsPerSession: median(sessionTurns),
  });
  return NextResponse.json(ProductionAutoMetricsResponseSchema.parse({ metrics }));
}
