import { randomUUID } from 'crypto';
import { getWorkerDb, type WorkerDb } from '@kilocode/db/client';
import {
  claimRowsForOwner,
  clearOwnerActorResolutionFailure,
  getSecurityFindingById,
  markOwnerActorResolutionFailure,
  markOwnerCreditFailure,
  resolveAutoAnalysisActor,
  updateQueueFromPending,
  type ClaimedQueueRow,
} from './db/queries.js';
import { logger } from './logger.js';
import { InsufficientCreditsError, startSecurityAnalysis } from './launch.js';
import {
  AutoAnalysisOwnerMessageSchema,
  AUTO_ANALYSIS_MAX_ATTEMPTS,
  AUTO_ANALYSIS_OWNER_CAP,
  type ActorResolutionMode,
  type AutoAnalysisFailureCode,
  type ProcessCounters,
  type QueueOwner,
  type SecurityAgentConfig,
} from './types.js';

type QueueStatus = 'queued' | 'pending' | 'running' | 'completed' | 'failed';

type QueueTransitionContext = {
  jobId?: string;
  owner?: QueueOwner;
  findingId?: string;
  queueId: string;
  claimToken?: string | null;
  fromState: QueueStatus;
  toState: QueueStatus;
  attemptCount?: number;
  failureCode?: AutoAnalysisFailureCode | null;
  actorUserId?: string;
  actorResolutionMode?: ActorResolutionMode;
};

type LaunchFailureClass = 'retryable' | 'non_retryable' | 'credit_gated';

type LaunchFailureClassification = {
  code: AutoAnalysisFailureCode;
  class: LaunchFailureClass;
};

type TransitionParams = {
  db: WorkerDb;
  rowId: string;
  claimToken: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  failureCode?: AutoAnalysisFailureCode;
  errorMessage?: string;
  incrementAttempt?: boolean;
  nextRetryAt?: Date | null;
  logContext?: Omit<QueueTransitionContext, 'queueId' | 'fromState' | 'toState' | 'failureCode'> & {
    fromState?: QueueStatus;
    attemptCount?: number;
  };
};

function logQueueTransition(context: QueueTransitionContext): void {
  logger.info('Auto-analysis queue transition', {
    job_id: context.jobId,
    owned_by_organization_id: context.owner?.type === 'org' ? context.owner.id : null,
    owned_by_user_id: context.owner?.type === 'user' ? context.owner.id : null,
    owner_type: context.owner?.type,
    owner_id: context.owner?.id,
    finding_id: context.findingId,
    queue_id: context.queueId,
    claim_token: context.claimToken,
    from_state: context.fromState,
    to_state: context.toState,
    attempt_count: context.attemptCount,
    failure_code: context.failureCode ?? null,
    actor_user_id: context.actorUserId,
    actor_resolution_mode: context.actorResolutionMode,
  });
}

function classifyLaunchFailureMessage(
  errorMessage: string | undefined
): LaunchFailureClassification {
  const message = errorMessage?.toLowerCase() ?? '';
  if (message.includes('timeout') || message.includes('timed out')) {
    return { code: 'NETWORK_TIMEOUT', class: 'retryable' };
  }
  if (
    message.includes('502') ||
    message.includes('503') ||
    message.includes('504') ||
    message.includes('5xx') ||
    message.includes('upstream')
  ) {
    return { code: 'UPSTREAM_5XX', class: 'retryable' };
  }
  if (
    message.includes('permission denied') ||
    message.includes('forbidden') ||
    message.includes('403')
  ) {
    return { code: 'PERMISSION_DENIED_PERMANENT', class: 'non_retryable' };
  }
  if (message.includes('invalid config') || message.includes('invalid configuration')) {
    return { code: 'INVALID_CONFIG', class: 'non_retryable' };
  }
  if (message.includes('unsupported severity')) {
    return { code: 'UNSUPPORTED_SEVERITY', class: 'non_retryable' };
  }
  return { code: 'START_CALL_AMBIGUOUS', class: 'retryable' };
}

function classifyLaunchStartResult(startResult: {
  started: boolean;
  error?: string;
}): LaunchFailureClassification {
  if (startResult.error === 'Analysis already in progress') {
    return { code: 'SKIPPED_ALREADY_IN_PROGRESS', class: 'non_retryable' };
  }
  if (startResult.error?.includes("analysis requires 'open' status")) {
    return { code: 'SKIPPED_NO_LONGER_ELIGIBLE', class: 'non_retryable' };
  }

  return classifyLaunchFailureMessage(startResult.error);
}

function classifyLaunchException(error: unknown): LaunchFailureClassification {
  if (error instanceof InsufficientCreditsError) {
    return { code: 'INSUFFICIENT_CREDITS', class: 'credit_gated' };
  }

  const message = error instanceof Error ? error.message : String(error);
  return classifyLaunchFailureMessage(message);
}

function ownerFromQueueRow(row: ClaimedQueueRow): QueueOwner | null {
  if (row.owned_by_organization_id) {
    return { type: 'org', id: row.owned_by_organization_id };
  }
  if (row.owned_by_user_id) {
    return { type: 'user', id: row.owned_by_user_id };
  }

  return null;
}

function getSeverityRankForAutoAnalysis(severity: string | null): number | null {
  if (severity === 'critical') return 0;
  if (severity === 'high') return 1;
  if (severity === 'medium') return 2;
  if (severity === 'low') return 3;
  return null;
}

function maxSeverityRankForThreshold(
  minSeverity: SecurityAgentConfig['auto_analysis_min_severity']
): number {
  if (minSeverity === 'critical') return 0;
  if (minSeverity === 'high') return 1;
  if (minSeverity === 'medium') return 2;
  return 3;
}

function isEligibleForAutoLaunch(params: {
  findingCreatedAt: string;
  findingStatus: string;
  findingSeverity: string | null;
  autoAnalysisEnabledAt: string | null;
  config: SecurityAgentConfig;
  isAgentEnabled: boolean;
}): boolean {
  if (!params.isAgentEnabled || !params.config.auto_analysis_enabled) {
    return false;
  }
  if (params.findingStatus !== 'open') {
    return false;
  }
  if (!params.autoAnalysisEnabledAt) {
    return false;
  }
  if (
    !params.config.auto_analysis_include_existing &&
    Date.parse(params.findingCreatedAt) < Date.parse(params.autoAnalysisEnabledAt)
  ) {
    return false;
  }

  // Treat null/unknown severity as low (rank 3) so these findings are not
  // silently skipped. They still respect the severity threshold.
  const severityRank = getSeverityRankForAutoAnalysis(params.findingSeverity) ?? 3;

  return severityRank <= maxSeverityRankForThreshold(params.config.auto_analysis_min_severity);
}

function nextRetryAt(attemptCount: number): Date {
  const baseDelayMs = 15_000 * 2 ** Math.max(0, attemptCount);
  const cappedDelayMs = Math.min(15 * 60 * 1000, baseDelayMs);
  const jitterMs = Math.round(cappedDelayMs * Math.random() * 0.2);
  return new Date(Date.now() + cappedDelayMs + jitterMs);
}

async function markQueuePendingState(params: TransitionParams): Promise<void> {
  const result = await updateQueueFromPending(params.db, {
    rowId: params.rowId,
    claimToken: params.claimToken,
    status: params.status,
    failureCode: params.failureCode ?? null,
    errorMessage: params.errorMessage ?? null,
    incrementAttempt: params.incrementAttempt ?? false,
    nextRetryAt: params.nextRetryAt ? params.nextRetryAt.toISOString() : null,
  });

  const attemptCount =
    params.logContext?.attemptCount !== undefined
      ? params.logContext.attemptCount
      : (result.attemptCount ?? undefined);

  logQueueTransition({
    queueId: params.rowId,
    fromState: params.logContext?.fromState ?? 'pending',
    toState: params.status,
    failureCode: params.failureCode ?? null,
    jobId: params.logContext?.jobId,
    owner: params.logContext?.owner,
    findingId: params.logContext?.findingId,
    claimToken: params.claimToken,
    attemptCount,
    actorUserId: params.logContext?.actorUserId,
    actorResolutionMode: params.logContext?.actorResolutionMode,
  });

  if (!result.updated) {
    logger.warn('Queue transition was not applied due to guard mismatch', {
      queue_id: params.rowId,
      claim_token: params.claimToken,
      desired_status: params.status,
    });
  }
}

async function resolveGitHubToken(params: {
  env: CloudflareEnv;
  owner: QueueOwner;
  actorUserId: string;
  githubRepo: string;
}): Promise<string | undefined> {
  const lookup = await params.env.GIT_TOKEN_SERVICE.getTokenForRepo({
    githubRepo: params.githubRepo,
    userId: params.actorUserId,
    orgId: params.owner.type === 'org' ? params.owner.id : undefined,
  });

  if (!lookup.success) {
    if (lookup.reason === 'database_not_configured') {
      throw new Error('database_not_configured');
    }

    return undefined;
  }

  return lookup.token;
}

async function processOwnerMessage(params: {
  env: CloudflareEnv;
  owner: QueueOwner;
  dispatchId: string;
}): Promise<ProcessCounters> {
  const db = getWorkerDb(params.env.HYPERDRIVE.connectionString, { statement_timeout: 30_000 });
  const jobId = randomUUID();
  const counters: ProcessCounters = {
    processed: 0,
    launched: 0,
    completed: 0,
    failed: 0,
    requeued: 0,
    skipped: 0,
  };

  const claim = await claimRowsForOwner(db, {
    owner: params.owner,
    jobId,
    maxPerOwner: AUTO_ANALYSIS_OWNER_CAP,
  });

  for (const claimedRow of claim.rows) {
    logQueueTransition({
      jobId,
      owner: params.owner,
      findingId: claimedRow.finding_id,
      queueId: claimedRow.id,
      claimToken: claimedRow.claim_token,
      fromState: 'queued',
      toState: 'pending',
      attemptCount: claimedRow.attempt_count,
    });
  }

  if (claim.rows.length === 0) {
    return counters;
  }

  const [nextAuthSecret, internalApiSecret] = await Promise.all([
    params.env.NEXTAUTH_SECRET.get(),
    params.env.INTERNAL_API_SECRET.get(),
  ]);

  ownerLoop: for (const [rowIndex, row] of claim.rows.entries()) {
    counters.processed += 1;

    try {
      const finding = await getSecurityFindingById(db, row.finding_id);
      if (!finding) {
        await markQueuePendingState({
          db,
          rowId: row.id,
          claimToken: row.claim_token,
          status: 'failed',
          failureCode: 'STATE_GUARD_REJECTED',
          errorMessage: 'Finding missing while processing auto-analysis queue',
          logContext: {
            jobId,
            owner: params.owner,
            findingId: row.finding_id,
            attemptCount: row.attempt_count,
          },
        });
        counters.failed += 1;
        continue;
      }

      const stillEligible = isEligibleForAutoLaunch({
        findingCreatedAt: finding.created_at,
        findingStatus: finding.status,
        findingSeverity: finding.severity,
        autoAnalysisEnabledAt: claim.autoAnalysisEnabledAt,
        config: claim.config,
        isAgentEnabled: claim.isAgentEnabled,
      });

      if (!stillEligible) {
        await markQueuePendingState({
          db,
          rowId: row.id,
          claimToken: row.claim_token,
          status: 'completed',
          failureCode: 'SKIPPED_NO_LONGER_ELIGIBLE',
          logContext: {
            jobId,
            owner: params.owner,
            findingId: row.finding_id,
            attemptCount: row.attempt_count,
          },
        });
        counters.completed += 1;
        continue;
      }

      const launchOwner = ownerFromQueueRow(row);
      if (!launchOwner) {
        await markQueuePendingState({
          db,
          rowId: row.id,
          claimToken: row.claim_token,
          status: 'failed',
          failureCode: 'MISSING_OWNERSHIP',
          logContext: {
            jobId,
            owner: params.owner,
            findingId: row.finding_id,
            attemptCount: row.attempt_count,
          },
        });
        counters.failed += 1;
        continue;
      }

      const actorResolution = await resolveAutoAnalysisActor(db, launchOwner);
      if (!actorResolution) {
        await markOwnerActorResolutionFailure(db, launchOwner);

        await markQueuePendingState({
          db,
          rowId: row.id,
          claimToken: row.claim_token,
          status: 'queued',
          failureCode: 'ACTOR_RESOLUTION_FAILED',
          nextRetryAt: new Date(Date.now() + 30 * 60 * 1000),
          logContext: {
            jobId,
            owner: launchOwner,
            findingId: row.finding_id,
            attemptCount: row.attempt_count,
          },
        });
        counters.requeued += 1;

        for (const remainingRow of claim.rows.slice(rowIndex + 1)) {
          await markQueuePendingState({
            db,
            rowId: remainingRow.id,
            claimToken: remainingRow.claim_token,
            status: 'queued',
            failureCode: 'ACTOR_RESOLUTION_FAILED',
            nextRetryAt: new Date(Date.now() + 30 * 60 * 1000),
            logContext: {
              jobId,
              owner: launchOwner,
              findingId: remainingRow.finding_id,
              attemptCount: remainingRow.attempt_count,
            },
          });
          counters.requeued += 1;
        }

        break ownerLoop;
      }

      await clearOwnerActorResolutionFailure(db, launchOwner);

      let githubToken: string | undefined;
      try {
        githubToken = await resolveGitHubToken({
          env: params.env,
          owner: launchOwner,
          actorUserId: actorResolution.user.id,
          githubRepo: finding.repo_full_name,
        });
      } catch (error) {
        await markQueuePendingState({
          db,
          rowId: row.id,
          claimToken: row.claim_token,
          status: 'queued',
          failureCode: 'TEMP_TOKEN_FAILURE',
          errorMessage: error instanceof Error ? error.message : String(error),
          nextRetryAt: nextRetryAt(row.attempt_count + 1),
          logContext: {
            jobId,
            owner: launchOwner,
            findingId: row.finding_id,
            attemptCount: row.attempt_count,
            actorUserId: actorResolution.user.id,
            actorResolutionMode: actorResolution.mode,
          },
        });
        counters.requeued += 1;
        continue;
      }

      if (!githubToken) {
        const nextAttemptCount = row.attempt_count + 1;
        const terminal = nextAttemptCount >= AUTO_ANALYSIS_MAX_ATTEMPTS;
        await markQueuePendingState({
          db,
          rowId: row.id,
          claimToken: row.claim_token,
          status: terminal ? 'failed' : 'queued',
          failureCode: 'GITHUB_TOKEN_UNAVAILABLE',
          incrementAttempt: true,
          nextRetryAt: terminal ? undefined : nextRetryAt(nextAttemptCount),
          logContext: {
            jobId,
            owner: launchOwner,
            findingId: row.finding_id,
            attemptCount: nextAttemptCount,
            actorUserId: actorResolution.user.id,
            actorResolutionMode: actorResolution.mode,
          },
        });
        if (terminal) {
          counters.failed += 1;
        } else {
          counters.requeued += 1;
        }
        continue;
      }

      const startResult = await startSecurityAnalysis({
        db,
        env: params.env,
        findingId: finding.id,
        actorUser: actorResolution.user,
        githubToken,
        model: claim.config.model_slug ?? 'anthropic/claude-opus-4.6',
        analysisMode: claim.config.analysis_mode,
        organizationId: launchOwner.type === 'org' ? launchOwner.id : undefined,
        nextAuthSecret,
        internalApiSecret,
      });

      if (startResult.started) {
        if (startResult.triageOnly) {
          await markQueuePendingState({
            db,
            rowId: row.id,
            claimToken: row.claim_token,
            status: 'completed',
            incrementAttempt: true,
            logContext: {
              jobId,
              owner: launchOwner,
              findingId: row.finding_id,
              attemptCount: row.attempt_count + 1,
              actorUserId: actorResolution.user.id,
              actorResolutionMode: actorResolution.mode,
            },
          });
          counters.completed += 1;
        } else {
          await markQueuePendingState({
            db,
            rowId: row.id,
            claimToken: row.claim_token,
            status: 'running',
            incrementAttempt: true,
            logContext: {
              jobId,
              owner: launchOwner,
              findingId: row.finding_id,
              attemptCount: row.attempt_count + 1,
              actorUserId: actorResolution.user.id,
              actorResolutionMode: actorResolution.mode,
            },
          });
          counters.launched += 1;
        }
        continue;
      }

      const classification = classifyLaunchStartResult(startResult);
      if (classification.code === 'SKIPPED_ALREADY_IN_PROGRESS') {
        await markQueuePendingState({
          db,
          rowId: row.id,
          claimToken: row.claim_token,
          status: 'completed',
          failureCode: classification.code,
          logContext: {
            jobId,
            owner: launchOwner,
            findingId: row.finding_id,
            attemptCount: row.attempt_count,
            actorUserId: actorResolution.user.id,
            actorResolutionMode: actorResolution.mode,
          },
        });
        counters.skipped += 1;
        continue;
      }

      const nextAttemptCount = row.attempt_count + 1;
      const isRetryable = classification.class === 'retryable';
      const terminal = !isRetryable || nextAttemptCount >= AUTO_ANALYSIS_MAX_ATTEMPTS;

      if (terminal) {
        await markQueuePendingState({
          db,
          rowId: row.id,
          claimToken: row.claim_token,
          status: 'failed',
          failureCode: classification.code,
          errorMessage: startResult.error,
          incrementAttempt: true,
          logContext: {
            jobId,
            owner: launchOwner,
            findingId: row.finding_id,
            attemptCount: nextAttemptCount,
            actorUserId: actorResolution.user.id,
            actorResolutionMode: actorResolution.mode,
          },
        });
        counters.failed += 1;
      } else {
        await markQueuePendingState({
          db,
          rowId: row.id,
          claimToken: row.claim_token,
          status: 'queued',
          failureCode: classification.code,
          errorMessage: startResult.error,
          incrementAttempt: true,
          nextRetryAt: nextRetryAt(nextAttemptCount),
          logContext: {
            jobId,
            owner: launchOwner,
            findingId: row.finding_id,
            attemptCount: nextAttemptCount,
            actorUserId: actorResolution.user.id,
            actorResolutionMode: actorResolution.mode,
          },
        });
        counters.requeued += 1;
      }
    } catch (error) {
      const classification = classifyLaunchException(error);
      const catchOwner = ownerFromQueueRow(row) ?? params.owner;

      if (classification.class === 'credit_gated') {
        await markOwnerCreditFailure(db, catchOwner);

        await markQueuePendingState({
          db,
          rowId: row.id,
          claimToken: row.claim_token,
          status: 'queued',
          failureCode: classification.code,
          errorMessage: error instanceof Error ? error.message : String(error),
          nextRetryAt: new Date(Date.now() + 30 * 60 * 1000),
          logContext: {
            jobId,
            owner: catchOwner,
            findingId: row.finding_id,
            attemptCount: row.attempt_count,
          },
        });

        counters.requeued += 1;

        for (const remainingRow of claim.rows.slice(rowIndex + 1)) {
          await markQueuePendingState({
            db,
            rowId: remainingRow.id,
            claimToken: remainingRow.claim_token,
            status: 'queued',
            failureCode: classification.code,
            nextRetryAt: new Date(Date.now() + 30 * 60 * 1000),
            logContext: {
              jobId,
              owner: catchOwner,
              findingId: remainingRow.finding_id,
              attemptCount: remainingRow.attempt_count,
            },
          });
          counters.requeued += 1;
        }
        break;
      }

      const nextAttemptCount = row.attempt_count + 1;
      const terminal =
        classification.class !== 'retryable' || nextAttemptCount >= AUTO_ANALYSIS_MAX_ATTEMPTS;

      if (terminal) {
        await markQueuePendingState({
          db,
          rowId: row.id,
          claimToken: row.claim_token,
          status: 'failed',
          failureCode: classification.code,
          errorMessage: error instanceof Error ? error.message : String(error),
          incrementAttempt: true,
          logContext: {
            jobId,
            owner: catchOwner,
            findingId: row.finding_id,
            attemptCount: nextAttemptCount,
          },
        });
        counters.failed += 1;
      } else {
        await markQueuePendingState({
          db,
          rowId: row.id,
          claimToken: row.claim_token,
          status: 'queued',
          failureCode: classification.code,
          errorMessage: error instanceof Error ? error.message : String(error),
          incrementAttempt: true,
          nextRetryAt: nextRetryAt(nextAttemptCount),
          logContext: {
            jobId,
            owner: catchOwner,
            findingId: row.finding_id,
            attemptCount: nextAttemptCount,
          },
        });
        counters.requeued += 1;
      }
    }
  }

  logger.info('Processed owner auto-analysis message', {
    dispatch_id: params.dispatchId,
    job_id: jobId,
    owner_type: params.owner.type,
    owner_id: params.owner.id,
    ...counters,
  });

  return counters;
}

export async function consumeOwnerBatch(
  batch: MessageBatch<unknown>,
  env: CloudflareEnv
): Promise<void> {
  for (const message of batch.messages) {
    const parsedMessage = AutoAnalysisOwnerMessageSchema.safeParse(message.body);
    if (!parsedMessage.success) {
      logger.error('Invalid owner queue message shape', {
        queue: batch.queue,
        error: parsedMessage.error.message,
      });
      message.ack();
      continue;
    }

    const owner: QueueOwner =
      parsedMessage.data.ownerType === 'org'
        ? { type: 'org', id: parsedMessage.data.ownerId }
        : { type: 'user', id: parsedMessage.data.ownerId };

    try {
      await processOwnerMessage({
        env,
        owner,
        dispatchId: parsedMessage.data.dispatchId,
      });

      message.ack();
    } catch (error) {
      logger.error('Failed processing owner queue message', {
        queue: batch.queue,
        owner_type: owner.type,
        owner_id: owner.id,
        attempts: message.attempts,
        error: error instanceof Error ? error.message : String(error),
      });

      message.retry();
    }
  }
}
