import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import {
  cli_sessions_v2,
  cloud_agent_session_runs,
  cloud_agent_sessions,
} from '@kilocode/db/schema';
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gte,
  isNotNull,
  isNull,
  lt,
  ne,
  notExists,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import * as z from 'zod';

const MAX_INTERVAL_MS = 90 * 24 * 60 * 60 * 1000;
const HEALTH_ERROR_SESSION_LIMIT = 100;
const healthBucketSchema = z.enum(['hour', 'day']);
const healthErrorSourceSchema = z.enum(['setup', 'run']);
const createdOnPlatformSchema = z.string().min(1).max(100).nullable().optional();
const intervalShape = { startDate: z.string().datetime(), endDate: z.string().datetime() };

function hasAscendingInterval(input: { startDate: string; endDate: string }) {
  return new Date(input.startDate).getTime() < new Date(input.endDate).getTime();
}

function hasBoundedInterval(input: { startDate: string; endDate: string }) {
  return new Date(input.endDate).getTime() - new Date(input.startDate).getTime() <= MAX_INTERVAL_MS;
}

const HealthOverviewFilterSchema = z
  .object({
    ...intervalShape,
    bucket: healthBucketSchema,
    createdOnPlatform: createdOnPlatformSchema,
  })
  .refine(input => hasAscendingInterval(input), {
    message: 'Start date must be before end date',
    path: ['endDate'],
  })
  .refine(input => hasBoundedInterval(input), {
    message: 'Date interval cannot exceed 90 days',
    path: ['endDate'],
  });
const HealthErrorSessionsFilterSchema = z
  .object({
    ...intervalShape,
    source: healthErrorSourceSchema,
    stage: z.string().trim().min(1).max(100),
    code: z.string().trim().min(1).max(100),
    createdOnPlatform: createdOnPlatformSchema,
  })
  .refine(input => hasAscendingInterval(input), {
    message: 'Start date must be before end date',
    path: ['endDate'],
  })
  .refine(input => hasBoundedInterval(input), {
    message: 'Date interval cannot exceed 90 days',
    path: ['endDate'],
  });
type IntervalFilter = { startDate: string; endDate: string };
type HealthOverviewFilter = z.infer<typeof HealthOverviewFilterSchema>;

function iso(value: string): string {
  return new Date(value).toISOString();
}

function nullableIso(value: string | null | undefined): string | null {
  return value ? iso(value) : null;
}

function count(value: number | string | null | undefined): number {
  return Number(value) || 0;
}

function retainedSessionCondition(): SQL {
  return gtCreatedAtRetentionWindow();
}

function gtCreatedAtRetentionWindow(): SQL {
  return sql`${cloud_agent_sessions.created_at} > now() - interval '90 days'`;
}

function terminalRunIntervalConditions(input: IntervalFilter): SQL[] {
  return [
    gte(cloud_agent_session_runs.terminal_at, input.startDate),
    lt(cloud_agent_session_runs.terminal_at, input.endDate),
    retainedSessionCondition(),
  ];
}

function createdOnPlatformConditions(input: { createdOnPlatform?: string | null }): SQL[] {
  if (input.createdOnPlatform === undefined) return [];
  if (input.createdOnPlatform === null) {
    return [
      notExists(
        db
          .select({ one: sql`1` })
          .from(cli_sessions_v2)
          .where(
            and(
              eq(
                cli_sessions_v2.cloud_agent_session_id,
                cloud_agent_sessions.cloud_agent_session_id
              ),
              ne(cli_sessions_v2.created_on_platform, 'unknown')
            )
          )
      ),
    ];
  }
  return [
    exists(
      db
        .select({ one: sql`1` })
        .from(cli_sessions_v2)
        .where(
          and(
            eq(cli_sessions_v2.cloud_agent_session_id, cloud_agent_sessions.cloud_agent_session_id),
            eq(cli_sessions_v2.created_on_platform, input.createdOnPlatform)
          )
        )
    ),
  ];
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type HealthSeriesPoint = {
  bucketStart: string;
  completedRuns: number;
  failedRuns: number;
  interruptedRuns: number;
  setupFailures: number;
};

type HealthError = {
  source: 'setup' | 'run';
  stage: string;
  code: string;
  count: number;
};

function emptyHealthSeries(input: HealthOverviewFilter): HealthSeriesPoint[] {
  const firstBucket = new Date(input.startDate);
  if (input.bucket === 'day') firstBucket.setUTCHours(0, 0, 0, 0);
  else firstBucket.setUTCMinutes(0, 0, 0);
  const end = new Date(input.endDate).getTime();
  const bucketMs = input.bucket === 'day' ? DAY_MS : HOUR_MS;
  const series: HealthSeriesPoint[] = [];
  for (let timestamp = firstBucket.getTime(); timestamp < end; timestamp += bucketMs) {
    series.push({
      bucketStart: new Date(timestamp).toISOString(),
      completedRuns: 0,
      failedRuns: 0,
      interruptedRuns: 0,
      setupFailures: 0,
    });
  }
  return series;
}

export const adminCloudAgentNextRouter = createTRPCRouter({
  listHealthPlatforms: adminProcedure.query(async () => {
    const rows = await db
      .selectDistinct({ createdOnPlatform: cli_sessions_v2.created_on_platform })
      .from(cloud_agent_sessions)
      .innerJoin(
        cli_sessions_v2,
        eq(cli_sessions_v2.cloud_agent_session_id, cloud_agent_sessions.cloud_agent_session_id)
      )
      .where(and(retainedSessionCondition(), ne(cli_sessions_v2.created_on_platform, 'unknown')))
      .orderBy(asc(cli_sessions_v2.created_on_platform));
    return rows.map(row => row.createdOnPlatform);
  }),

  getHealthOverview: adminProcedure.input(HealthOverviewFilterSchema).query(async ({ input }) => {
    const terminalBucket =
      input.bucket === 'day'
        ? sql<string>`TO_CHAR(DATE_TRUNC('day', ${cloud_agent_session_runs.terminal_at} AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
        : sql<string>`TO_CHAR(DATE_TRUNC('hour', ${cloud_agent_session_runs.terminal_at} AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
    const setupBucket =
      input.bucket === 'day'
        ? sql<string>`TO_CHAR(DATE_TRUNC('day', ${cloud_agent_sessions.failure_at} AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
        : sql<string>`TO_CHAR(DATE_TRUNC('hour', ${cloud_agent_sessions.failure_at} AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
    const sessionStage = sql<string>`COALESCE(${cloud_agent_sessions.failure_stage}, 'unclassified')`;
    const sessionCode = sql<string>`COALESCE(${cloud_agent_sessions.failure_code}, 'unclassified')`;
    const runStage = sql<string>`COALESCE(${cloud_agent_session_runs.failure_stage}, 'unknown')`;
    const runCode = sql<string>`COALESCE(${cloud_agent_session_runs.failure_code}, 'unclassified')`;
    const [terminalRows, setupRows, runErrorRows] = await Promise.all([
      db
        .select({
          bucketStart: terminalBucket,
          completed: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_session_runs.status} = 'completed')`,
          failed: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_session_runs.status} = 'failed')`,
          interrupted: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_session_runs.status} = 'interrupted')`,
        })
        .from(cloud_agent_session_runs)
        .innerJoin(
          cloud_agent_sessions,
          eq(
            cloud_agent_session_runs.cloud_agent_session_id,
            cloud_agent_sessions.cloud_agent_session_id
          )
        )
        .where(and(...terminalRunIntervalConditions(input), ...createdOnPlatformConditions(input)))
        .groupBy(terminalBucket)
        .orderBy(terminalBucket),
      db
        .select({
          bucketStart: setupBucket,
          stage: sessionStage,
          code: sessionCode,
          count: sql<number>`COUNT(*)`,
        })
        .from(cloud_agent_sessions)
        .where(
          and(
            isNotNull(cloud_agent_sessions.failure_at),
            gte(cloud_agent_sessions.failure_at, input.startDate),
            lt(cloud_agent_sessions.failure_at, input.endDate),
            retainedSessionCondition(),
            ...createdOnPlatformConditions(input)
          )
        )
        .groupBy(setupBucket, sessionStage, sessionCode)
        .orderBy(setupBucket),
      db
        .select({ stage: runStage, code: runCode, count: sql<number>`COUNT(*)` })
        .from(cloud_agent_session_runs)
        .innerJoin(
          cloud_agent_sessions,
          eq(
            cloud_agent_session_runs.cloud_agent_session_id,
            cloud_agent_sessions.cloud_agent_session_id
          )
        )
        .where(
          and(
            eq(cloud_agent_session_runs.status, 'failed'),
            ...terminalRunIntervalConditions(input),
            ...createdOnPlatformConditions(input)
          )
        )
        .groupBy(runStage, runCode),
    ]);
    const series = emptyHealthSeries(input);
    const pointsByBucket = new Map(series.map(point => [point.bucketStart, point]));
    for (const row of terminalRows) {
      const point = pointsByBucket.get(row.bucketStart);
      if (!point) continue;
      point.completedRuns = count(row.completed);
      point.failedRuns = count(row.failed);
      point.interruptedRuns = count(row.interrupted);
    }
    const setupErrorsByCode = new Map<string, HealthError>();
    for (const row of setupRows) {
      const occurrences = count(row.count);
      const point = pointsByBucket.get(row.bucketStart);
      if (point) point.setupFailures += occurrences;
      const key = `${row.stage}:${row.code}`;
      const existingError = setupErrorsByCode.get(key);
      if (existingError) {
        existingError.count += occurrences;
      } else {
        setupErrorsByCode.set(key, {
          source: 'setup',
          stage: row.stage,
          code: row.code,
          count: occurrences,
        });
      }
    }
    const summary = series.reduce(
      (totals, point) => ({
        completedRuns: totals.completedRuns + point.completedRuns,
        failedRuns: totals.failedRuns + point.failedRuns,
        interruptedRuns: totals.interruptedRuns + point.interruptedRuns,
        setupFailures: totals.setupFailures + point.setupFailures,
      }),
      { completedRuns: 0, failedRuns: 0, interruptedRuns: 0, setupFailures: 0 }
    );
    const topErrors = [
      ...setupErrorsByCode.values(),
      ...runErrorRows.map(
        row =>
          ({
            source: 'run',
            stage: row.stage,
            code: row.code,
            count: count(row.count),
          }) satisfies HealthError
      ),
    ]
      .sort(
        (left, right) =>
          right.count - left.count ||
          left.source.localeCompare(right.source) ||
          left.stage.localeCompare(right.stage) ||
          left.code.localeCompare(right.code)
      )
      .slice(0, 10);
    return { summary, series, topErrors };
  }),

  listHealthErrorSessions: adminProcedure
    .input(HealthErrorSessionsFilterSchema)
    .query(async ({ input }) => {
      if (input.source === 'setup') {
        const where = and(
          sql`${cloud_agent_sessions.failure_stage} = ${input.stage}`,
          sql`${cloud_agent_sessions.failure_code} = ${input.code}`,
          isNotNull(cloud_agent_sessions.failure_at),
          gte(cloud_agent_sessions.failure_at, input.startDate),
          lt(cloud_agent_sessions.failure_at, input.endDate),
          retainedSessionCondition(),
          ...createdOnPlatformConditions(input)
        );
        const [totals, rows] = await Promise.all([
          db
            .select({ total: sql<number>`COUNT(*)` })
            .from(cloud_agent_sessions)
            .where(where),
          db
            .select({
              cloudAgentSessionId: cloud_agent_sessions.cloud_agent_session_id,
              kiloSessionId: cloud_agent_sessions.kilo_session_id,
              occurredAt: cloud_agent_sessions.failure_at,
            })
            .from(cloud_agent_sessions)
            .where(where)
            .orderBy(
              desc(cloud_agent_sessions.failure_at),
              desc(cloud_agent_sessions.cloud_agent_session_id)
            )
            .limit(HEALTH_ERROR_SESSION_LIMIT),
        ]);
        return {
          totalSessions: count(totals[0]?.total),
          limit: HEALTH_ERROR_SESSION_LIMIT,
          rows: rows.map(row => ({
            cloudAgentSessionId: row.cloudAgentSessionId,
            kiloSessionId: row.kiloSessionId,
            occurredAt: nullableIso(row.occurredAt),
            matchingEvents: 1,
          })),
        };
      }

      const classifiedFailureCondition =
        and(
          sql`${cloud_agent_session_runs.failure_stage} = ${input.stage}`,
          sql`${cloud_agent_session_runs.failure_code} = ${input.code}`
        ) ?? sql`false`;
      const selectedFailureCondition =
        input.stage === 'unknown' && input.code === 'unclassified'
          ? (or(
              and(
                isNull(cloud_agent_session_runs.failure_stage),
                isNull(cloud_agent_session_runs.failure_code)
              ),
              classifiedFailureCondition
            ) ?? sql`false`)
          : classifiedFailureCondition;
      const where = and(
        eq(cloud_agent_session_runs.status, 'failed'),
        selectedFailureCondition,
        ...terminalRunIntervalConditions(input),
        ...createdOnPlatformConditions(input)
      );
      const latestOccurredAt = sql<string>`MAX(${cloud_agent_session_runs.terminal_at})`;
      const [totals, rows] = await Promise.all([
        db
          .select({
            total: sql<number>`COUNT(DISTINCT ${cloud_agent_session_runs.cloud_agent_session_id})`,
          })
          .from(cloud_agent_session_runs)
          .innerJoin(
            cloud_agent_sessions,
            eq(
              cloud_agent_session_runs.cloud_agent_session_id,
              cloud_agent_sessions.cloud_agent_session_id
            )
          )
          .where(where),
        db
          .select({
            cloudAgentSessionId: cloud_agent_sessions.cloud_agent_session_id,
            kiloSessionId: cloud_agent_sessions.kilo_session_id,
            occurredAt: latestOccurredAt,
            matchingEvents: sql<number>`COUNT(*)`,
          })
          .from(cloud_agent_session_runs)
          .innerJoin(
            cloud_agent_sessions,
            eq(
              cloud_agent_session_runs.cloud_agent_session_id,
              cloud_agent_sessions.cloud_agent_session_id
            )
          )
          .where(where)
          .groupBy(
            cloud_agent_sessions.cloud_agent_session_id,
            cloud_agent_sessions.kilo_session_id
          )
          .orderBy(desc(latestOccurredAt), desc(cloud_agent_sessions.cloud_agent_session_id))
          .limit(HEALTH_ERROR_SESSION_LIMIT),
      ]);
      return {
        totalSessions: count(totals[0]?.total),
        limit: HEALTH_ERROR_SESSION_LIMIT,
        rows: rows.map(row => ({
          cloudAgentSessionId: row.cloudAgentSessionId,
          kiloSessionId: row.kiloSessionId,
          occurredAt: nullableIso(row.occurredAt),
          matchingEvents: count(row.matchingEvents),
        })),
      };
    }),
});
