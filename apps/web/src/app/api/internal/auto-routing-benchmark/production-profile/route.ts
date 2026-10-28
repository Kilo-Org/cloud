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
// The usage tables are large: a multi-day scan times out on the replica, while
// six hours aggregates in seconds and still covers thousands of requests.
const WINDOW_HOURS = 6;

export async function GET(req: NextRequest) {
  const token = extractBearerToken(req.headers.get('authorization'));
  if (!INTERNAL_API_SECRET || !token || !timingSafeEqual(token, INTERNAL_API_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const windowStart = sql`NOW() - make_interval(hours => ${WINDOW_HOURS}::int)`;
  const perSession = db
    .select({
      sessionId: sql<string | null>`${microdollar_usage_metadata.session_id}`.as('session_id'),
      requests: sql<number>`count(*)::int`.as('requests'),
      uncached:
        sql<number>`sum(greatest(${microdollar_usage.input_tokens} - ${microdollar_usage.cache_hit_tokens}, 0))::double precision`.as(
          'uncached'
        ),
      cached: sql<number>`sum(${microdollar_usage.cache_hit_tokens})::double precision`.as(
        'cached'
      ),
    })
    .from(microdollar_usage_metadata)
    .innerJoin(auto_model, eq(auto_model.auto_model_id, microdollar_usage_metadata.auto_model_id))
    .innerJoin(microdollar_usage, eq(microdollar_usage.id, microdollar_usage_metadata.id))
    .where(
      and(
        eq(auto_model.auto_model, AUTO_MODEL_ID),
        // The metadata bound is what makes this query use an index; without it the
        // scan times out. Rows with a null metadata timestamp are dropped, a small
        // sample loss accepted for a query that finishes.
        sql`${microdollar_usage_metadata.created_at} >= ${windowStart}`,
        sql`${microdollar_usage.created_at} >= ${windowStart}`
      )
    )
    .groupBy(microdollar_usage_metadata.session_id)
    .as('per_session');

  const [row] = await db
    .select({
      sampleRequests: sql<number | null>`sum(${perSession.requests})::int`,
      uncached: sql<number | null>`sum(${perSession.uncached})::double precision`,
      cached: sql<number | null>`sum(${perSession.cached})::double precision`,
      medianTurns: sql<
        number | null
      >`percentile_cont(0.5) WITHIN GROUP (ORDER BY ${perSession.requests}) FILTER (WHERE ${perSession.sessionId} IS NOT NULL)`,
    })
    .from(perSession);

  const sampleRequests = row?.sampleRequests ?? 0;
  if (sampleRequests === 0) {
    return NextResponse.json(ProductionAutoMetricsResponseSchema.parse({ metrics: null }));
  }

  const metrics = ProductionAutoMetricsSchema.parse({
    windowHours: WINDOW_HOURS,
    sampleRequests,
    uncachedInputTokens: (row?.uncached ?? 0) / sampleRequests,
    cachedInputTokens: (row?.cached ?? 0) / sampleRequests,
    medianTurnsPerSession: row?.medianTurns ?? null,
  });
  return NextResponse.json(ProductionAutoMetricsResponseSchema.parse({ metrics }));
}
