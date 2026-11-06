import 'server-only';
import { baseProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import {
  cloud_agent_session_runs,
  cloud_agent_sessions,
  cli_sessions_v2,
  type CloudAgentSessionRunStatus,
} from '@kilocode/db/schema';
import {
  CLOUD_AGENT_FAILURE_CODES,
  CLOUD_AGENT_SESSION_FAILURE_CODES,
  userVisibleFailureMessage,
  userVisibleSessionFailureMessage,
  type CloudAgentFailureCode,
  type CloudAgentSessionFailureCode,
} from '@kilocode/worker-utils/cloud-agent-failure';
import { queryAccessibleCloudAgentSession } from '@kilocode/worker-utils/cloud-agent-session-access';

const RUN_HISTORY_LIMIT = 50;
const RUN_EXPORT_LIMIT = 500;
const RUN_RETENTION_DAYS = 90;
const DIAGNOSTIC_RETENTION_DAYS = 30;

const CLOUD_AGENT_SESSION_RUN_STATUSES = [
  'queued',
  'accepted',
  'completed',
  'failed',
  'interrupted',
] as const satisfies readonly CloudAgentSessionRunStatus[];

const cloudAgentRunStatusSchema = z.enum(CLOUD_AGENT_SESSION_RUN_STATUSES);

const isoTimestampSchema = z.string().datetime();
const nullableIsoTimestampSchema = isoTimestampSchema.nullable();

const failureRunSchema = z.object({
  messageId: z.string(),
  status: cloudAgentRunStatusSchema,
  queuedAt: nullableIsoTimestampSchema,
  dispatchAcceptedAt: nullableIsoTimestampSchema,
  agentActivityObservedAt: nullableIsoTimestampSchema,
  terminalAt: nullableIsoTimestampSchema,
  failureStage: z.string().nullable(),
  failureCode: z.string().nullable(),
  failureResponsibility: z.string().nullable(),
  failureReason: z.string().nullable(),
  userVisibleError: z.string().nullable(),
  diagnostic: z.string().nullable(),
  diagnosticExpiresAt: nullableIsoTimestampSchema,
  diagnosticStatus: z.enum(['present', 'expired', 'missing']),
  wrapperRunId: z.string().nullable(),
});

const setupFailureSchema = z.object({
  occurredAt: isoTimestampSchema,
  stage: z.string().nullable(),
  code: z.string().nullable(),
  responsibility: z.string().nullable(),
  reason: z.string().nullable(),
  userVisibleError: z.string().nullable(),
  diagnostic: z.string().nullable(),
  diagnosticExpiresAt: nullableIsoTimestampSchema,
  diagnosticStatus: z.enum(['present', 'expired', 'missing']),
});

const failureSessionSchema = z.object({
  cloudAgentSessionId: z.string(),
  kiloSessionId: z.string(),
  createdAt: isoTimestampSchema.nullable(),
  organizationId: z.string().uuid().nullable(),
  sandboxId: z.string().nullable(),
  title: z.string().nullable(),
  gitUrl: z.string().nullable(),
});

const failureHistoryOutputSchema = z.object({
  session: failureSessionSchema,
  setupFailure: setupFailureSchema.nullable(),
  runs: z.array(failureRunSchema),
  retention: z.object({
    runWindowDays: z.number().int(),
    diagnosticDays: z.number().int(),
    historyRunLimit: z.number().int(),
  }),
});

const failureHistoryInputSchema = z.object({
  cloudAgentSessionId: z.string().trim().min(1).max(128),
});

const failureExportInputSchema = failureHistoryInputSchema.extend({
  format: z.enum(['json', 'csv']).default('json'),
});

const failureExportOutputSchema = z.object({
  fileName: z.string(),
  contentType: z.enum(['application/json', 'text/csv']),
  content: z.string(),
});

type FailureRun = z.infer<typeof failureRunSchema>;
type SetupFailure = z.infer<typeof setupFailureSchema>;
type FailureSession = z.infer<typeof failureSessionSchema>;

function isoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function isExpired(expiresAt: string | null): boolean {
  if (expiresAt === null) return false;
  const time = new Date(expiresAt).getTime();
  return !Number.isFinite(time) || time <= Date.now();
}

type DiagnosticStatus = 'present' | 'expired' | 'missing';

function retainedDiagnostic(
  message: string | null,
  expiresAt: string | null
): {
  diagnostic: string | null;
  diagnosticExpiresAt: string | null;
  diagnosticStatus: DiagnosticStatus;
} {
  if (!message) {
    return { diagnostic: null, diagnosticExpiresAt: null, diagnosticStatus: 'missing' };
  }
  if (!expiresAt || isExpired(expiresAt)) {
    return { diagnostic: null, diagnosticExpiresAt: null, diagnosticStatus: 'expired' };
  }
  return {
    diagnostic: message,
    diagnosticExpiresAt: isoOrNull(expiresAt),
    diagnosticStatus: 'present',
  };
}

function runUserVisibleError(code: string | null): string | null {
  if (!code) return null;
  if ((CLOUD_AGENT_FAILURE_CODES as readonly string[]).includes(code)) {
    return userVisibleFailureMessage(code as CloudAgentFailureCode);
  }
  return 'The message failed';
}

function setupUserVisibleError(code: string | null): string {
  if (code && (CLOUD_AGENT_SESSION_FAILURE_CODES as readonly string[]).includes(code)) {
    return userVisibleSessionFailureMessage(code as CloudAgentSessionFailureCode);
  }
  return 'Environment preparation failed';
}

function secondsBetween(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const seconds = (new Date(end).getTime() - new Date(start).getTime()) / 1000;
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 10) / 10 : null;
}

type SessionFailureDetail = {
  session: FailureSession;
  setupFailure: SetupFailure | null;
  runs: FailureRun[];
};

async function loadSessionFailureDetail(
  userId: string,
  cloudAgentSessionId: string,
  runLimit: number
): Promise<SessionFailureDetail> {
  const accessible = await queryAccessibleCloudAgentSession(db, {
    kiloUserId: userId,
    cloudAgentSessionId,
  });
  if (!accessible) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Session not found or access denied',
    });
  }

  const [cliRow] = await db
    .select({
      createdAt: cli_sessions_v2.created_at,
      organizationId: cli_sessions_v2.organization_id,
      title: cli_sessions_v2.title,
      gitUrl: cli_sessions_v2.git_url,
    })
    .from(cli_sessions_v2)
    .where(
      and(
        eq(cli_sessions_v2.session_id, accessible.kiloSessionId),
        eq(cli_sessions_v2.kilo_user_id, userId),
        eq(cli_sessions_v2.cloud_agent_session_id, cloudAgentSessionId)
      )
    )
    .limit(1);

  if (!cliRow) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Session not found or access denied',
    });
  }

  const sessionRow = (
    await db
      .select({
        sandboxId: cloud_agent_sessions.sandbox_id,
        createdAt: cloud_agent_sessions.created_at,
        failureAt: cloud_agent_sessions.failure_at,
        failureStage: cloud_agent_sessions.failure_stage,
        failureCode: cloud_agent_sessions.failure_code,
        failureResponsibility: cloud_agent_sessions.failure_responsibility,
        failureReason: cloud_agent_sessions.failure_reason,
        errorMessageRedacted: cloud_agent_sessions.error_message_redacted,
        errorExpiresAt: cloud_agent_sessions.error_expires_at,
      })
      .from(cloud_agent_sessions)
      .where(eq(cloud_agent_sessions.cloud_agent_session_id, cloudAgentSessionId))
      .limit(1)
  )[0];

  const runRows = await db
    .select({
      messageId: cloud_agent_session_runs.message_id,
      status: cloud_agent_session_runs.status,
      queuedAt: cloud_agent_session_runs.queued_at,
      dispatchAcceptedAt: cloud_agent_session_runs.dispatch_accepted_at,
      agentActivityObservedAt: cloud_agent_session_runs.agent_activity_observed_at,
      terminalAt: cloud_agent_session_runs.terminal_at,
      failureStage: cloud_agent_session_runs.failure_stage,
      failureCode: cloud_agent_session_runs.failure_code,
      failureResponsibility: cloud_agent_session_runs.failure_responsibility,
      failureReason: cloud_agent_session_runs.failure_reason,
      errorMessageRedacted: cloud_agent_session_runs.error_message_redacted,
      errorExpiresAt: cloud_agent_session_runs.error_expires_at,
      wrapperRunId: cloud_agent_session_runs.wrapper_run_id,
    })
    .from(cloud_agent_session_runs)
    .where(
      and(
        eq(cloud_agent_session_runs.cloud_agent_session_id, cloudAgentSessionId),
        sql`coalesce(${cloud_agent_session_runs.queued_at}, ${cloud_agent_session_runs.terminal_at}) >= now() - make_interval(days => ${RUN_RETENTION_DAYS})`
      )
    )
    .orderBy(
      sql`${cloud_agent_session_runs.queued_at} desc nulls last`,
      sql`${cloud_agent_session_runs.terminal_at} desc nulls last`
    )
    .limit(runLimit);

  const failureAt = isoOrNull(sessionRow?.failureAt);
  const hasSetupFailureEvidence =
    sessionRow !== undefined &&
    (sessionRow.failureAt !== null ||
      sessionRow.failureStage !== null ||
      sessionRow.failureCode !== null ||
      sessionRow.failureResponsibility !== null ||
      sessionRow.failureReason !== null ||
      sessionRow.errorMessageRedacted !== null);
  const setupFailure: SetupFailure | null =
    sessionRow && hasSetupFailureEvidence
      ? {
          occurredAt:
            failureAt ??
            isoOrNull(sessionRow.createdAt) ??
            isoOrNull(cliRow.createdAt) ??
            new Date(0).toISOString(),
          stage: sessionRow.failureStage ?? null,
          code: sessionRow.failureCode ?? null,
          responsibility: sessionRow.failureResponsibility ?? null,
          reason: sessionRow.failureReason ?? null,
          userVisibleError: setupUserVisibleError(sessionRow.failureCode ?? null),
          ...retainedDiagnostic(sessionRow.errorMessageRedacted, sessionRow.errorExpiresAt),
        }
      : null;

  return {
    session: {
      cloudAgentSessionId,
      kiloSessionId: accessible.kiloSessionId,
      createdAt: isoOrNull(sessionRow?.createdAt ?? cliRow.createdAt),
      organizationId: cliRow.organizationId ?? null,
      sandboxId: sessionRow?.sandboxId ?? null,
      title: cliRow.title ?? null,
      gitUrl: cliRow.gitUrl ?? null,
    },
    setupFailure,
    runs: runRows.map(run => ({
      messageId: run.messageId,
      status: run.status,
      queuedAt: isoOrNull(run.queuedAt),
      dispatchAcceptedAt: isoOrNull(run.dispatchAcceptedAt),
      agentActivityObservedAt: isoOrNull(run.agentActivityObservedAt),
      terminalAt: isoOrNull(run.terminalAt),
      failureStage: run.failureStage ?? null,
      failureCode: run.failureCode ?? null,
      failureResponsibility: run.failureResponsibility ?? null,
      failureReason: run.failureReason ?? null,
      userVisibleError: runUserVisibleError(run.failureCode ?? null),
      ...retainedDiagnostic(run.errorMessageRedacted, run.errorExpiresAt),
      wrapperRunId: run.wrapperRunId ?? null,
    })),
  };
}

const CSV_HEADERS = [
  'source',
  'occurred_at',
  'status',
  'stage',
  'code',
  'responsibility',
  'reason',
  'user_visible_error',
  'diagnostic',
  'diagnostic_status',
  'message_id',
  'wrapper_run_id',
  'queued_at',
  'dispatch_accepted_at',
  'agent_activity_observed_at',
  'terminal_at',
  'seconds_to_failure',
  'cloud_agent_session_id',
  'kilo_session_id',
  'session_title',
  'git_url',
] as const;

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  const guarded = /^[\uFEFF\s]*[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  if (/[",\n\r]/.test(guarded)) {
    return `"${guarded.replaceAll('"', '""')}"`;
  }
  return guarded;
}

function buildCsv(detail: SessionFailureDetail): string {
  const session = detail.session;
  const lines: Array<Array<string | number | null>> = [];
  if (detail.setupFailure) {
    lines.push([
      'setup',
      detail.setupFailure.occurredAt,
      'failed',
      detail.setupFailure.stage,
      detail.setupFailure.code,
      detail.setupFailure.responsibility,
      detail.setupFailure.reason,
      detail.setupFailure.userVisibleError,
      detail.setupFailure.diagnostic,
      detail.setupFailure.diagnosticStatus,
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      session.cloudAgentSessionId,
      session.kiloSessionId,
      session.title,
      session.gitUrl,
    ]);
  }
  for (const run of detail.runs) {
    lines.push([
      'run',
      run.terminalAt,
      run.status,
      run.failureStage,
      run.failureCode,
      run.failureResponsibility,
      run.failureReason,
      run.userVisibleError,
      run.diagnostic,
      run.diagnosticStatus,
      run.messageId,
      run.wrapperRunId,
      run.queuedAt,
      run.dispatchAcceptedAt,
      run.agentActivityObservedAt,
      run.terminalAt,
      secondsBetween(run.queuedAt, run.terminalAt),
      session.cloudAgentSessionId,
      session.kiloSessionId,
      session.title,
      session.gitUrl,
    ]);
  }
  return [CSV_HEADERS.join(','), ...lines.map(line => line.map(csvEscape).join(','))].join('\n');
}

function buildJson(detail: SessionFailureDetail): string {
  return `${JSON.stringify(
    {
      source: 'kilo-cloud-session-diagnostics',
      generatedAt: new Date().toISOString(),
      session: detail.session,
      setupFailure: detail.setupFailure,
      runs: detail.runs,
      retention: { runWindowDays: RUN_RETENTION_DAYS, diagnosticDays: DIAGNOSTIC_RETENTION_DAYS },
    },
    null,
    2
  )}\n`;
}

export const cloudAgentNextFailuresRouter = createTRPCRouter({
  getSessionFailureHistory: baseProcedure
    .input(failureHistoryInputSchema)
    .output(failureHistoryOutputSchema)
    .query(async ({ ctx, input }) => {
      const detail = await loadSessionFailureDetail(
        ctx.user.id,
        input.cloudAgentSessionId,
        RUN_HISTORY_LIMIT
      );
      return {
        ...detail,
        retention: {
          runWindowDays: RUN_RETENTION_DAYS,
          diagnosticDays: DIAGNOSTIC_RETENTION_DAYS,
          historyRunLimit: RUN_HISTORY_LIMIT,
        },
      };
    }),

  exportSessionDiagnostics: baseProcedure
    .input(failureExportInputSchema)
    .output(failureExportOutputSchema)
    .query(async ({ ctx, input }) => {
      const detail = await loadSessionFailureDetail(
        ctx.user.id,
        input.cloudAgentSessionId,
        RUN_EXPORT_LIMIT
      );
      if (input.format === 'csv') {
        return {
          fileName: `kilo-session-diagnostics-${detail.session.kiloSessionId}.csv`,
          contentType: 'text/csv' as const,
          content: buildCsv(detail),
        };
      }
      return {
        fileName: `kilo-session-diagnostics-${detail.session.kiloSessionId}.json`,
        contentType: 'application/json' as const,
        content: buildJson(detail),
      };
    }),
});
