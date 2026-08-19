import { and, eq, sql } from 'drizzle-orm';
import {
  kilocode_users,
  user_deletion_requests,
  user_deletion_steps,
  type UserDeletionRequest,
  type UserDeletionStep,
} from '@kilocode/db/schema';
import {
  UserDeletionAuditEventType,
  UserDeletionCloudSubjectResolution,
  UserDeletionRequestStatus,
  UserDeletionStepKey,
  UserDeletionStepStatus,
  type UserDeletionManualEvidence,
} from '@kilocode/db/schema-types';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import { anonymizeCloudUserData } from '@/lib/user';
import { disableUserAccessForDeletion } from '@/lib/user/deletion-queue/deletion-access';
import { catalogEntryFor, teardownStepKeys } from '@/lib/user/deletion-queue/deletion-catalog';
import {
  USER_DELETION_ANONYMIZE_MIN_STATEMENT_TIMEOUT_MS,
  USER_DELETION_ANONYMIZE_TIMEOUT_BUFFER_MS,
  USER_DELETION_CONTINUE_DELAY_MS,
  USER_DELETION_MAX_ORDINARY_ATTEMPTS,
  USER_DELETION_RATE_LIMIT_ATTENTION_MS,
  USER_DELETION_RETRY_BASE_MS,
  USER_DELETION_RETRY_CAP_MS,
} from '@/lib/user/deletion-queue/deletion-constants';
import {
  writeDeletionActivity,
  writeDeletionAudit,
} from '@/lib/user/deletion-queue/deletion-audit';
import { advanceDeletionGates } from '@/lib/user/deletion-queue/deletion-completion';
import type {
  DeletionHandlerOutcome,
  DeletionPreflightOutcome,
  PersistTaskOutcomeResult,
} from '@/lib/user/deletion-queue/deletion-types';
import { SUCCESSFUL_TASK_STATUSES } from '@/lib/user/deletion-queue/deletion-types';

export function ordinaryRetryDelayMs(
  windowAttemptAfterIncrement: number,
  random = Math.random
): number {
  const exponent = Math.max(0, windowAttemptAfterIncrement - 1);
  const delay = Math.min(USER_DELETION_RETRY_CAP_MS, USER_DELETION_RETRY_BASE_MS * 2 ** exponent);
  return Math.floor(delay / 2 + random() * (delay / 2));
}

export async function persistHandlerOutcome(params: {
  requestId: string;
  stepKey: UserDeletionStepKey;
  claimToken: string;
  outcome: DeletionHandlerOutcome;
  handlerDeadlineAt?: number;
}): Promise<PersistTaskOutcomeResult> {
  const result =
    params.outcome.kind === 'succeeded' && params.stepKey === UserDeletionStepKey.Anonymize
      ? await persistAnonymizeSuccessTx(params)
      : await persistHandlerOutcomeTx(params);
  const shouldAdvanceGates =
    (result.kind === 'applied' &&
      (result.effectiveOutcome.kind === 'succeeded' ||
        result.effectiveOutcome.kind === 'not_applicable')) ||
    (result.kind === 'already_terminal' &&
      (params.outcome.kind === 'succeeded' || params.outcome.kind === 'not_applicable'));
  if (shouldAdvanceGates) {
    await advanceDeletionGates(params.requestId);
  }
  return result;
}

async function persistHandlerOutcomeTx(params: {
  requestId: string;
  stepKey: UserDeletionStepKey;
  claimToken: string;
  outcome: DeletionHandlerOutcome;
}): Promise<PersistTaskOutcomeResult> {
  return db.transaction(async tx => {
    const locked = await lockClaimedStep(tx, params);
    if (locked.kind !== 'running') return locked;

    await persistTaskDispositionTx(tx, {
      request: locked.request,
      step: locked.step,
      stepKey: params.stepKey,
      outcome: params.outcome,
    });
    return { kind: 'applied', effectiveOutcome: params.outcome };
  });
}

async function persistAnonymizeSuccessTx(params: {
  requestId: string;
  stepKey: UserDeletionStepKey;
  claimToken: string;
  outcome: DeletionHandlerOutcome;
  handlerDeadlineAt?: number;
}): Promise<PersistTaskOutcomeResult> {
  return db.transaction(async tx => {
    const locked = await lockClaimedStep(tx, params);
    if (locked.kind !== 'running') return locked;

    const remainingMs = (params.handlerDeadlineAt ?? Date.now()) - Date.now();
    const timeoutMs = remainingMs - USER_DELETION_ANONYMIZE_TIMEOUT_BUFFER_MS;
    if (timeoutMs < USER_DELETION_ANONYMIZE_MIN_STATEMENT_TIMEOUT_MS) {
      const outcome: DeletionHandlerOutcome = { kind: 'continue' };
      await persistTaskDispositionTx(tx, {
        request: locked.request,
        step: locked.step,
        stepKey: params.stepKey,
        outcome,
      });
      return { kind: 'applied', effectiveOutcome: outcome };
    }

    const steps = await tx
      .select()
      .from(user_deletion_steps)
      .where(eq(user_deletion_steps.request_id, params.requestId));
    for (const key of teardownStepKeys()) {
      const teardown = steps.find(candidate => candidate.step_key === key);
      if (!teardown || !(SUCCESSFUL_TASK_STATUSES as readonly string[]).includes(teardown.status)) {
        const outcome: DeletionHandlerOutcome = {
          kind: 'needs_attention',
          errorCode: 'teardown_incomplete',
        };
        await persistTaskDispositionTx(tx, {
          request: locked.request,
          step: locked.step,
          stepKey: params.stepKey,
          outcome,
        });
        return { kind: 'applied', effectiveOutcome: outcome };
      }
    }

    const userId = locked.request.user_id;
    if (!userId) {
      const outcome: DeletionHandlerOutcome = {
        kind: 'needs_attention',
        errorCode: 'user_missing',
      };
      await persistTaskDispositionTx(tx, {
        request: locked.request,
        step: locked.step,
        stepKey: params.stepKey,
        outcome,
      });
      return { kind: 'applied', effectiveOutcome: outcome };
    }

    await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${Math.floor(timeoutMs)}`));
    const [user] = await tx
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, userId))
      .for('update')
      .limit(1);
    if (!user) {
      const outcome: DeletionHandlerOutcome = {
        kind: 'needs_attention',
        errorCode: 'user_missing',
      };
      await persistTaskDispositionTx(tx, {
        request: locked.request,
        step: locked.step,
        stepKey: params.stepKey,
        outcome,
      });
      return { kind: 'applied', effectiveOutcome: outcome };
    }

    await anonymizeCloudUserData(tx, userId);
    await tx
      .update(user_deletion_requests)
      .set({
        anonymized_at: sql`coalesce(${user_deletion_requests.anonymized_at}, now())`,
      })
      .where(eq(user_deletion_requests.id, params.requestId));
    await writeDeletionAudit(tx, {
      requestId: params.requestId,
      eventType: UserDeletionAuditEventType.Anonymized,
      targetEmailHmac: locked.request.target_email_hmac,
      subjectKey: 'request',
    });
    await persistTaskDispositionTx(tx, {
      request: locked.request,
      step: locked.step,
      stepKey: params.stepKey,
      outcome: params.outcome,
    });
    return {
      kind: 'applied',
      effectiveOutcome: params.outcome,
      anonymizedUserId: userId,
    };
  });
}

async function lockClaimedStep(
  tx: DrizzleTransaction,
  params: {
    requestId: string;
    stepKey: UserDeletionStepKey;
    claimToken: string;
    outcome: DeletionHandlerOutcome;
  }
): Promise<
  | { kind: 'running'; request: UserDeletionRequest; step: UserDeletionStep }
  | PersistTaskOutcomeResult
> {
  const [request] = await tx
    .select()
    .from(user_deletion_requests)
    .where(eq(user_deletion_requests.id, params.requestId))
    .for('update');
  if (!request) return { kind: 'stale_claim' };

  const [step] = await tx
    .select()
    .from(user_deletion_steps)
    .where(
      and(
        eq(user_deletion_steps.request_id, params.requestId),
        eq(user_deletion_steps.step_key, params.stepKey),
        eq(user_deletion_steps.claim_token, params.claimToken)
      )
    )
    .for('update');

  if (!step) {
    const [existing] = await tx
      .select()
      .from(user_deletion_steps)
      .where(
        and(
          eq(user_deletion_steps.request_id, params.requestId),
          eq(user_deletion_steps.step_key, params.stepKey)
        )
      )
      .for('update');
    if (
      existing &&
      (params.outcome.kind === 'succeeded' || params.outcome.kind === 'not_applicable') &&
      (existing.status === UserDeletionStepStatus.Succeeded ||
        existing.status === UserDeletionStepStatus.NotApplicable)
    ) {
      await tx
        .update(user_deletion_requests)
        .set({ last_progress_at: sql`now()` })
        .where(eq(user_deletion_requests.id, params.requestId));
      return { kind: 'already_terminal' };
    }
    return { kind: 'stale_claim' };
  }
  if (step.status !== UserDeletionStepStatus.Running) {
    return { kind: 'stale_claim' };
  }
  return { kind: 'running', request, step };
}

async function persistTaskDispositionTx(
  tx: DrizzleTransaction,
  params: {
    request: UserDeletionRequest;
    step: UserDeletionStep;
    stepKey: UserDeletionStepKey;
    outcome: DeletionHandlerOutcome;
  }
): Promise<void> {
  const now = sql`now()`;
  const { request, step, stepKey, outcome } = params;

  switch (outcome.kind) {
    case 'continue':
      await tx
        .update(user_deletion_steps)
        .set({
          status: UserDeletionStepStatus.Pending,
          available_at: sql`now() + interval '${sql.raw(String(USER_DELETION_CONTINUE_DELAY_MS / 1000))} seconds'`,
          claim_token: null,
          claimed_until: null,
          progress_json: outcome.progress ?? step.progress_json,
          last_error_code: null,
          rate_limited_since: null,
        })
        .where(eq(user_deletion_steps.id, step.id));
      await writeDeletionActivity(tx, {
        requestId: request.id,
        stepKey,
        eventType: 'continue',
        details: { processed_count: outcome.progress?.processed_count },
      });
      break;
    case 'retry': {
      const nextWindow = step.window_attempt_count + 1;
      const nextLifetime = step.lifetime_attempt_count + 1;
      if (nextWindow >= USER_DELETION_MAX_ORDINARY_ATTEMPTS) {
        await moveToAttention(tx, {
          stepId: step.id,
          requestId: request.id,
          stepKey,
          hmac: request.target_email_hmac,
          errorCode: outcome.errorCode,
          windowAttempt: nextWindow,
          lifetimeAttempt: nextLifetime,
        });
        break;
      }
      const delayMs = ordinaryRetryDelayMs(nextWindow);
      await tx
        .update(user_deletion_steps)
        .set({
          status: UserDeletionStepStatus.RetryWait,
          available_at: sql`now() + interval '${sql.raw(String(Math.max(1, Math.ceil(delayMs / 1000))))} seconds'`,
          claim_token: null,
          claimed_until: null,
          window_attempt_count: nextWindow,
          lifetime_attempt_count: nextLifetime,
          last_error_code: outcome.errorCode,
          rate_limited_since: null,
        })
        .where(eq(user_deletion_steps.id, step.id));
      await writeDeletionActivity(tx, {
        requestId: request.id,
        stepKey,
        eventType: 'retry_wait',
        details: {
          error_code: outcome.errorCode,
          http_status_class: outcome.httpStatusClass,
        },
      });
      break;
    }
    case 'rate_limited': {
      const retryMs = Math.max(60_000, outcome.retryAfterMs);
      const horizonMs = USER_DELETION_RATE_LIMIT_ATTENTION_MS;
      const rateLimitedSince = step.rate_limited_since
        ? new Date(step.rate_limited_since).getTime()
        : Date.now();
      if (Date.now() - rateLimitedSince >= horizonMs) {
        await moveToAttention(tx, {
          stepId: step.id,
          requestId: request.id,
          stepKey,
          hmac: request.target_email_hmac,
          errorCode: 'rate_limited_24h',
          windowAttempt: step.window_attempt_count,
          lifetimeAttempt: step.lifetime_attempt_count,
          rateLimitedSince: step.rate_limited_since,
        });
        break;
      }
      const delaySeconds = Math.min(
        Math.ceil(retryMs / 1000),
        Math.ceil((rateLimitedSince + horizonMs - Date.now()) / 1000)
      );
      await tx
        .update(user_deletion_steps)
        .set({
          status: UserDeletionStepStatus.RetryWait,
          available_at: sql`now() + interval '${sql.raw(String(Math.max(1, delaySeconds)))} seconds'`,
          claim_token: null,
          claimed_until: null,
          last_error_code: 'rate_limited',
          rate_limited_since: step.rate_limited_since ?? now,
        })
        .where(eq(user_deletion_steps.id, step.id));
      await writeDeletionActivity(tx, {
        requestId: request.id,
        stepKey,
        eventType: 'rate_limited',
        details: {
          error_code: 'rate_limited',
          retry_at: new Date(Date.now() + retryMs).toISOString(),
        },
      });
      break;
    }
    case 'needs_attention':
      await moveToAttention(tx, {
        stepId: step.id,
        requestId: request.id,
        stepKey,
        hmac: request.target_email_hmac,
        errorCode: outcome.errorCode,
        resourceHmac: outcome.resourceHmac,
        windowAttempt: step.window_attempt_count,
        lifetimeAttempt: step.lifetime_attempt_count,
      });
      break;
    case 'manual_action_required':
      await tx
        .update(user_deletion_steps)
        .set({
          status: UserDeletionStepStatus.ManualActionRequired,
          claim_token: null,
          claimed_until: null,
          last_error_code: outcome.errorCode,
        })
        .where(eq(user_deletion_steps.id, step.id));
      await writeDeletionAudit(tx, {
        requestId: request.id,
        eventType: UserDeletionAuditEventType.TaskDisposition,
        targetEmailHmac: request.target_email_hmac,
        subjectKey: `${stepKey}:manual_action_required`,
        details: {
          step_key: stepKey,
          disposition: 'manual_action_required',
          code: outcome.errorCode,
        },
      });
      await writeDeletionActivity(tx, {
        requestId: request.id,
        stepKey,
        eventType: 'manual_action_required',
        details: { error_code: outcome.errorCode },
      });
      break;
    case 'succeeded':
    case 'not_applicable': {
      const status =
        outcome.kind === 'succeeded'
          ? UserDeletionStepStatus.Succeeded
          : UserDeletionStepStatus.NotApplicable;
      await tx
        .update(user_deletion_steps)
        .set({
          status,
          claim_token: null,
          claimed_until: null,
          last_error_code: outcome.kind === 'not_applicable' ? outcome.errorCode : null,
          rate_limited_since: null,
          progress_json:
            outcome.kind === 'succeeded' ? (outcome.progress ?? step.progress_json) : {},
        })
        .where(eq(user_deletion_steps.id, step.id));
      await writeDeletionAudit(tx, {
        requestId: request.id,
        eventType: UserDeletionAuditEventType.TaskDisposition,
        targetEmailHmac: request.target_email_hmac,
        subjectKey: `${stepKey}:${outcome.kind}`,
        details: { step_key: stepKey, disposition: outcome.kind },
      });
      await writeDeletionActivity(tx, {
        requestId: request.id,
        stepKey,
        eventType: outcome.kind,
        details: {
          processed_count:
            outcome.kind === 'succeeded' ? outcome.progress?.processed_count : undefined,
        },
      });
      break;
    }
  }

  await tx
    .update(user_deletion_requests)
    .set({ last_progress_at: now })
    .where(eq(user_deletion_requests.id, request.id));
}

export async function retryAttentionTask(params: {
  requestId: string;
  stepKey: UserDeletionStepKey;
  actorKiloUserId: string;
  reason: string;
}): Promise<boolean> {
  const reason = params.reason.trim();
  if (!reason) {
    throw new Error('Retry reason is required');
  }
  return db.transaction(async tx => {
    const [request] = await tx
      .select()
      .from(user_deletion_requests)
      .where(eq(user_deletion_requests.id, params.requestId))
      .for('update');
    if (
      !request ||
      request.status === UserDeletionRequestStatus.Completed ||
      request.status === UserDeletionRequestStatus.Cancelled
    ) {
      return false;
    }
    const [step] = await tx
      .select()
      .from(user_deletion_steps)
      .where(
        and(
          eq(user_deletion_steps.request_id, params.requestId),
          eq(user_deletion_steps.step_key, params.stepKey)
        )
      )
      .for('update');
    if (
      !step ||
      (step.status !== UserDeletionStepStatus.NeedsAttention &&
        step.status !== UserDeletionStepStatus.ManualActionRequired)
    ) {
      return false;
    }
    await tx
      .update(user_deletion_steps)
      .set({
        status: UserDeletionStepStatus.Pending,
        available_at: sql`now()`,
        window_attempt_count: 0,
        last_error_code: null,
        claim_token: null,
        claimed_until: null,
        rate_limited_since: null,
      })
      .where(eq(user_deletion_steps.id, step.id));
    await writeDeletionAudit(tx, {
      requestId: params.requestId,
      eventType: UserDeletionAuditEventType.ManualRetry,
      actorKiloUserId: params.actorKiloUserId,
      targetEmailHmac: request.target_email_hmac,
      subjectKey: `${params.stepKey}:${crypto.randomUUID()}`,
      details: { step_key: params.stepKey, code: 'manual_retry' },
    });
    await writeDeletionActivity(tx, {
      requestId: params.requestId,
      stepKey: params.stepKey,
      eventType: 'manual_retry',
      details: { error_code: 'manual_retry' },
    });
    return true;
  });
}

export async function retryBlockedPreflight(params: {
  requestId: string;
  actorKiloUserId: string;
  reason: string;
}): Promise<boolean> {
  if (!params.reason.trim()) {
    throw new Error('Retry reason is required');
  }
  return db.transaction(async tx => {
    const [request] = await tx
      .select()
      .from(user_deletion_requests)
      .where(eq(user_deletion_requests.id, params.requestId))
      .for('update');
    if (
      !request ||
      request.status !== UserDeletionRequestStatus.Pending ||
      !request.preflight_attention_code
    ) {
      return false;
    }
    await tx
      .update(user_deletion_requests)
      .set({
        preflight_attention_code: null,
        last_progress_at: sql`now()`,
      })
      .where(eq(user_deletion_requests.id, params.requestId));
    await writeDeletionAudit(tx, {
      requestId: params.requestId,
      eventType: UserDeletionAuditEventType.ManualRetry,
      actorKiloUserId: params.actorKiloUserId,
      targetEmailHmac: request.target_email_hmac,
      subjectKey: `preflight:${crypto.randomUUID()}`,
      details: { code: 'preflight_retry' },
    });
    await writeDeletionActivity(tx, {
      requestId: params.requestId,
      eventType: 'manual_retry',
      details: { error_code: 'preflight_retry' },
    });
    return true;
  });
}

export type PersistPreflightOutcomeResult =
  | { kind: 'applied'; outcome: DeletionPreflightOutcome }
  | { kind: 'skipped'; reason: 'not_found' | 'not_pending' | 'already_blocked' };

export async function persistPreflightOutcomeTx(
  tx: DrizzleTransaction,
  request: UserDeletionRequest,
  outcome: DeletionPreflightOutcome
): Promise<PersistPreflightOutcomeResult> {
  if (outcome.kind === 'skipped') {
    return { kind: 'skipped', reason: outcome.reason };
  }

  if (outcome.kind === 'needs_attention') {
    await tx
      .update(user_deletion_requests)
      .set({
        preflight_attention_code: outcome.errorCode,
        last_progress_at: sql`now()`,
      })
      .where(eq(user_deletion_requests.id, request.id));
    await writeDeletionAudit(tx, {
      requestId: request.id,
      eventType: UserDeletionAuditEventType.PreflightDisposition,
      actorKiloUserId: request.requested_by_kilo_user_id,
      targetEmailHmac: request.target_email_hmac,
      subjectKey: `preflight:${outcome.errorCode}:${crypto.randomUUID()}`,
      details: { disposition: 'needs_attention', code: outcome.errorCode },
    });
    await writeDeletionActivity(tx, {
      requestId: request.id,
      eventType: 'preflight_needs_attention',
      details: { error_code: outcome.errorCode },
    });
    return { kind: 'applied', outcome };
  }

  const adoptedUserId = outcome.adoptedUserId;
  if (adoptedUserId) {
    await disableUserAccessForDeletion(tx, {
      userId: adoptedUserId,
      requestedByKiloUserId: request.requested_by_kilo_user_id,
      nowIso: new Date().toISOString(),
    });
  }

  const resolution = adoptedUserId
    ? UserDeletionCloudSubjectResolution.CurrentUser
    : request.cloud_subject_resolution;

  await writeDeletionAudit(tx, {
    requestId: request.id,
    eventType: adoptedUserId
      ? UserDeletionAuditEventType.AccessDisabled
      : UserDeletionAuditEventType.AccessAbsent,
    actorKiloUserId: request.requested_by_kilo_user_id,
    targetEmailHmac: request.target_email_hmac,
    subjectKey: 'request',
    details: { code: adoptedUserId ? 'access_disabled' : 'access_absent' },
  });

  await tx
    .update(user_deletion_requests)
    .set({
      status: UserDeletionRequestStatus.InProgress,
      user_id: adoptedUserId ?? request.user_id,
      cloud_subject_resolution: resolution,
      last_progress_at: sql`now()`,
      preflight_attention_code: null,
    })
    .where(eq(user_deletion_requests.id, request.id));

  return { kind: 'applied', outcome };
}

export async function persistRejectedPreflight(requestId: string): Promise<boolean> {
  return db.transaction(async tx => {
    const [request] = await tx
      .select()
      .from(user_deletion_requests)
      .where(eq(user_deletion_requests.id, requestId))
      .for('update');
    if (!request || request.status !== UserDeletionRequestStatus.Pending) {
      return false;
    }
    if (request.preflight_attention_code) {
      return false;
    }
    const result = await persistPreflightOutcomeTx(tx, request, {
      kind: 'needs_attention',
      errorCode: 'preflight_throw',
    });
    return result.kind === 'applied';
  });
}

export async function markTaskManuallyVerified(params: {
  requestId: string;
  stepKey: UserDeletionStepKey;
  actorKiloUserId: string;
  reason: string;
  evidence: string;
}): Promise<boolean> {
  const reason = params.reason.trim();
  const evidence = params.evidence.trim();
  if (!reason || !evidence) {
    throw new Error('Manual verification requires reason and evidence');
  }
  if (/@/.test(reason) || /@/.test(evidence)) {
    throw new Error('Manual verification evidence must not contain email addresses');
  }
  const marked = await db.transaction(async tx => {
    const [request] = await tx
      .select()
      .from(user_deletion_requests)
      .where(eq(user_deletion_requests.id, params.requestId))
      .for('update');
    if (
      !request ||
      request.status === UserDeletionRequestStatus.Completed ||
      request.status === UserDeletionRequestStatus.Cancelled
    ) {
      return false;
    }
    const entry = catalogEntryFor(request.catalog_version, params.stepKey);
    if (!entry.allowsManualVerification) return false;
    const [step] = await tx
      .select()
      .from(user_deletion_steps)
      .where(
        and(
          eq(user_deletion_steps.request_id, params.requestId),
          eq(user_deletion_steps.step_key, params.stepKey)
        )
      )
      .for('update');
    if (
      !step ||
      (step.status !== UserDeletionStepStatus.NeedsAttention &&
        step.status !== UserDeletionStepStatus.ManualActionRequired)
    ) {
      return false;
    }
    const manual: UserDeletionManualEvidence = {
      reason,
      evidence,
      actor_kilo_user_id: params.actorKiloUserId,
      recorded_at: new Date().toISOString(),
    };
    await tx
      .update(user_deletion_steps)
      .set({
        status: UserDeletionStepStatus.ManuallyVerified,
        claim_token: null,
        claimed_until: null,
        last_error_code: null,
        manual_evidence_json: manual,
      })
      .where(eq(user_deletion_steps.id, step.id));
    await writeDeletionAudit(tx, {
      requestId: params.requestId,
      eventType: UserDeletionAuditEventType.ManualAction,
      actorKiloUserId: params.actorKiloUserId,
      targetEmailHmac: request.target_email_hmac,
      subjectKey: `${params.stepKey}:manually_verified`,
      details: { step_key: params.stepKey, disposition: 'manually_verified' },
    });
    return true;
  });
  if (marked) {
    await advanceDeletionGates(params.requestId);
  }
  return marked;
}

async function moveToAttention(
  tx: DrizzleTransaction,
  params: {
    stepId: string;
    requestId: string;
    stepKey: UserDeletionStepKey;
    hmac: string;
    errorCode: string;
    resourceHmac?: string;
    windowAttempt: number;
    lifetimeAttempt: number;
    rateLimitedSince?: string | null;
  }
): Promise<void> {
  await tx
    .update(user_deletion_steps)
    .set({
      status: UserDeletionStepStatus.NeedsAttention,
      claim_token: null,
      claimed_until: null,
      window_attempt_count: params.windowAttempt,
      lifetime_attempt_count: params.lifetimeAttempt,
      last_error_code: params.errorCode,
      rate_limited_since: params.rateLimitedSince ?? null,
    })
    .where(eq(user_deletion_steps.id, params.stepId));
  await writeDeletionAudit(tx, {
    requestId: params.requestId,
    eventType: UserDeletionAuditEventType.TaskDisposition,
    targetEmailHmac: params.hmac,
    subjectKey: `${params.stepKey}:needs_attention`,
    details: { step_key: params.stepKey, disposition: 'needs_attention', code: params.errorCode },
  });
  await writeDeletionActivity(tx, {
    requestId: params.requestId,
    stepKey: params.stepKey,
    eventType: 'needs_attention',
    details: { error_code: params.errorCode, resource_hmac: params.resourceHmac },
  });
}
