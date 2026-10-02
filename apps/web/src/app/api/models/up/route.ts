import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import { z } from 'zod';
import { getEnvVariable } from '@/lib/dotenvx';
import { monitoredModels } from '@/lib/ai-gateway/monitored-models';
import { normalizeModelId } from '@/lib/ai-gateway/model-utils';

// Simple hardcoded key for authentication
const HEALTH_CHECK_KEY = 'kilo-models-health-check';

type ModelHealthMetrics = {
  healthy: boolean;
  monitored: boolean;
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

// Timeout for the Analytics Engine query. If the query takes longer, we fail
// open (report healthy) since a timeout is not evidence of a model being down.
const QUERY_TIMEOUT_MS = 10_000;

const MINUTE_MS = 60 * 1000;
const CURRENT_WINDOW_MS = 15 * MINUTE_MS;
const PREVIOUS_WINDOW_MS = 30 * MINUTE_MS;
const BASELINE_WINDOW_MS = 120 * MINUTE_MS;
// The baseline spans 90 minutes; dividing by 6 compares it per 15-minute window.
const BASELINE_WINDOW_COUNT = 6;

const BucketSchema = z.enum(['current', 'previous', 'baseline']);
type Bucket = z.infer<typeof BucketSchema>;

const AnalyticsEngineResponseSchema = z.object({
  data: z.array(
    z.object({
      model: z.string(),
      bucket: BucketSchema,
      requests: z.coerce.number(),
      unique_users: z.coerce.number(),
    })
  ),
});

type BucketStats = { requests: number; uniqueUsers: number };
type ModelStats = Record<Bucket, BucketStats>;

function emptyModelStats(): ModelStats {
  return {
    current: { requests: 0, uniqueUsers: 0 },
    previous: { requests: 0, uniqueUsers: 0 },
    baseline: { requests: 0, uniqueUsers: 0 },
  };
}

function toAnalyticsEngineModelId(model: string): string {
  return normalizeModelId(model.toLowerCase());
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlDateTime(ms: number): string {
  return `toDateTime(${Math.floor(ms / 1000)})`;
}

function buildHealthQuery(anchorMs: number, modelIds: readonly string[]): string {
  const end = sqlDateTime(anchorMs);
  const currentStart = sqlDateTime(anchorMs - CURRENT_WINDOW_MS);
  const previousStart = sqlDateTime(anchorMs - PREVIOUS_WINDOW_MS);
  const baselineStart = sqlDateTime(anchorMs - BASELINE_WINDOW_MS);

  // o11y_api_metrics schema: blob2 = resolvedModel, blob4 = '1' on error,
  // blob7 = kiloUserId. _sample_interval rescales sampled rows.
  return `
    SELECT
      blob2 AS model,
      if(timestamp >= ${currentStart}, 'current',
        if(timestamp >= ${previousStart}, 'previous', 'baseline')) AS bucket,
      SUM(_sample_interval) AS requests,
      count(DISTINCT blob7) AS unique_users
    FROM o11y_api_metrics
    WHERE timestamp >= ${baselineStart}
      AND timestamp <= ${end}
      AND blob4 = '0'
      AND blob2 IN (${modelIds.map(sqlString).join(', ')})
    GROUP BY model, bucket
    FORMAT JSON
  `;
}

async function queryModelStats(
  anchorMs: number,
  modelIds: readonly string[]
): Promise<Map<string, ModelStats>> {
  const accountId = getEnvVariable('R2_ACCOUNT_ID');
  const token = getEnvVariable('CF_ANALYTICS_ENGINE_TOKEN');
  if (!accountId || !token) {
    throw new Error('Missing Cloudflare Analytics Engine configuration');
  }

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: buildHealthQuery(anchorMs, modelIds),
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
    }
  );

  if (!response.ok) {
    throw new Error(`Analytics Engine query failed (${response.status}): ${await response.text()}`);
  }

  const { data } = AnalyticsEngineResponseSchema.parse(await response.json());
  const statsByModel = new Map<string, ModelStats>();
  for (const row of data) {
    const stats = statsByModel.get(row.model) ?? emptyModelStats();
    stats[row.bucket] = { requests: row.requests, uniqueUsers: row.unique_users };
    statsByModel.set(row.model, stats);
  }
  return statsByModel;
}

function evaluateModelHealth(stats: ModelStats): ModelHealthMetrics {
  const currentRequests = Math.round(stats.current.requests);
  const previousRequests = Math.round(stats.previous.requests);
  const baselineRequests = Math.round(stats.baseline.requests / BASELINE_WINDOW_COUNT);
  const uniqueUsersCurrent = stats.current.uniqueUsers;
  const uniqueUsersBaseline = stats.baseline.uniqueUsers;
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

  return {
    healthy,
    monitored: true,
    currentRequests,
    previousRequests,
    baselineRequests,
    percentChange,
    absoluteDrop,
    uniqueUsersCurrent,
    uniqueUsersBaseline,
  };
}

export async function GET(
  request: Request
): Promise<NextResponse<HealthResponse | HealthResponseError>> {
  const { searchParams } = new URL(request.url);
  const key = searchParams.get('key');

  if (key !== HEALTH_CHECK_KEY) {
    return NextResponse.json({ healthy: false }, { status: 401 });
  }

  // Optional `at` parameter: ISO 8601 timestamp to anchor the query window.
  // When omitted the query uses the current time. Must be within the last 24 hours.
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

  try {
    const queryStartTime = Date.now();
    const anchor = anchorTime ?? new Date(queryStartTime);
    // Analytics Engine stores the resolved model without `:free`-style suffixes,
    // so monitored models are matched on their normalized ID.
    const statsByModel = await queryModelStats(anchor.getTime(), [
      ...new Set(monitoredModels.map(toAnalyticsEngineModelId)),
    ]);

    const models: Record<string, ModelHealthMetrics> = {};
    for (const model of monitoredModels) {
      models[model] = evaluateModelHealth(
        statsByModel.get(toAnalyticsEngineModelId(model)) ?? emptyModelStats()
      );
    }

    const queryExecutionTimeMs = Date.now() - queryStartTime;
    const hasSignificantDrop = Object.values(models).some(m => !m.healthy);
    const status = hasSignificantDrop ? 503 : 200;

    if (hasSignificantDrop) {
      const unhealthy = Object.entries(models)
        .filter(([, m]) => !m.healthy)
        .map(([model, m]) => ({
          model,
          currentRequests: m.currentRequests,
          previousRequests: m.previousRequests,
          baselineRequests: m.baselineRequests,
          percentChange: m.percentChange,
          uniqueUsersBaseline: m.uniqueUsersBaseline,
        }));
      console.error('[models/up] returning 503: unhealthy monitored models', {
        anchorTime: anchor.toISOString(),
        unhealthy,
      });
    }

    return NextResponse.json(
      {
        healthy: !hasSignificantDrop,
        models,
        metadata: {
          timestamp: anchor.toISOString(),
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

    // Fail open: a query timeout or Analytics Engine error is not evidence of a model being down.
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
