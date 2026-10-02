import 'server-only';
import * as z from 'zod';
import {
  queryAnalyticsEngine,
  sqlDateTime,
  sqlString,
  type RunAnalyticsEngineQuery,
} from '@/lib/cloudflare/analytics-engine';

export const MODEL_TRAFFIC_BUCKET_MINUTES = 5;
export const MODEL_TRAFFIC_WINDOW_HOURS = 24;
export const MODEL_TRAFFIC_TOP_MODEL_COUNT = 10;

const BUCKET_MS = MODEL_TRAFFIC_BUCKET_MINUTES * 60 * 1000;
const WINDOW_MS = MODEL_TRAFFIC_WINDOW_HOURS * 60 * 60 * 1000;
const QUERY_TIMEOUT_MS = 15_000;

export type RequestSeries = {
  requests: number[];
  errors: number[];
};

export type ModelTraffic = {
  bucketStarts: string[];
  bucketMinutes: number;
  models: Array<RequestSeries & { model: string; totalRequests: number }>;
  otherModels: RequestSeries;
  allModels: RequestSeries;
};

const BucketTotalsRowSchema = z.object({
  bucket: z.string(),
  requests: z.coerce.number(),
  errors: z.coerce.number(),
});

const TopModelRowSchema = z.object({
  model: z.string(),
  requests: z.coerce.number(),
});

const ModelBucketRowSchema = BucketTotalsRowSchema.extend({ model: z.string() });

const queryO11yAnalyticsEngine: RunAnalyticsEngineQuery = (sql, rowSchema) =>
  queryAnalyticsEngine(sql, rowSchema, { timeoutMs: QUERY_TIMEOUT_MS });

// Analytics Engine returns DateTime values as UTC `YYYY-MM-DD HH:MM:SS`.
function parseBucketMs(bucket: string): number {
  return Date.parse(`${bucket.replace(' ', 'T')}Z`);
}

function buildFilter(startMs: number, endMs: number, excludeByok: boolean): string {
  // o11y_api_metrics schema: blob2 = resolvedModel, blob4 = '1' on error, blob6 = '1' for BYOK.
  return [
    `timestamp >= ${sqlDateTime(startMs)}`,
    `timestamp < ${sqlDateTime(endMs)}`,
    ...(excludeByok ? ["blob6 = '0'"] : []),
  ].join(' AND ');
}

const BUCKET_SELECT = `toStartOfInterval(timestamp, INTERVAL '${MODEL_TRAFFIC_BUCKET_MINUTES}' MINUTE) AS bucket`;
const REQUESTS_SELECT = 'SUM(_sample_interval) AS requests';
const ERRORS_SELECT = "SUM(IF(blob4 = '1', _sample_interval, 0)) AS errors";

function emptySeries(bucketCount: number): RequestSeries {
  return {
    requests: Array.from({ length: bucketCount }, () => 0),
    errors: Array.from({ length: bucketCount }, () => 0),
  };
}

export async function getModelTraffic(
  { now, excludeByok }: { now: Date; excludeByok: boolean },
  runQuery: RunAnalyticsEngineQuery = queryO11yAnalyticsEngine
): Promise<ModelTraffic> {
  // Ending at the last completed bucket keeps the in-progress bucket from looking like a drop.
  const endMs = Math.floor(now.getTime() / BUCKET_MS) * BUCKET_MS;
  const startMs = endMs - WINDOW_MS;
  const bucketCount = WINDOW_MS / BUCKET_MS;
  const filter = buildFilter(startMs, endMs, excludeByok);

  const totalsSql = `
    SELECT ${BUCKET_SELECT}, ${REQUESTS_SELECT}, ${ERRORS_SELECT}
    FROM o11y_api_metrics
    WHERE ${filter}
    GROUP BY bucket
    FORMAT JSON
  `;
  const topModelsSql = `
    SELECT blob2 AS model, ${REQUESTS_SELECT}
    FROM o11y_api_metrics
    WHERE ${filter}
    GROUP BY model
    ORDER BY requests DESC
    LIMIT ${MODEL_TRAFFIC_TOP_MODEL_COUNT}
    FORMAT JSON
  `;
  const [totalRows, topModels] = await Promise.all([
    runQuery(totalsSql, BucketTotalsRowSchema),
    runQuery(topModelsSql, TopModelRowSchema),
  ]);

  const modelBucketsSql = `
    SELECT ${BUCKET_SELECT}, blob2 AS model, ${REQUESTS_SELECT}, ${ERRORS_SELECT}
    FROM o11y_api_metrics
    WHERE ${filter} AND blob2 IN (${topModels.map(row => sqlString(row.model)).join(', ')})
    GROUP BY bucket, model
    FORMAT JSON
  `;
  const modelRows =
    topModels.length === 0 ? [] : await runQuery(modelBucketsSql, ModelBucketRowSchema);

  const bucketIndex = (bucket: string): number | null => {
    const index = (parseBucketMs(bucket) - startMs) / BUCKET_MS;
    return Number.isInteger(index) && index >= 0 && index < bucketCount ? index : null;
  };

  const allModels = emptySeries(bucketCount);
  for (const row of totalRows) {
    const index = bucketIndex(row.bucket);
    if (index === null) continue;
    allModels.requests[index] = Math.round(row.requests);
    allModels.errors[index] = Math.round(row.errors);
  }

  const seriesByModel = new Map(topModels.map(row => [row.model, emptySeries(bucketCount)]));
  for (const row of modelRows) {
    const series = seriesByModel.get(row.model);
    const index = bucketIndex(row.bucket);
    if (!series || index === null) continue;
    series.requests[index] = Math.round(row.requests);
    series.errors[index] = Math.round(row.errors);
  }

  const models = topModels.map(row => ({
    model: row.model,
    totalRequests: Math.round(row.requests),
    ...(seriesByModel.get(row.model) ?? emptySeries(bucketCount)),
  }));

  const otherModels = emptySeries(bucketCount);
  for (let index = 0; index < bucketCount; index++) {
    const topRequests = models.reduce((sum, model) => sum + model.requests[index], 0);
    const topErrors = models.reduce((sum, model) => sum + model.errors[index], 0);
    otherModels.requests[index] = Math.max(0, allModels.requests[index] - topRequests);
    otherModels.errors[index] = Math.max(0, allModels.errors[index] - topErrors);
  }

  return {
    bucketStarts: Array.from({ length: bucketCount }, (_, index) =>
      new Date(startMs + index * BUCKET_MS).toISOString()
    ),
    bucketMinutes: MODEL_TRAFFIC_BUCKET_MINUTES,
    models,
    otherModels,
    allModels,
  };
}
