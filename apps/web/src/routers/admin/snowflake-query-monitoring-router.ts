import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import { snowflake_query_log } from '@kilocode/db/schema';
import { and, asc, desc, gte, lt, sql } from 'drizzle-orm';
import * as z from 'zod';

const MAX_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;
const bucketSchema = z.enum(['hour', 'day']);

const SnowflakeQueryOverviewInputSchema = z
  .object({
    startDate: z.string().datetime(),
    endDate: z.string().datetime(),
    bucket: bucketSchema,
  })
  .refine(input => Date.parse(input.startDate) < Date.parse(input.endDate), {
    message: 'Start date must be before end date',
    path: ['endDate'],
  })
  .refine(input => Date.parse(input.endDate) - Date.parse(input.startDate) <= MAX_INTERVAL_MS, {
    message: 'Date interval cannot exceed 30 days',
    path: ['endDate'],
  });

type SnowflakeQueryOverviewInput = z.infer<typeof SnowflakeQueryOverviewInputSchema>;

type SeriesPoint = {
  bucketStart: string;
  succeededQueries: number;
  failedQueries: number;
  averageDurationMs: number;
  http429Count: number;
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function numeric(value: number | string | null | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function emptySeries(input: SnowflakeQueryOverviewInput): SeriesPoint[] {
  const firstBucket = new Date(input.startDate);
  if (input.bucket === 'day') firstBucket.setUTCHours(0, 0, 0, 0);
  else firstBucket.setUTCMinutes(0, 0, 0);

  const intervalMs = input.bucket === 'day' ? DAY_MS : HOUR_MS;
  const end = Date.parse(input.endDate);
  const series: SeriesPoint[] = [];
  for (let timestamp = firstBucket.getTime(); timestamp < end; timestamp += intervalMs) {
    series.push({
      bucketStart: new Date(timestamp).toISOString(),
      succeededQueries: 0,
      failedQueries: 0,
      averageDurationMs: 0,
      http429Count: 0,
    });
  }
  return series;
}

export const adminSnowflakeQueryMonitoringRouter = createTRPCRouter({
  getOverview: adminProcedure.input(SnowflakeQueryOverviewInputSchema).query(async ({ input }) => {
    const intervalCondition = and(
      gte(snowflake_query_log.created_at, input.startDate),
      lt(snowflake_query_log.created_at, input.endDate)
    );
    const bucketExpression =
      input.bucket === 'day'
        ? sql<string>`TO_CHAR(DATE_TRUNC('day', ${snowflake_query_log.created_at} AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
        : sql<string>`TO_CHAR(DATE_TRUNC('hour', ${snowflake_query_log.created_at} AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
    const totalRequestExpression = sql<number>`
        ${snowflake_query_log.submit_request_count}
        + ${snowflake_query_log.poll_request_count}
        + ${snowflake_query_log.partition_request_count}
      `;

    const [summaryRows, seriesRows, breakdownRows, recentFailureRows] = await Promise.all([
      db
        .select({
          queryCount: sql<number>`COUNT(*)`,
          succeededQueries: sql<number>`COUNT(*) FILTER (WHERE ${snowflake_query_log.succeeded})`,
          failedQueries: sql<number>`COUNT(*) FILTER (WHERE NOT ${snowflake_query_log.succeeded})`,
          averageDurationMs: sql<number>`COALESCE(AVG(${snowflake_query_log.duration_ms}), 0)`,
          p95DurationMs: sql<number>`COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY ${snowflake_query_log.duration_ms}), 0)`,
          requestCount: sql<number>`COALESCE(SUM(${totalRequestExpression}), 0)`,
          retryCount: sql<number>`COALESCE(SUM(${snowflake_query_log.retry_count}), 0)`,
          http202Count: sql<number>`COALESCE(SUM(${snowflake_query_log.http_202_count}), 0)`,
          http429Count: sql<number>`COALESCE(SUM(${snowflake_query_log.http_429_count}), 0)`,
          partitionCount: sql<number>`COALESCE(SUM(${snowflake_query_log.partition_count}), 0)`,
        })
        .from(snowflake_query_log)
        .where(intervalCondition),
      db
        .select({
          bucketStart: bucketExpression,
          succeededQueries: sql<number>`COUNT(*) FILTER (WHERE ${snowflake_query_log.succeeded})`,
          failedQueries: sql<number>`COUNT(*) FILTER (WHERE NOT ${snowflake_query_log.succeeded})`,
          averageDurationMs: sql<number>`COALESCE(AVG(${snowflake_query_log.duration_ms}), 0)`,
          http429Count: sql<number>`COALESCE(SUM(${snowflake_query_log.http_429_count}), 0)`,
        })
        .from(snowflake_query_log)
        .where(intervalCondition)
        .groupBy(bucketExpression)
        .orderBy(asc(bucketExpression)),
      db
        .select({
          source: snowflake_query_log.source,
          queryLabel: snowflake_query_log.query_label,
          queryCount: sql<number>`COUNT(*)`,
          failedQueries: sql<number>`COUNT(*) FILTER (WHERE NOT ${snowflake_query_log.succeeded})`,
          averageDurationMs: sql<number>`COALESCE(AVG(${snowflake_query_log.duration_ms}), 0)`,
          p95DurationMs: sql<number>`COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY ${snowflake_query_log.duration_ms}), 0)`,
          requestCount: sql<number>`COALESCE(SUM(${totalRequestExpression}), 0)`,
          retryCount: sql<number>`COALESCE(SUM(${snowflake_query_log.retry_count}), 0)`,
          http429Count: sql<number>`COALESCE(SUM(${snowflake_query_log.http_429_count}), 0)`,
        })
        .from(snowflake_query_log)
        .where(intervalCondition)
        .groupBy(snowflake_query_log.source, snowflake_query_log.query_label)
        .orderBy(
          desc(sql`COUNT(*)`),
          asc(snowflake_query_log.source),
          asc(snowflake_query_log.query_label)
        )
        .limit(50),
      db
        .select({
          id: snowflake_query_log.id,
          createdAt: snowflake_query_log.created_at,
          source: snowflake_query_log.source,
          queryLabel: snowflake_query_log.query_label,
          statusCode: snowflake_query_log.status_code,
          durationMs: snowflake_query_log.duration_ms,
          retryCount: snowflake_query_log.retry_count,
          http429Count: snowflake_query_log.http_429_count,
          errorCode: snowflake_query_log.error_code,
          errorMessage: snowflake_query_log.error_message,
        })
        .from(snowflake_query_log)
        .where(and(intervalCondition, sql`NOT ${snowflake_query_log.succeeded}`))
        .orderBy(desc(snowflake_query_log.created_at), desc(snowflake_query_log.id))
        .limit(25),
    ]);

    const summaryRow = summaryRows[0];
    const queryCount = numeric(summaryRow?.queryCount);
    const failedQueries = numeric(summaryRow?.failedQueries);
    const series = emptySeries(input);
    const pointsByBucket = new Map(series.map(point => [point.bucketStart, point]));
    for (const row of seriesRows) {
      const point = pointsByBucket.get(row.bucketStart);
      if (!point) continue;
      point.succeededQueries = numeric(row.succeededQueries);
      point.failedQueries = numeric(row.failedQueries);
      point.averageDurationMs = numeric(row.averageDurationMs);
      point.http429Count = numeric(row.http429Count);
    }

    return {
      summary: {
        queryCount,
        succeededQueries: numeric(summaryRow?.succeededQueries),
        failedQueries,
        failureRate: queryCount > 0 ? failedQueries / queryCount : 0,
        averageDurationMs: numeric(summaryRow?.averageDurationMs),
        p95DurationMs: numeric(summaryRow?.p95DurationMs),
        requestCount: numeric(summaryRow?.requestCount),
        retryCount: numeric(summaryRow?.retryCount),
        http202Count: numeric(summaryRow?.http202Count),
        http429Count: numeric(summaryRow?.http429Count),
        partitionCount: numeric(summaryRow?.partitionCount),
      },
      series,
      breakdown: breakdownRows.map(row => ({
        source: row.source,
        queryLabel: row.queryLabel,
        queryCount: numeric(row.queryCount),
        failedQueries: numeric(row.failedQueries),
        averageDurationMs: numeric(row.averageDurationMs),
        p95DurationMs: numeric(row.p95DurationMs),
        requestCount: numeric(row.requestCount),
        retryCount: numeric(row.retryCount),
        http429Count: numeric(row.http429Count),
      })),
      recentFailures: recentFailureRows.map(row => ({
        id: row.id.toString(),
        createdAt: new Date(row.createdAt).toISOString(),
        source: row.source,
        queryLabel: row.queryLabel,
        statusCode: row.statusCode,
        durationMs: row.durationMs,
        retryCount: row.retryCount,
        http429Count: row.http429Count,
        errorCode: row.errorCode,
        errorMessage: row.errorMessage,
      })),
    };
  }),
});
