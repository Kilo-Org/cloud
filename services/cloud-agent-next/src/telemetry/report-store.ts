import { and, eq, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { WorkerDb } from '@kilocode/db/client';
import type {
  CloudAgentQueueReport,
  CloudAgentRunStateReport,
} from '@kilocode/worker-utils/cloud-agent-queue-report';
import { cloud_agent_session_runs, cloud_agent_sessions } from '@kilocode/db/schema';

export const CLOUD_AGENT_REPORT_RETENTION_DAYS = 90;
const CLOUD_AGENT_ERROR_RETENTION_DAYS = 30;

const isoTimestampSchema = z.string().datetime({ offset: true });
const cloudAgentSessionIdSchema = z
  .string()
  .regex(/^agent_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const kiloSessionIdSchema = z.string().startsWith('ses_').length(30);
const diagnosticSchema = z.object({
  errorMessageRedacted: z.string().min(1).max(4096),
  errorExpiresAt: isoTimestampSchema,
});

const sessionFailureSchema = z.discriminatedUnion('stage', [
  z.object({
    stage: z.literal('sandbox_identity'),
    code: z.literal('sandbox_id_derivation_failed'),
  }),
  z.object({ stage: z.literal('registration'), code: z.literal('do_registration_rejected') }),
  z.object({
    stage: z.literal('initial_admission'),
    code: z.enum(['initial_admission_rejected', 'initial_queue_full', 'invalid_initial_intent']),
  }),
  z.object({ stage: z.literal('transport'), code: z.literal('do_rpc_outcome_unknown') }),
]);

const createSessionReportSchema = z.object({
  cloudAgentSessionId: cloudAgentSessionIdSchema,
  kiloSessionId: kiloSessionIdSchema,
  initialMessageId: z.string().min(1),
  occurredAt: isoTimestampSchema,
});
const recordSandboxIdentitySchema = z.object({
  cloudAgentSessionId: cloudAgentSessionIdSchema,
  sandboxId: z.string().min(1).max(63),
});
const recordSessionFailureSchema = z
  .object({
    cloudAgentSessionId: cloudAgentSessionIdSchema,
    occurredAt: isoTimestampSchema,
    failure: sessionFailureSchema,
    diagnostic: diagnosticSchema.optional(),
  })
  .superRefine((input, ctx) => {
    if (!input.diagnostic) return;
    const occurredAt = Date.parse(input.occurredAt);
    const expiresAt = Date.parse(input.diagnostic.errorExpiresAt);
    if (
      expiresAt <= occurredAt ||
      expiresAt - occurredAt > CLOUD_AGENT_ERROR_RETENTION_DAYS * 24 * 60 * 60 * 1000
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Diagnostic expiry must be after failure time and within 30 days',
        path: ['diagnostic', 'errorExpiresAt'],
      });
    }
  });

type DatabaseTransaction = Parameters<Parameters<WorkerDb['transaction']>[0]>[0];
type MutationResult = { applied?: boolean };
type SaveReportResult = { outcome: 'applied' | 'expired' | 'missing_parent' };
type StoredRunRow = {
  status: 'queued' | 'accepted' | 'completed' | 'failed' | 'interrupted';
  wrapperRunId: string | null;
  queuedAt: string | null;
  dispatchAcceptedAt: string | null;
  agentActivityObservedAt: string | null;
  terminalAt: string | null;
  failureStage: string | null;
  failureCode: string | null;
};

function retentionCutoff(now: string): string {
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - CLOUD_AGENT_REPORT_RETENTION_DAYS);
  return cutoff.toISOString();
}

async function lockReportingSession(
  tx: DatabaseTransaction,
  cloudAgentSessionId: string
): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${cloudAgentSessionId}, 0))`);
}

async function withReportingSessionLock(
  db: WorkerDb,
  cloudAgentSessionId: string,
  operation: (tx: DatabaseTransaction) => Promise<void>
): Promise<MutationResult> {
  return db.transaction(async tx => {
    await lockReportingSession(tx, cloudAgentSessionId);
    await operation(tx);
    return {};
  });
}

function earliestTimestamp(current: string | null, incoming: string | undefined): string | null {
  if (incoming === undefined) return current;
  if (current === null) return incoming;
  return Date.parse(current) <= Date.parse(incoming) ? current : incoming;
}

function isTerminalStatus(status: StoredRunRow['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'interrupted';
}

function validDiagnostic(
  diagnostic: { errorMessageRedacted: string; errorExpiresAt: string } | undefined,
  now: string
): { error_message_redacted: string; error_expires_at: string } | undefined {
  if (!diagnostic || Date.parse(diagnostic.errorExpiresAt) <= Date.parse(now)) return undefined;
  return {
    error_message_redacted: diagnostic.errorMessageRedacted,
    error_expires_at: diagnostic.errorExpiresAt,
  };
}

export function createCloudAgentReportStore(db: WorkerDb) {
  async function saveRunReport(
    tx: DatabaseTransaction,
    report: CloudAgentRunStateReport,
    now: string
  ): Promise<SaveReportResult> {
    const cloudAgentSessionId = report.session.cloudAgentSessionId;
    const parentRows = await tx
      .select({ createdAt: cloud_agent_sessions.created_at })
      .from(cloud_agent_sessions)
      .where(eq(cloud_agent_sessions.cloud_agent_session_id, cloudAgentSessionId))
      .limit(1);
    const parent = parentRows[0];
    if (!parent) return { outcome: 'missing_parent' };
    if (Date.parse(parent.createdAt) <= Date.parse(retentionCutoff(now))) {
      return { outcome: 'expired' };
    }

    const rows = await tx
      .select({
        status: cloud_agent_session_runs.status,
        wrapperRunId: cloud_agent_session_runs.wrapper_run_id,
        queuedAt: cloud_agent_session_runs.queued_at,
        dispatchAcceptedAt: cloud_agent_session_runs.dispatch_accepted_at,
        agentActivityObservedAt: cloud_agent_session_runs.agent_activity_observed_at,
        terminalAt: cloud_agent_session_runs.terminal_at,
        failureStage: cloud_agent_session_runs.failure_stage,
        failureCode: cloud_agent_session_runs.failure_code,
      })
      .from(cloud_agent_session_runs)
      .where(
        and(
          eq(cloud_agent_session_runs.cloud_agent_session_id, cloudAgentSessionId),
          eq(cloud_agent_session_runs.message_id, report.run.messageId)
        )
      )
      .limit(1);
    const existing = rows[0];
    const incoming = report.run;
    const diagnostic = validDiagnostic(incoming.diagnostic, now);

    if (!existing) {
      await tx.insert(cloud_agent_session_runs).values({
        cloud_agent_session_id: cloudAgentSessionId,
        message_id: incoming.messageId,
        wrapper_run_id: incoming.wrapperRunId ?? null,
        status: incoming.status,
        queued_at: incoming.queuedAt ?? null,
        dispatch_accepted_at: incoming.dispatchAcceptedAt ?? null,
        agent_activity_observed_at: incoming.agentActivityObservedAt ?? null,
        terminal_at: incoming.terminalAt ?? null,
        failure_stage: incoming.failureStage ?? null,
        failure_code: incoming.failureCode ?? null,
        ...(diagnostic ?? {}),
      });
      return { outcome: 'applied' };
    }

    const establishedTerminal = isTerminalStatus(existing.status);
    const incomingTerminal = isTerminalStatus(incoming.status);
    if (establishedTerminal && incomingTerminal && existing.status !== incoming.status) {
      console.error('Conflicting Cloud Agent terminal report ignored', {
        establishedStatus: existing.status,
        incomingStatus: incoming.status,
      });
    }
    const incomingSameTerminal =
      establishedTerminal && incomingTerminal && existing.status === incoming.status;
    if (
      incomingSameTerminal &&
      existing.failureCode !== null &&
      incoming.failureCode !== undefined &&
      existing.failureCode !== incoming.failureCode
    ) {
      console.error('Conflicting Cloud Agent failure classification ignored', {
        establishedStatus: existing.status,
      });
    }
    if (
      existing.wrapperRunId !== null &&
      incoming.wrapperRunId !== undefined &&
      existing.wrapperRunId !== incoming.wrapperRunId
    ) {
      console.error('Conflicting Cloud Agent wrapper run identity ignored');
    }
    const mayApplyTerminalFacts = !establishedTerminal && incomingTerminal;
    const mayFillTerminalFacts = mayApplyTerminalFacts || incomingSameTerminal;
    const status = establishedTerminal
      ? existing.status
      : incomingTerminal || incoming.status === 'accepted'
        ? incoming.status
        : existing.status;
    await tx
      .update(cloud_agent_session_runs)
      .set({
        status,
        wrapper_run_id: existing.wrapperRunId ?? incoming.wrapperRunId ?? null,
        queued_at: earliestTimestamp(existing.queuedAt, incoming.queuedAt),
        dispatch_accepted_at: earliestTimestamp(
          existing.dispatchAcceptedAt,
          incoming.dispatchAcceptedAt
        ),
        agent_activity_observed_at: earliestTimestamp(
          existing.agentActivityObservedAt,
          incoming.agentActivityObservedAt
        ),
        terminal_at: mayApplyTerminalFacts
          ? (incoming.terminalAt ?? null)
          : incomingSameTerminal
            ? earliestTimestamp(existing.terminalAt, incoming.terminalAt)
            : existing.terminalAt,
        failure_stage:
          existing.failureStage ?? (mayFillTerminalFacts ? (incoming.failureStage ?? null) : null),
        failure_code:
          existing.failureCode ?? (mayFillTerminalFacts ? (incoming.failureCode ?? null) : null),
        ...(mayFillTerminalFacts ? (diagnostic ?? {}) : {}),
      })
      .where(
        and(
          eq(cloud_agent_session_runs.cloud_agent_session_id, cloudAgentSessionId),
          eq(cloud_agent_session_runs.message_id, incoming.messageId)
        )
      );
    return { outcome: 'applied' };
  }

  return {
    async saveReport(
      report: CloudAgentQueueReport,
      now = new Date().toISOString()
    ): Promise<SaveReportResult> {
      return db.transaction(async tx => {
        await lockReportingSession(tx, report.session.cloudAgentSessionId);
        return saveRunReport(tx, report, now);
      });
    },

    async removeExpiredData(now = new Date().toISOString()): Promise<void> {
      await db
        .update(cloud_agent_sessions)
        .set({ error_message_redacted: null, error_expires_at: null })
        .where(
          and(
            isNotNull(cloud_agent_sessions.error_expires_at),
            lte(cloud_agent_sessions.error_expires_at, now)
          )
        );
      await db
        .update(cloud_agent_session_runs)
        .set({ error_message_redacted: null, error_expires_at: null })
        .where(
          and(
            isNotNull(cloud_agent_session_runs.error_expires_at),
            lte(cloud_agent_session_runs.error_expires_at, now)
          )
        );
      await db
        .delete(cloud_agent_sessions)
        .where(lte(cloud_agent_sessions.created_at, retentionCutoff(now)));
    },

    async createSessionReport(rawInput: z.input<typeof createSessionReportSchema>): Promise<void> {
      const input = createSessionReportSchema.parse(rawInput);
      await db.transaction(async tx => {
        await lockReportingSession(tx, input.cloudAgentSessionId);
        await tx
          .insert(cloud_agent_sessions)
          .values({
            cloud_agent_session_id: input.cloudAgentSessionId,
            kilo_session_id: input.kiloSessionId,
            initial_message_id: input.initialMessageId,
            created_at: input.occurredAt,
          })
          .onConflictDoNothing({ target: cloud_agent_sessions.cloud_agent_session_id });
      });
    },

    async recordSandboxIdentity(
      rawInput: z.input<typeof recordSandboxIdentitySchema>
    ): Promise<MutationResult> {
      const input = recordSandboxIdentitySchema.parse(rawInput);
      let applied = false;
      const result = await withReportingSessionLock(db, input.cloudAgentSessionId, async tx => {
        const rows = await tx
          .update(cloud_agent_sessions)
          .set({ sandbox_id: input.sandboxId })
          .where(
            and(
              eq(cloud_agent_sessions.cloud_agent_session_id, input.cloudAgentSessionId),
              isNull(cloud_agent_sessions.sandbox_id)
            )
          )
          .returning({ cloudAgentSessionId: cloud_agent_sessions.cloud_agent_session_id });
        applied = rows.length > 0;
      });
      return { ...result, applied };
    },

    async recordSessionFailure(
      rawInput: z.input<typeof recordSessionFailureSchema>
    ): Promise<MutationResult> {
      const input = recordSessionFailureSchema.parse(rawInput);
      let applied = false;
      const result = await withReportingSessionLock(db, input.cloudAgentSessionId, async tx => {
        const rows = await tx
          .update(cloud_agent_sessions)
          .set({
            failure_at: input.occurredAt,
            failure_stage: input.failure.stage,
            failure_code: input.failure.code,
            ...(input.diagnostic
              ? {
                  error_message_redacted: input.diagnostic.errorMessageRedacted,
                  error_expires_at: input.diagnostic.errorExpiresAt,
                }
              : {}),
          })
          .where(
            and(
              eq(cloud_agent_sessions.cloud_agent_session_id, input.cloudAgentSessionId),
              isNull(cloud_agent_sessions.failure_at)
            )
          )
          .returning({ cloudAgentSessionId: cloud_agent_sessions.cloud_agent_session_id });
        applied = rows.length > 0;
      });
      return { ...result, applied };
    },
  };
}
