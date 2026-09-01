import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import { cloud_agent_session_runs, cloud_agent_sessions } from '@kilocode/db/schema';
import { and, desc, eq, gte, isNotNull, lt, sql, type SQL } from 'drizzle-orm';
import * as z from 'zod';
import {
  CloudAgentFailureReasonSchema,
  CloudAgentFailureResponsibilitySchema,
  type CloudAgentFailureResponsibility,
} from '@kilocode/worker-utils/cloud-agent-failure';

const MAX_INTERVAL_MS = 90 * 24 * 60 * 60 * 1000;
const HEALTH_ERROR_SESSION_LIMIT = 100;
const healthErrorSourceSchema = z.enum(['setup', 'run']);
const healthResponsibilityFilterSchema = z.enum(['all', 'platform', 'user', 'unknown']);
const intervalShape = { startDate: z.string().datetime(), endDate: z.string().datetime() };

function hasAscendingInterval(input: { startDate: string; endDate: string }) {
  return new Date(input.startDate).getTime() < new Date(input.endDate).getTime();
}

function hasBoundedInterval(input: { startDate: string; endDate: string }) {
  return new Date(input.endDate).getTime() - new Date(input.startDate).getTime() <= MAX_INTERVAL_MS;
}

const HealthOverviewFilterSchema = z
  .object({ ...intervalShape, responsibility: healthResponsibilityFilterSchema.default('all') })
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
    responsibility: CloudAgentFailureResponsibilitySchema,
    reason: CloudAgentFailureReasonSchema,
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

type HealthError = {
  source: 'setup' | 'run';
  stage: string;
  code: string;
  responsibility: CloudAgentFailureResponsibility;
  reason: z.infer<typeof CloudAgentFailureReasonSchema>;
  count: number;
  affectedSessions: number;
  knownSandboxes: number;
  sessionsWithoutSandbox: number;
};

function failureRate(failures: number, completed: number): number | null {
  const denominator = failures + completed;
  return denominator === 0 ? null : failures / denominator;
}

export const adminCloudAgentNextRouter = createTRPCRouter({
  getHealthOverview: adminProcedure.input(HealthOverviewFilterSchema).query(async ({ input }) => {
    const sessionStage = sql<string>`COALESCE(${cloud_agent_sessions.failure_stage}, 'unclassified')`;
    const sessionCode = sql<string>`COALESCE(${cloud_agent_sessions.failure_code}, 'unclassified')`;
    const runStage = sql<string>`COALESCE(${cloud_agent_session_runs.failure_stage}, 'unknown')`;
    const runCode = sql<string>`COALESCE(${cloud_agent_session_runs.failure_code}, 'unclassified')`;
    const sessionResponsibility = sql<CloudAgentFailureResponsibility>`COALESCE(${cloud_agent_sessions.failure_responsibility}, 'unknown')`;
    const sessionReason = sql<
      z.infer<typeof CloudAgentFailureReasonSchema>
    >`COALESCE(${cloud_agent_sessions.failure_reason}, 'unclassified')`;
    const runResponsibility = sql<CloudAgentFailureResponsibility>`COALESCE(${cloud_agent_session_runs.failure_responsibility}, 'unknown')`;
    const runReason = sql<
      z.infer<typeof CloudAgentFailureReasonSchema>
    >`COALESCE(${cloud_agent_session_runs.failure_reason}, 'unclassified')`;
    const selectedRunResponsibility =
      input.responsibility === 'all'
        ? undefined
        : sql`${runResponsibility} = ${input.responsibility}`;
    const [summaryRows, setupRows, runErrorRows] = await Promise.all([
      db
        .select({
          completed: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_session_runs.status} = 'completed')`,
          failed: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_session_runs.status} = 'failed')`,
          interrupted: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_session_runs.status} = 'interrupted')`,
          platformFailures: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_session_runs.status} = 'failed' AND ${runResponsibility} = 'platform')`,
          userFailures: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_session_runs.status} = 'failed' AND ${runResponsibility} = 'user')`,
          unknownFailures: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_session_runs.status} = 'failed' AND ${runResponsibility} = 'unknown')`,
        })
        .from(cloud_agent_session_runs)
        .innerJoin(
          cloud_agent_sessions,
          eq(
            cloud_agent_session_runs.cloud_agent_session_id,
            cloud_agent_sessions.cloud_agent_session_id
          )
        )
        .where(and(...terminalRunIntervalConditions(input))),
      db
        .select({
          stage: sessionStage,
          code: sessionCode,
          responsibility: sessionResponsibility,
          reason: sessionReason,
          count: sql<number>`COUNT(*)`,
          knownSandboxes: sql<number>`COUNT(DISTINCT ${cloud_agent_sessions.sandbox_id})`,
          sessionsWithoutSandbox: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_sessions.sandbox_id} IS NULL)`,
        })
        .from(cloud_agent_sessions)
        .where(
          and(
            isNotNull(cloud_agent_sessions.failure_at),
            gte(cloud_agent_sessions.failure_at, input.startDate),
            lt(cloud_agent_sessions.failure_at, input.endDate),
            retainedSessionCondition()
          )
        )
        .groupBy(sessionStage, sessionCode, sessionResponsibility, sessionReason)
        .orderBy(sessionStage, sessionCode, sessionResponsibility, sessionReason),
      db
        .select({
          stage: runStage,
          code: runCode,
          responsibility: runResponsibility,
          reason: runReason,
          count: sql<number>`COUNT(*)`,
          affectedSessions: sql<number>`COUNT(DISTINCT ${cloud_agent_session_runs.cloud_agent_session_id})`,
          knownSandboxes: sql<number>`COUNT(DISTINCT ${cloud_agent_sessions.sandbox_id})`,
          sessionsWithoutSandbox: sql<number>`COUNT(DISTINCT ${cloud_agent_session_runs.cloud_agent_session_id}) FILTER (WHERE ${cloud_agent_sessions.sandbox_id} IS NULL)`,
        })
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
            selectedRunResponsibility,
            ...terminalRunIntervalConditions(input)
          )
        )
        .groupBy(runStage, runCode, runResponsibility, runReason),
    ]);
    const row = summaryRows[0];
    const summary = {
      completedRuns: count(row?.completed),
      failedRuns: count(row?.failed),
      interruptedRuns: count(row?.interrupted),
      setupFailures: 0,
      platformFailures: count(row?.platformFailures),
      userFailures: count(row?.userFailures),
      unknownFailures: count(row?.unknownFailures),
      platformFailureRate: null as number | null,
      allFailureRate: null as number | null,
    };
    const setupErrors: HealthError[] = [];
    for (const setupRow of setupRows) {
      const occurrences = count(setupRow.count);
      summary.setupFailures += occurrences;
      if (setupRow.responsibility === 'platform') summary.platformFailures += occurrences;
      else if (setupRow.responsibility === 'user') summary.userFailures += occurrences;
      else summary.unknownFailures += occurrences;
      if (input.responsibility !== 'all' && setupRow.responsibility !== input.responsibility) {
        continue;
      }
      setupErrors.push({
        source: 'setup',
        stage: setupRow.stage,
        code: setupRow.code,
        responsibility: setupRow.responsibility,
        reason: setupRow.reason,
        count: occurrences,
        affectedSessions: occurrences,
        knownSandboxes: count(setupRow.knownSandboxes),
        sessionsWithoutSandbox: count(setupRow.sessionsWithoutSandbox),
      });
    }
    const errors = [
      ...setupErrors,
      ...runErrorRows.map(
        runRow =>
          ({
            source: 'run',
            stage: runRow.stage,
            code: runRow.code,
            responsibility: runRow.responsibility,
            reason: runRow.reason,
            count: count(runRow.count),
            affectedSessions: count(runRow.affectedSessions),
            knownSandboxes: count(runRow.knownSandboxes),
            sessionsWithoutSandbox: count(runRow.sessionsWithoutSandbox),
          }) satisfies HealthError
      ),
    ].sort(
      (left, right) =>
        right.count - left.count ||
        left.source.localeCompare(right.source) ||
        left.stage.localeCompare(right.stage) ||
        left.code.localeCompare(right.code) ||
        left.reason.localeCompare(right.reason)
    );
    const topErrors = errors.slice(0, 10);
    const errorTotals = {
      groups: errors.length,
      events: errors.reduce((total, error) => total + error.count, 0),
    };
    summary.platformFailureRate = failureRate(summary.platformFailures, summary.completedRuns);
    summary.allFailureRate = failureRate(
      summary.failedRuns + summary.setupFailures,
      summary.completedRuns
    );
    return { summary, topErrors, errorTotals };
  }),

  listHealthErrorSessions: adminProcedure
    .input(HealthErrorSessionsFilterSchema)
    .query(async ({ input }) => {
      if (input.source === 'setup') {
        const where = and(
          sql`COALESCE(${cloud_agent_sessions.failure_stage}, 'unclassified') = ${input.stage}`,
          sql`COALESCE(${cloud_agent_sessions.failure_code}, 'unclassified') = ${input.code}`,
          sql`COALESCE(${cloud_agent_sessions.failure_responsibility}, 'unknown') = ${input.responsibility}`,
          sql`COALESCE(${cloud_agent_sessions.failure_reason}, 'unclassified') = ${input.reason}`,
          isNotNull(cloud_agent_sessions.failure_at),
          gte(cloud_agent_sessions.failure_at, input.startDate),
          lt(cloud_agent_sessions.failure_at, input.endDate),
          retainedSessionCondition()
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
              sandboxId: cloud_agent_sessions.sandbox_id,
              messageId: cloud_agent_sessions.initial_message_id,
              diagnostic: sql<
                string | null
              >`CASE WHEN ${cloud_agent_sessions.error_expires_at} > now() THEN ${cloud_agent_sessions.error_message_redacted} ELSE NULL END`,
              diagnosticExpiresAt: cloud_agent_sessions.error_expires_at,
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
            sandboxId: row.sandboxId,
            messageId: row.messageId,
            wrapperRunId: null,
            diagnostic: row.diagnostic,
            diagnosticExpiresAt: nullableIso(row.diagnosticExpiresAt),
            occurredAt: nullableIso(row.occurredAt),
            lastSeen: nullableIso(row.occurredAt),
            matchingEvents: 1,
          })),
        };
      }

      const where = and(
        eq(cloud_agent_session_runs.status, 'failed'),
        sql`COALESCE(${cloud_agent_session_runs.failure_stage}, 'unknown') = ${input.stage}`,
        sql`COALESCE(${cloud_agent_session_runs.failure_code}, 'unclassified') = ${input.code}`,
        sql`COALESCE(${cloud_agent_session_runs.failure_responsibility}, 'unknown') = ${input.responsibility}`,
        sql`COALESCE(${cloud_agent_session_runs.failure_reason}, 'unclassified') = ${input.reason}`,
        ...terminalRunIntervalConditions(input)
      );
      const latestMatchingRuns = db
        .selectDistinctOn([cloud_agent_session_runs.cloud_agent_session_id], {
          cloudAgentSessionId: cloud_agent_session_runs.cloud_agent_session_id,
          kiloSessionId: cloud_agent_sessions.kilo_session_id,
          sandboxId: cloud_agent_sessions.sandbox_id,
          messageId: cloud_agent_session_runs.message_id,
          wrapperRunId: cloud_agent_session_runs.wrapper_run_id,
          diagnostic: sql<
            string | null
          >`CASE WHEN ${cloud_agent_session_runs.error_expires_at} > now() THEN ${cloud_agent_session_runs.error_message_redacted} ELSE NULL END`.as(
            'diagnostic'
          ),
          diagnosticExpiresAt: cloud_agent_session_runs.error_expires_at,
          occurredAt: cloud_agent_session_runs.terminal_at,
          matchingEvents:
            sql<number>`COUNT(*) OVER (PARTITION BY ${cloud_agent_session_runs.cloud_agent_session_id})`.as(
              'matching_events'
            ),
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
        .orderBy(
          cloud_agent_session_runs.cloud_agent_session_id,
          desc(cloud_agent_session_runs.terminal_at),
          desc(cloud_agent_session_runs.message_id)
        )
        .as('latest_matching_runs');
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
          .select()
          .from(latestMatchingRuns)
          .orderBy(
            desc(latestMatchingRuns.occurredAt),
            desc(latestMatchingRuns.cloudAgentSessionId)
          )
          .limit(HEALTH_ERROR_SESSION_LIMIT),
      ]);
      return {
        totalSessions: count(totals[0]?.total),
        limit: HEALTH_ERROR_SESSION_LIMIT,
        rows: rows.map(row => ({
          cloudAgentSessionId: row.cloudAgentSessionId,
          kiloSessionId: row.kiloSessionId,
          sandboxId: row.sandboxId,
          messageId: row.messageId,
          wrapperRunId: row.wrapperRunId,
          diagnostic: row.diagnostic,
          diagnosticExpiresAt: nullableIso(row.diagnosticExpiresAt),
          occurredAt: nullableIso(row.occurredAt),
          lastSeen: nullableIso(row.occurredAt),
          matchingEvents: count(row.matchingEvents),
        })),
      };
    }),
});
