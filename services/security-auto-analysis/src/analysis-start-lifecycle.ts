import type { WorkerDb } from '@kilocode/db/client';
import { security_analysis_queue, security_findings } from '@kilocode/db/schema';
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

class AnalysisStartQueueTransitionRejected extends Error {
  constructor() {
    super('Analysis start queue transition rejected');
    this.name = 'AnalysisStartQueueTransitionRejected';
  }
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
      const findingRows = await transitionFinding(tx, params.claim, params.outcome);
      if (findingRows.length === 0) {
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
      .returning({ id: security_findings.id });
  }

  if (outcome.type === 'start-failed') {
    return tx
      .update(security_findings)
      .set({
        analysis_status: 'failed',
        analysis_error: outcome.errorMessage,
        analysis_completed_at: sql`now()`.mapWith(String),
        updated_at: sql`now()`.mapWith(String),
      })
      .where(and(eq(security_findings.id, claim.findingId), ignoredReasonGuard))
      .returning({ id: security_findings.id });
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
    .returning({ id: security_findings.id });
}
