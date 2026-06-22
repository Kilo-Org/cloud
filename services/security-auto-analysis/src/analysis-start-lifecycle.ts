import type { WorkerDb } from '@kilocode/db/client';
import {
  security_analysis_queue,
  security_findings,
  type SecurityFinding,
} from '@kilocode/db/schema';
import {
  SecurityAuditLogAction,
  SecurityFindingAuditSourceContext,
} from '@kilocode/db/schema-types';
import {
  SECURITY_FINDING_AUDIT_SYSTEM_ACTOR,
  deriveSecurityFindingAuditEventKey,
  insertSecurityFindingAuditEvent,
  type SecurityFindingAuditOwner,
  type SecurityFindingAuditWriterDb,
} from '@kilocode/worker-utils/security-finding-audit';
import { and, eq, inArray, isNull, like, not, or, sql } from 'drizzle-orm';
import type { AutoAnalysisFailureCode, SecurityFindingAnalysis } from './types.js';

export type AnalysisStartLifecycleClaim =
  | {
      source: 'manual';
      findingId: string;
      claimToken: string;
    }
  | {
      source: 'scheduled';
      findingId: string;
      queueRowId: string;
      claimToken: string;
    };

export type AnalysisStartLifecycleOutcome =
  | {
      type: 'triage-only-completed';
      analysis: SecurityFindingAnalysis;
    }
  | {
      type: 'sandbox-running';
      cloudAgentSessionId: string;
      kiloSessionId: string;
    }
  | {
      type: 'start-failed';
      errorMessage: string;
      queueStatus: 'queued' | 'failed';
      failureCode: AutoAnalysisFailureCode;
      incrementAttempt: boolean;
      nextRetryAt: string | null;
    };

export type AnalysisCallbackLifecycleOutcome =
  | {
      type: 'completed';
      analysis: SecurityFindingAnalysis;
    }
  | {
      type: 'failed';
      errorMessage: string;
      failureCode: AutoAnalysisFailureCode;
    }
  | {
      type: 'superseded';
    }
  | {
      type: 'already-terminal';
      findingStatus: 'completed' | 'failed';
      failureCode: AutoAnalysisFailureCode | null;
      errorMessage: string | null;
    };

class AnalysisStartQueueTransitionRejected extends Error {
  constructor() {
    super('Analysis start queue transition rejected');
    this.name = 'AnalysisStartQueueTransitionRejected';
  }
}

type TerminalAnalysisAuditOutcome =
  | { type: 'completed'; analysis: SecurityFindingAnalysis }
  | { type: 'failed'; failureCode: AutoAnalysisFailureCode };

function toAnalysisAuditOwner(
  finding: Pick<SecurityFinding, 'owned_by_user_id' | 'owned_by_organization_id'>
): SecurityFindingAuditOwner {
  if (finding.owned_by_organization_id) {
    return { type: 'organization', organizationId: finding.owned_by_organization_id };
  }
  if (finding.owned_by_user_id) {
    return { type: 'user', userId: finding.owned_by_user_id };
  }
  throw new Error('Security analysis finding has no audit owner');
}

function analysisAuditOwnerKey(
  finding: Pick<SecurityFinding, 'owned_by_user_id' | 'owned_by_organization_id'>
): string {
  if (finding.owned_by_organization_id) {
    return `organization:${finding.owned_by_organization_id}`;
  }
  if (finding.owned_by_user_id) return `user:${finding.owned_by_user_id}`;
  throw new Error('Security analysis finding has no audit owner');
}

async function insertTerminalAnalysisAuditEvent(
  db: SecurityFindingAuditWriterDb,
  params: {
    previousAnalysisStatus: string | null;
    finding: SecurityFinding;
    attemptToken: string;
    outcome: TerminalAnalysisAuditOutcome;
  }
): Promise<void> {
  const { finding, outcome } = params;
  const occurredAt = finding.analysis_completed_at;
  if (!occurredAt) throw new Error('Terminal Security Finding analysis has no completion time');

  const action =
    outcome.type === 'completed'
      ? SecurityAuditLogAction.FindingAnalysisCompleted
      : SecurityAuditLogAction.FindingAnalysisFailed;
  const analysis = outcome.type === 'completed' ? outcome.analysis : null;
  const modelSlug =
    analysis?.analysisModel ??
    analysis?.modelUsed ??
    analysis?.sandboxAnalysis?.modelUsed ??
    analysis?.triageModel;
  const sandboxAnalysis = analysis?.sandboxAnalysis;
  const suggestedAction = sandboxAnalysis?.suggestedAction ?? analysis?.triage?.suggestedAction;

  await insertSecurityFindingAuditEvent(db, {
    owner: toAnalysisAuditOwner(finding),
    finding,
    actor: SECURITY_FINDING_AUDIT_SYSTEM_ACTOR,
    action,
    occurredAt,
    eventKey: deriveSecurityFindingAuditEventKey([
      analysisAuditOwnerKey(finding),
      finding.id,
      action,
      params.attemptToken,
    ]),
    sourceContext: SecurityFindingAuditSourceContext.AnalysisWorker,
    beforeState: { analysis_status: params.previousAnalysisStatus ?? 'unknown' },
    afterState:
      outcome.type === 'completed'
        ? {
            analysis_status: 'completed',
            ...(suggestedAction ? { suggested_action: suggestedAction } : {}),
            ...(!sandboxAnalysis && analysis?.triage?.confidence
              ? { confidence: analysis.triage.confidence }
              : {}),
            ...(sandboxAnalysis?.extractionStatus
              ? { structured_extraction_status: sandboxAnalysis.extractionStatus }
              : {}),
            ...(sandboxAnalysis?.isExploitable !== undefined &&
            sandboxAnalysis.extractionStatus !== 'failed'
              ? { is_exploitable: sandboxAnalysis.isExploitable }
              : {}),
          }
        : { analysis_status: 'failed' },
    metadata:
      outcome.type === 'completed'
        ? {
            ...(analysis?.correlationId ? { correlation_id: analysis.correlationId } : {}),
            ...(modelSlug ? { model_slug: modelSlug } : {}),
            ...(analysis?.triageModel ? { triage_model_slug: analysis.triageModel } : {}),
            ...(analysis?.analysisModel ? { analysis_model_slug: analysis.analysisModel } : {}),
            ...(analysis?.triage?.needsSandboxAnalysis !== undefined
              ? { needs_sandbox_analysis: analysis.triage.needsSandboxAnalysis }
              : {}),
          }
        : { failure_code: outcome.failureCode },
  });
}

export async function transitionAnalysisCallbackLifecycle(
  db: WorkerDb,
  params: {
    findingId: string;
    attemptToken: string;
    outcome: AnalysisCallbackLifecycleOutcome;
  }
): Promise<{
  status: 'completed' | 'failed' | 'superseded' | 'already-terminal' | 'stale-attempt';
}> {
  return db.transaction(async tx => {
    const activeAttemptRows = await tx.execute<{ id: string }>(sql`
      SELECT id
      FROM security_analysis_queue
      WHERE finding_id = ${params.findingId}::uuid
        AND claim_token = ${params.attemptToken}
        AND queue_status IN ('pending', 'running')
      FOR UPDATE
    `);
    const activeAttemptId = activeAttemptRows.rows[0]?.id;
    if (!activeAttemptId) {
      return { status: 'stale-attempt' };
    }

    if (params.outcome.type === 'already-terminal') {
      await tx
        .update(security_analysis_queue)
        .set({
          queue_status: params.outcome.findingStatus,
          failure_code:
            params.outcome.findingStatus === 'completed' ? null : params.outcome.failureCode,
          last_error_redacted:
            params.outcome.findingStatus === 'completed' ? null : params.outcome.errorMessage,
          updated_at: sql`now()`.mapWith(String),
        })
        .where(
          and(
            eq(security_analysis_queue.id, activeAttemptId),
            eq(security_analysis_queue.claim_token, params.attemptToken)
          )
        );
      return { status: 'already-terminal' };
    }

    if (params.outcome.type === 'superseded') {
      await tx
        .update(security_findings)
        .set({
          analysis_status: null,
          updated_at: sql`now()`.mapWith(String),
        })
        .where(eq(security_findings.id, params.findingId));
      await tx
        .update(security_analysis_queue)
        .set({
          queue_status: 'completed',
          failure_code: 'SKIPPED_NO_LONGER_ELIGIBLE',
          last_error_redacted: null,
          updated_at: sql`now()`.mapWith(String),
        })
        .where(
          and(
            eq(security_analysis_queue.id, activeAttemptId),
            eq(security_analysis_queue.claim_token, params.attemptToken)
          )
        );
      return { status: 'superseded' };
    }

    const [previousFinding] = await tx
      .select()
      .from(security_findings)
      .where(eq(security_findings.id, params.findingId))
      .for('update')
      .limit(1);

    const [updatedFinding] = await tx
      .update(security_findings)
      .set(
        params.outcome.type === 'completed'
          ? {
              analysis_status: 'completed',
              analysis: sql`${JSON.stringify(params.outcome.analysis)}::jsonb`,
              analysis_error: null,
              analysis_completed_at: sql`now()`.mapWith(String),
              updated_at: sql`now()`.mapWith(String),
            }
          : {
              analysis_status: 'failed',
              analysis_error: params.outcome.errorMessage,
              analysis_completed_at: sql`now()`.mapWith(String),
              updated_at: sql`now()`.mapWith(String),
            }
      )
      .where(
        and(
          eq(security_findings.id, params.findingId),
          or(
            isNull(security_findings.ignored_reason),
            not(like(security_findings.ignored_reason, 'superseded:%'))
          )
        )
      )
      .returning();

    if (!updatedFinding) {
      await tx
        .update(security_findings)
        .set({
          analysis_status: null,
          updated_at: sql`now()`.mapWith(String),
        })
        .where(eq(security_findings.id, params.findingId));
      await tx
        .update(security_analysis_queue)
        .set({
          queue_status: 'completed',
          failure_code: 'SKIPPED_NO_LONGER_ELIGIBLE',
          last_error_redacted: null,
          updated_at: sql`now()`.mapWith(String),
        })
        .where(
          and(
            eq(security_analysis_queue.id, activeAttemptId),
            eq(security_analysis_queue.claim_token, params.attemptToken)
          )
        );
      return { status: 'superseded' };
    }

    await tx
      .update(security_analysis_queue)
      .set({
        queue_status: params.outcome.type === 'completed' ? 'completed' : 'failed',
        failure_code: params.outcome.type === 'completed' ? null : params.outcome.failureCode,
        last_error_redacted:
          params.outcome.type === 'completed' ? null : params.outcome.errorMessage,
        updated_at: sql`now()`.mapWith(String),
      })
      .where(
        and(
          eq(security_analysis_queue.id, activeAttemptId),
          eq(security_analysis_queue.claim_token, params.attemptToken)
        )
      );

    await insertTerminalAnalysisAuditEvent(tx, {
      previousAnalysisStatus: previousFinding?.analysis_status ?? null,
      finding: updatedFinding,
      attemptToken: params.attemptToken,
      outcome:
        params.outcome.type === 'completed'
          ? params.outcome
          : { type: 'failed', failureCode: params.outcome.failureCode },
    });

    return { status: params.outcome.type };
  });
}

export async function transitionAnalysisStartLifecycle(
  db: WorkerDb,
  params: {
    claim: AnalysisStartLifecycleClaim;
    outcome: AnalysisStartLifecycleOutcome;
  }
): Promise<{ transitioned: boolean }> {
  try {
    return await db.transaction(async tx => {
      const [previousFinding] = await tx
        .select()
        .from(security_findings)
        .where(eq(security_findings.id, params.claim.findingId))
        .for('update')
        .limit(1);
      const [updatedFinding] = await transitionFinding(tx, params.claim, params.outcome);
      if (!updatedFinding) {
        return { transitioned: false };
      }

      const queueRows = await tx
        .update(security_analysis_queue)
        .set({
          queue_status: queueStatusForOutcome(params.outcome),
          attempt_count: shouldIncrementAttempt(params.claim, params.outcome)
            ? sql`${security_analysis_queue.attempt_count} + 1`
            : security_analysis_queue.attempt_count,
          failure_code: params.outcome.type === 'start-failed' ? params.outcome.failureCode : null,
          last_error_redacted:
            params.outcome.type === 'start-failed' ? params.outcome.errorMessage : null,
          next_retry_at: params.outcome.type === 'start-failed' ? params.outcome.nextRetryAt : null,
          claimed_at:
            params.outcome.type === 'start-failed' && params.outcome.queueStatus === 'queued'
              ? null
              : security_analysis_queue.claimed_at,
          claimed_by_job_id:
            params.outcome.type === 'start-failed' && params.outcome.queueStatus === 'queued'
              ? null
              : security_analysis_queue.claimed_by_job_id,
          claim_token:
            params.outcome.type === 'start-failed' && params.outcome.queueStatus === 'queued'
              ? null
              : security_analysis_queue.claim_token,
          updated_at: sql`now()`.mapWith(String),
        })
        .where(
          and(
            params.claim.source === 'scheduled'
              ? eq(security_analysis_queue.id, params.claim.queueRowId)
              : eq(security_analysis_queue.finding_id, params.claim.findingId),
            eq(security_analysis_queue.claim_token, params.claim.claimToken),
            params.outcome.type === 'start-failed'
              ? inArray(security_analysis_queue.queue_status, ['pending', 'running'])
              : eq(security_analysis_queue.queue_status, 'pending')
          )
        )
        .returning({ id: security_analysis_queue.id });

      if (queueRows.length === 0) {
        throw new AnalysisStartQueueTransitionRejected();
      }

      if (params.outcome.type === 'triage-only-completed') {
        await insertTerminalAnalysisAuditEvent(tx, {
          previousAnalysisStatus: previousFinding?.analysis_status ?? null,
          finding: updatedFinding,
          attemptToken: params.claim.claimToken,
          outcome: { type: 'completed', analysis: params.outcome.analysis },
        });
      } else if (
        params.outcome.type === 'start-failed' &&
        params.outcome.queueStatus === 'failed'
      ) {
        await insertTerminalAnalysisAuditEvent(tx, {
          previousAnalysisStatus: previousFinding?.analysis_status ?? null,
          finding: updatedFinding,
          attemptToken: params.claim.claimToken,
          outcome: { type: 'failed', failureCode: params.outcome.failureCode },
        });
      }

      return { transitioned: true };
    });
  } catch (error) {
    if (error instanceof AnalysisStartQueueTransitionRejected) {
      return { transitioned: false };
    }
    throw error;
  }
}

function queueStatusForOutcome(
  outcome: AnalysisStartLifecycleOutcome
): 'queued' | 'running' | 'completed' | 'failed' {
  if (outcome.type === 'triage-only-completed') return 'completed';
  if (outcome.type === 'sandbox-running') return 'running';
  return outcome.queueStatus;
}

function shouldIncrementAttempt(
  claim: AnalysisStartLifecycleClaim,
  outcome: AnalysisStartLifecycleOutcome
): boolean {
  if (outcome.type === 'start-failed') return outcome.incrementAttempt;
  return claim.source === 'scheduled';
}

function transitionFinding(
  tx: Parameters<Parameters<WorkerDb['transaction']>[0]>[0],
  claim: AnalysisStartLifecycleClaim,
  outcome: AnalysisStartLifecycleOutcome
) {
  const ignoredReasonGuard = or(
    isNull(security_findings.ignored_reason),
    not(like(security_findings.ignored_reason, 'superseded:%'))
  );

  if (outcome.type === 'triage-only-completed') {
    return tx
      .update(security_findings)
      .set({
        analysis_status: 'completed',
        analysis: sql`${JSON.stringify(outcome.analysis)}::jsonb`,
        analysis_error: null,
        analysis_completed_at: sql`now()`.mapWith(String),
        updated_at: sql`now()`.mapWith(String),
      })
      .where(and(eq(security_findings.id, claim.findingId), ignoredReasonGuard))
      .returning();
  }

  if (outcome.type === 'start-failed') {
    return tx
      .update(security_findings)
      .set(
        outcome.queueStatus === 'failed'
          ? {
              analysis_status: 'failed',
              analysis_error: outcome.errorMessage,
              analysis_completed_at: sql`now()`.mapWith(String),
              updated_at: sql`now()`.mapWith(String),
            }
          : {
              analysis_status: null,
              analysis_error: null,
              analysis_completed_at: null,
              updated_at: sql`now()`.mapWith(String),
            }
      )
      .where(and(eq(security_findings.id, claim.findingId), ignoredReasonGuard))
      .returning();
  }

  return tx
    .update(security_findings)
    .set({
      analysis_status: 'running',
      session_id: outcome.cloudAgentSessionId,
      cli_session_id: outcome.kiloSessionId,
      analysis_started_at: sql`coalesce(${security_findings.analysis_started_at}, now())`.mapWith(
        String
      ),
      updated_at: sql`now()`.mapWith(String),
    })
    .where(and(eq(security_findings.id, claim.findingId), ignoredReasonGuard))
    .returning();
}
