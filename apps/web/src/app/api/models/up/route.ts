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
  absoluteDrop: number; // Absolute difference (negative for drops)
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

// Models excluded from the health check but still preferred/recommended.
// Useful for preview models with inconsistent traffic that cause false alerts.
const HEALTH_CHECK_EXCLUSIONS = new Set(['google/gemini-3.1-pro-preview']);

export async function GET(
  request: Request
): Promise<NextResponse<HealthResponse | HealthResponseError>> {
  const { searchParams } = new URL(request.url);
  const key = searchParams.get('key');

  if (key !== HEALTH_CHECK_KEY) {
    return NextResponse.json({ healthy: false }, { status: 401 });
  }

  const monitoredModels = (await getMonitoredModels()).filter(m => !HEALTH_CHECK_EXCLUSIONS.has(m));

  try {
    const queryStartTime = Date.now();
    const result = await db.execute<{
      requested_model: string;
      current_requests: string;
      previous_requests: string;
      baseline_requests: string;
    }>(sql`
      WITH all_periods AS (
        SELECT
          requested_model,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '15 minutes') AS current_requests,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 minutes'
                           AND created_at < NOW() - INTERVAL '15 minutes') AS previous_requests,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '2 hours'
                           AND created_at < NOW() - INTERVAL '30 minutes') / 6.0 AS avg_baseline
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
        ROUND(avg_baseline)::text AS baseline_requests
      FROM all_periods
    `);

    const models: Record<string, ModelHealthMetrics> = {};
    let hasSignificantDrop = false;

    result.rows.forEach(row => {
      const currentRequests = parseInt(row.current_requests, 10);
      const previousRequests = parseInt(row.previous_requests, 10);
      const baselineRequests = parseInt(row.baseline_requests, 10);
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
      };

      // Alert logic:
      // - High traffic models (>HIGH_BASELINE): Alert on >90% drop
      // - Low traffic models (>LOW_BASELINE && <HIGH_BASELINE): Alert on consecutive zeros (current AND previous)

      if (
        (baselineRequests > HIGH_BASELINE && percentChange < -90) ||
        (baselineRequests > LOW_BASELINE &&
          baselineRequests < HIGH_BASELINE &&
          currentRequests === 0 &&
          previousRequests === 0)
      ) {
        hasSignificantDrop = true;
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

    return NextResponse.json({ healthy: false }, { status: 503 });
  }
}
