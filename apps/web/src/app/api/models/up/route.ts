import { db, sql } from '@/lib/drizzle';
import { microdollar_usage } from '@kilocode/db/schema';
import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import { getMonitoredModels } from '@/lib/monitored-models';

// Simple hardcoded key for authentication
const HEALTH_CHECK_KEY = 'kilo-models-health-check';

type ModelHealthMetrics = {
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

  const monitoredModels = await getMonitoredModels();

  try {
    const queryStartTime = Date.now();
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
            COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '15 minutes') AS current_requests,
            COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 minutes'
                             AND created_at < NOW() - INTERVAL '15 minutes') AS previous_requests,
            COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '2 hours'
                             AND created_at < NOW() - INTERVAL '30 minutes') / 6.0 AS avg_baseline,
            COUNT(DISTINCT kilo_user_id) FILTER (WHERE created_at >= NOW() - INTERVAL '15 minutes')
              AS unique_users_current,
            COUNT(DISTINCT kilo_user_id) FILTER (WHERE created_at >= NOW() - INTERVAL '2 hours'
                                                  AND created_at < NOW() - INTERVAL '30 minutes')
              AS unique_users_baseline
          FROM ${microdollar_usage}
          WHERE
            created_at >= NOW() - INTERVAL '2 hours'
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
    let hasSignificantDrop = false;

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

      models[row.requested_model] = {
        currentRequests,
        previousRequests,
        baselineRequests,
        percentChange,
        absoluteDrop,
        uniqueUsersCurrent,
        uniqueUsersBaseline,
      };

      // Alert logic:
      // - High traffic models (>HIGH_BASELINE): Alert on >90% drop
      // - Low traffic models (>LOW_BASELINE && <HIGH_BASELINE): Alert on consecutive zeros (current AND previous)
      // - Only alert if the baseline had enough distinct users to represent organic traffic

      if (uniqueUsersBaseline >= MIN_UNIQUE_USERS_FOR_ALERT) {
        if (
          (baselineRequests > HIGH_BASELINE && percentChange < -90) ||
          (baselineRequests > LOW_BASELINE &&
            baselineRequests < HIGH_BASELINE &&
            currentRequests === 0 &&
            previousRequests === 0)
        ) {
          hasSignificantDrop = true;
        }
      }
    });

    // Ensure all preferred models are in the response (even if no data)
    monitoredModels.forEach(requested_model => {
      if (!models[requested_model]) {
        models[requested_model] = {
          currentRequests: 0,
          previousRequests: 0,
          baselineRequests: 0,
          percentChange: 0,
          absoluteDrop: 0,
          uniqueUsersCurrent: 0,
          uniqueUsersBaseline: 0,
        };
        // Don't mark as unhealthy if no data - baseline is 0 anyway
      }
    });

    const queryExecutionTimeMs = Date.now() - queryStartTime;
    const status = hasSignificantDrop ? 503 : 200;

    return NextResponse.json(
      {
        healthy: !hasSignificantDrop,
        models,
        metadata: {
          timestamp: new Date().toISOString(),
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
