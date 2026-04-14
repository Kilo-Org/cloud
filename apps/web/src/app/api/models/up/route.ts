import { db, sql } from '@/lib/drizzle';
import { microdollar_usage } from '@kilocode/db/schema';
import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import { getMonitoredModels } from '@/lib/monitored-models';

// Simple hardcoded key for authentication
const HEALTH_CHECK_KEY = 'kilo-models-health-check';

type ModelHealthMetrics = {
  healthy: boolean;
  currentRequests: number;
  previousRequests: number;
  baselineRequests: number;
  percentChange: number;
  absoluteDrop: number;
  uniqueUsersCurrent: number;
  uniqueUsersBaseline: number;
};

type HealthResponseMetadata = {
  timestamp: string;
  queryExecutionTimeMs: number;
};

type HealthResponse = {
  healthy: boolean;
  models: Record<string, ModelHealthMetrics>;
  metadata: HealthResponseMetadata;
};

type HealthResponseError = {
  healthy: boolean;
};

const HIGH_BASELINE = 300;
const LOW_BASELINE = 50;

// Only alert if the baseline window had at least this many distinct users.
// Prevents abuse actors (who operate many accounts from few IPs) from
// inflating baselines and triggering false drops when they pause.
const MIN_UNIQUE_USERS_FOR_ALERT = 20;

// Statement timeout for the health check query. If the query takes longer,
// we fail open (report healthy) since a timeout is not evidence of a model
// being down.
const STATEMENT_TIMEOUT_MS = 10_000;

export async function GET(
  request: Request
): Promise<NextResponse<HealthResponse | HealthResponseError>> {
  const { searchParams } = new URL(request.url);
  const key = searchParams.get('key');

  if (key !== HEALTH_CHECK_KEY) {
    return NextResponse.json({ healthy: false }, { status: 401 });
  }

  // Optional `at` parameter: ISO 8601 timestamp to anchor the query window.
  // When omitted the query uses NOW(). Must be within the last 24 hours.
  const atParam = searchParams.get('at');
  let anchorTime: Date | null = null;
  if (atParam) {
    const parsed = new Date(atParam);
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json({ healthy: false }, { status: 400 });
    }
    const ageMs = Date.now() - parsed.getTime();
    if (ageMs < 0 || ageMs > 24 * 60 * 60 * 1000) {
      return NextResponse.json({ healthy: false }, { status: 400 });
    }
    anchorTime = parsed;
  }

  const monitoredModels = await getMonitoredModels();

  try {
    const queryStartTime = Date.now();
    // When an anchor time is provided, replace NOW() with the fixed timestamp.
    const ref = anchorTime ? sql`${anchorTime.toISOString()}::timestamptz` : sql`NOW()`;
    const result = await db.transaction(async tx => {
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}'`));
      return tx.execute<{
        requested_model: string;
        current_requests: string;
        previous_requests: string;
        baseline_requests: string;
        unique_users_current: string;
        unique_users_baseline: string;
      }>(sql`
        WITH all_periods AS (
          SELECT
            requested_model,
            COUNT(*) FILTER (WHERE created_at >= ${ref} - INTERVAL '15 minutes'
                                  AND created_at <= ${ref}) AS current_requests,
            COUNT(*) FILTER (WHERE created_at >= ${ref} - INTERVAL '30 minutes'
                             AND created_at < ${ref} - INTERVAL '15 minutes') AS previous_requests,
            COUNT(*) FILTER (WHERE created_at >= ${ref} - INTERVAL '2 hours'
                             AND created_at < ${ref} - INTERVAL '30 minutes') / 6.0 AS avg_baseline,
            COUNT(DISTINCT kilo_user_id) FILTER (WHERE created_at >= ${ref} - INTERVAL '15 minutes'
                                                       AND created_at <= ${ref})
              AS unique_users_current,
            COUNT(DISTINCT kilo_user_id) FILTER (WHERE created_at >= ${ref} - INTERVAL '2 hours'
                                                  AND created_at < ${ref} - INTERVAL '30 minutes')
              AS unique_users_baseline
          FROM ${microdollar_usage}
          WHERE
            created_at >= ${ref} - INTERVAL '2 hours'
            AND created_at <= ${ref}
            AND has_error = false
            AND requested_model IN (${sql.join(monitoredModels, sql`, `)})
          GROUP BY requested_model
        )
        SELECT
          requested_model,
          current_requests::text AS current_requests,
          previous_requests::text AS previous_requests,
          ROUND(avg_baseline)::text AS baseline_requests,
          unique_users_current::text AS unique_users_current,
          unique_users_baseline::text AS unique_users_baseline
        FROM all_periods
      `);
    });

    const models: Record<string, ModelHealthMetrics> = {};

    result.rows.forEach(row => {
      const currentRequests = parseInt(row.current_requests, 10);
      const previousRequests = parseInt(row.previous_requests, 10);
      const baselineRequests = parseInt(row.baseline_requests, 10);
      const uniqueUsersCurrent = parseInt(row.unique_users_current, 10);
      const uniqueUsersBaseline = parseInt(row.unique_users_baseline, 10);
      const percentChange =
        baselineRequests > 0
          ? Math.round(((currentRequests - baselineRequests) / baselineRequests) * 100)
          : 0;
      const absoluteDrop = currentRequests - baselineRequests;

      // Per-model health: unhealthy when the baseline had enough distinct organic
      // users AND the model shows a significant traffic drop.
      const healthy = !(
        uniqueUsersBaseline >= MIN_UNIQUE_USERS_FOR_ALERT &&
        ((baselineRequests > HIGH_BASELINE && percentChange < -90) ||
          (baselineRequests > LOW_BASELINE &&
            baselineRequests < HIGH_BASELINE &&
            currentRequests === 0 &&
            previousRequests === 0))
      );

      models[row.requested_model] = {
        healthy,
        currentRequests,
        previousRequests,
        baselineRequests,
        percentChange,
        absoluteDrop,
        uniqueUsersCurrent,
        uniqueUsersBaseline,
      };
    });

    // Ensure all preferred models are in the response (even if no data)
    for (const requested_model of monitoredModels) {
      if (!models[requested_model]) {
        models[requested_model] = {
          healthy: true,
          currentRequests: 0,
          previousRequests: 0,
          baselineRequests: 0,
          percentChange: 0,
          absoluteDrop: 0,
          uniqueUsersCurrent: 0,
          uniqueUsersBaseline: 0,
        };
      }
    }

    const queryExecutionTimeMs = Date.now() - queryStartTime;
    const hasSignificantDrop = Object.values(models).some(m => !m.healthy);
    const status = hasSignificantDrop ? 503 : 200;

    return NextResponse.json(
      {
        healthy: !hasSignificantDrop,
        models,
        metadata: {
          timestamp: (anchorTime ?? new Date()).toISOString(),
          queryExecutionTimeMs,
        },
      },
      { status }
    );
  } catch (error) {
    captureException(error, {
      tags: { endpoint: 'models/up', source: 'model_health_check' },
      extra: { monitoredModels },
    });

    // Fail open: a query timeout or DB error is not evidence of a model being down.
    return NextResponse.json(
      {
        healthy: true,
        models: {} as Record<string, ModelHealthMetrics>,
        metadata: {
          timestamp: new Date().toISOString(),
          queryExecutionTimeMs: -1,
        },
      },
      { status: 200 }
    );
  }
}
