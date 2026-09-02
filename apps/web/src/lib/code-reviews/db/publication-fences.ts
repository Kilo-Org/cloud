import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { INTERNAL_API_SECRET } from '@/lib/config.server';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import {
  cloud_agent_code_reviews,
  cloud_agent_code_review_attempts,
  kilocode_users,
  platform_integrations,
  type CloudAgentCodeReviewAttempt,
  type CodeReviewPublicationFence,
} from '@kilocode/db/schema';
import {
  QueuedIsolateGateAuthorizationSchema,
  type CodeReviewPublicationState,
  type IsolateWebFinalization,
} from '@kilocode/db/schema-types';
import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { STALE_QUEUED_CODE_REVIEW_MINUTES } from '../dispatch/dispatch-constants';
import {
  GithubPublicationTargetSchema,
  IsolateWebPublicationSchema,
  QueuedIsolateIdentitySchema,
  QueuedIsolatePreparationBindingSchema,
  QueuedIsolateResultSchema,
  QueuedIsolateSafetySchema,
  QueuedIsolateUsageSettlementSchema,
  sameQueuedIsolateIdentity,
  type QueuedIsolateIdentity,
  type QueuedIsolateSafety,
} from '../queued-isolate-contract';
import { pinCodeReviewAttemptReviewer } from './code-reviews';

type PublicationTarget = QueuedIsolateIdentity['target'];

const CodeReviewPublicationStateSchema = z
  .object({
    identity: QueuedIsolateIdentitySchema,
    safety: QueuedIsolateSafetySchema.nullable(),
    preparation: QueuedIsolatePreparationBindingSchema.nullable(),
    gate_authorization: QueuedIsolateGateAuthorizationSchema.nullable(),
    terminal_result: QueuedIsolateResultSchema.nullable(),
    usage_settlement: QueuedIsolateUsageSettlementSchema.nullable(),
    web_publications: z.array(IsolateWebPublicationSchema),
    authorized_operation_ids: z.array(z.uuid()),
    identity_digest: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    identity_cleanup_requested: z.boolean(),
    canonical_settled_at: z.iso.datetime().nullable(),
    queue_wakeup_at: z.iso.datetime().nullable(),
    web_finalization: z.enum(['pending', 'uncertain', 'settled', 'suppressed']),
    released_at: z.iso.datetime().nullable(),
  })
  .strict() satisfies z.ZodType<CodeReviewPublicationState>;

export function createCodeReviewPublicationState(
  identity: QueuedIsolateIdentity
): CodeReviewPublicationState {
  return {
    identity: QueuedIsolateIdentitySchema.parse(identity),
    safety: null,
    preparation: null,
    gate_authorization: null,
    terminal_result: null,
    usage_settlement: null,
    web_publications: [],
    authorized_operation_ids: [],
    identity_digest: null,
    identity_cleanup_requested: false,
    canonical_settled_at: null,
    queue_wakeup_at: null,
    web_finalization: 'pending',
    released_at: null,
  };
}

export function publicationFromAttempt(
  attempt: CloudAgentCodeReviewAttempt
): CodeReviewPublicationFence | null {
  if (!attempt.publication_state) return null;
  const state = CodeReviewPublicationStateSchema.parse(attempt.publication_state);
  if (state.identity.attemptId !== attempt.id || state.identity.reviewId !== attempt.code_review_id)
    throw new Error('Isolate publication fence identity mismatch');
  return {
    ...state,
    generation: state.identity.generation,
    code_review_id: attempt.code_review_id,
    attempt_id: attempt.id,
    repo_full_name: state.identity.target.repoFullName,
    pr_number: state.identity.target.prNumber,
    created_at: new Date(attempt.reviewer_selected_at ?? attempt.created_at).toISOString(),
    updated_at: new Date(attempt.updated_at).toISOString(),
  };
}

export async function lockCodeReviewPublicationTarget(
  tx: DrizzleTransaction,
  target: PublicationTarget
): Promise<void> {
  const parsed = GithubPublicationTargetSchema.parse(target);
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`code-review-publication:${parsed.host}:${parsed.repoFullName}:${parsed.prNumber}`}, 0))`
  );
}

export async function getActiveCodeReviewPublicationFence(
  tx: DrizzleTransaction,
  target: PublicationTarget
): Promise<CodeReviewPublicationFence | null> {
  const parsed = GithubPublicationTargetSchema.parse(target);
  const [attempt] = await tx
    .select()
    .from(cloud_agent_code_review_attempts)
    .where(
      and(
        isNotNull(cloud_agent_code_review_attempts.publication_state),
        sql`lower(${cloud_agent_code_review_attempts.publication_state}->'identity'->'target'->>'repoFullName') = ${parsed.repoFullName}`,
        sql`${cloud_agent_code_review_attempts.publication_state}->'identity'->'target'->>'prNumber' = ${String(parsed.prNumber)}`,
        sql`${cloud_agent_code_review_attempts.publication_state}->>'released_at' IS NULL`
      )
    );
  return attempt ? publicationFromAttempt(attempt) : null;
}

export async function blockCodeReviewOnPublicationFence(
  tx: DrizzleTransaction,
  params: {
    reviewId: string;
    attemptId: string;
    dispatchReservationId: string;
    target: PublicationTarget;
  }
): Promise<CodeReviewPublicationFence | null> {
  await lockCodeReviewPublicationTarget(tx, params.target);
  const [review] = await tx
    .select()
    .from(cloud_agent_code_reviews)
    .where(eq(cloud_agent_code_reviews.id, params.reviewId))
    .for('update');
  if (
    !review ||
    review.status !== 'queued' ||
    review.dispatch_reservation_id !== params.dispatchReservationId ||
    review.platform !== 'github' ||
    review.repo_full_name.toLowerCase() !== params.target.repoFullName ||
    review.pr_number !== params.target.prNumber ||
    (review.manual_config && review.manual_config.outputMode !== 'provider')
  ) {
    throw new Error('Publication successor does not match its reservation and target');
  }
  const fence = await getActiveCodeReviewPublicationFence(tx, params.target);
  if (
    !fence ||
    (fence.code_review_id === params.reviewId && fence.attempt_id === params.attemptId)
  ) {
    if (review.blocked_by_attempt_id !== null) {
      await tx
        .update(cloud_agent_code_reviews)
        .set({ blocked_by_attempt_id: null })
        .where(eq(cloud_agent_code_reviews.id, review.id));
    }
    return null;
  }
  await tx
    .update(cloud_agent_code_reviews)
    .set({
      blocked_by_attempt_id: fence.attempt_id,
      status: 'pending',
      dispatch_reservation_id: null,
    })
    .where(eq(cloud_agent_code_reviews.id, review.id));
  return fence;
}

export async function acquireIsolatePublicationFence(params: {
  identity: QueuedIsolateIdentity;
  dispatchReservationId: string;
}): Promise<
  { outcome: 'acquired' | 'blocked'; fence: CodeReviewPublicationFence } | { outcome: 'legacy' }
> {
  const identity = QueuedIsolateIdentitySchema.parse(params.identity);
  return db.transaction(async tx => {
    const [user] = await tx
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(
        and(
          eq(kilocode_users.id, identity.executionUserId),
          isNull(kilocode_users.blocked_reason),
          isNull(kilocode_users.blocked_at)
        )
      )
      .for('share');
    if (!user)
      throw new Error('Isolate publication fence identity mismatch: execution user is unavailable');
    await lockCodeReviewPublicationTarget(tx, identity.target);
    const [review] = await tx
      .select()
      .from(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.id, identity.reviewId))
      .for('update');
    if (
      !review ||
      review.platform !== 'github' ||
      review.review_type !== 'standard' ||
      review.owned_by_organization_id !== identity.organizationId ||
      review.platform_integration_id !== identity.integrationId ||
      review.repo_full_name.toLowerCase() !== identity.target.repoFullName ||
      review.pr_number !== identity.target.prNumber ||
      review.head_sha.toLowerCase() !== identity.snapshot.headSha ||
      (review.manual_config && review.manual_config.outputMode !== 'provider')
    ) {
      throw new Error('Isolate publication identity does not match the canonical review');
    }
    if (
      review.status !== 'queued' ||
      review.dispatch_reservation_id !== params.dispatchReservationId
    ) {
      throw new Error('Code review dispatch reservation changed');
    }
    const [existingAttempt] = await tx
      .select()
      .from(cloud_agent_code_review_attempts)
      .where(eq(cloud_agent_code_review_attempts.id, identity.attemptId));
    const existing = existingAttempt ? publicationFromAttempt(existingAttempt) : null;
    if (existing) {
      assertFenceIdentity(existing, identity);
      if (existing.released_at) throw new Error('Isolate publication fence is already released');
      const { attempt } = await pinCodeReviewAttemptReviewer(tx, {
        codeReviewId: identity.reviewId,
        attemptId: identity.attemptId,
        dispatchReservationId: params.dispatchReservationId,
        backend: 'isolate',
      });
      if (attempt.reviewer_backend !== 'isolate') {
        throw new Error('Isolate publication fence affinity mismatch');
      }
      return { outcome: 'acquired', fence: existing };
    }
    const blocker = await blockCodeReviewOnPublicationFence(tx, {
      reviewId: identity.reviewId,
      attemptId: identity.attemptId,
      dispatchReservationId: params.dispatchReservationId,
      target: identity.target,
    });
    if (blocker) return { outcome: 'blocked', fence: blocker };

    const { attempt } = await pinCodeReviewAttemptReviewer(tx, {
      codeReviewId: identity.reviewId,
      attemptId: identity.attemptId,
      dispatchReservationId: params.dispatchReservationId,
      backend: 'isolate',
    });
    if (attempt.reviewer_backend === 'legacy') return { outcome: 'legacy' };
    let gateAuthorization = null;
    if (review.check_run_id) {
      const [integration] = await tx
        .select()
        .from(platform_integrations)
        .where(
          and(
            eq(platform_integrations.id, identity.integrationId),
            eq(platform_integrations.owned_by_organization_id, identity.organizationId),
            isNull(platform_integrations.owned_by_user_id),
            eq(platform_integrations.platform, 'github'),
            eq(platform_integrations.integration_status, 'active'),
            isNull(platform_integrations.auth_invalid_at)
          )
        );
      if (!integration || (integration.github_app_type ?? 'standard') !== 'standard')
        throw new Error('Isolate gate integration is unavailable');
      gateAuthorization = QueuedIsolateGateAuthorizationSchema.parse({
        installationId: integration.platform_installation_id,
        checkRunId: review.check_run_id,
      });
    }
    const [initialized] = await tx
      .update(cloud_agent_code_review_attempts)
      .set({
        publication_state: {
          ...createCodeReviewPublicationState(identity),
          gate_authorization: gateAuthorization,
        },
      })
      .where(eq(cloud_agent_code_review_attempts.id, attempt.id))
      .returning();
    const fence = initialized ? publicationFromAttempt(initialized) : null;
    if (!fence) throw new Error('Failed to acquire isolate publication fence');
    return { outcome: 'acquired', fence };
  });
}

export function isolateIdentityDigest(identity: QueuedIsolateIdentity) {
  if (!INTERNAL_API_SECRET) throw new Error('Isolate identity retention secret is unavailable');
  return createHmac('sha256', INTERNAL_API_SECRET)
    .update('queued-isolate-identity-retention:')
    .update(JSON.stringify(QueuedIsolateIdentitySchema.parse(identity)))
    .digest('hex');
}

export function assertFenceIdentity(
  fence: CodeReviewPublicationFence,
  identity: QueuedIsolateIdentity
) {
  const matches =
    fence.identity_cleanup_requested && fence.released_at
      ? fence.identity_digest === isolateIdentityDigest(identity)
      : sameQueuedIsolateIdentity(QueuedIsolateIdentitySchema.parse(fence.identity), identity);
  if (!matches) throw new Error('Isolate publication fence identity mismatch');
}

async function lockPublicationState(tx: DrizzleTransaction, identity: QueuedIsolateIdentity) {
  await lockCodeReviewPublicationTarget(tx, identity.target);
  await tx
    .select({ id: cloud_agent_code_reviews.id })
    .from(cloud_agent_code_reviews)
    .where(eq(cloud_agent_code_reviews.id, identity.reviewId))
    .for('update');
  const [attempt] = await tx
    .select()
    .from(cloud_agent_code_review_attempts)
    .where(
      and(
        eq(cloud_agent_code_review_attempts.id, identity.attemptId),
        eq(cloud_agent_code_review_attempts.code_review_id, identity.reviewId),
        sql`${cloud_agent_code_review_attempts.publication_state}->'identity'->>'generation' = ${identity.generation}`
      )
    )
    .for('update');
  const fence = attempt ? publicationFromAttempt(attempt) : null;
  if (!fence) throw new Error('Isolate publication fence not found');
  return fence;
}

export async function lockMatchingFence(tx: DrizzleTransaction, input: QueuedIsolateIdentity) {
  const identity = QueuedIsolateIdentitySchema.parse(input);
  const fence = await lockPublicationState(tx, identity);
  assertFenceIdentity(fence, identity);
  return fence;
}

export async function updateIsolatePublicationOn(
  tx: DrizzleTransaction,
  input: QueuedIsolateIdentity,
  patch: Partial<CodeReviewPublicationState>
): Promise<CodeReviewPublicationFence> {
  const identity = QueuedIsolateIdentitySchema.parse(input);
  const updates = CodeReviewPublicationStateSchema.partial().parse(patch);
  const fence = await lockPublicationState(tx, identity);
  const retainedIdentityWakeup =
    fence.released_at &&
    fence.identity_cleanup_requested &&
    fence.identity_digest &&
    fence.identity.executionUserId === 'deleted' &&
    sameQueuedIsolateIdentity(fence.identity, identity) &&
    Object.keys(updates).every(key => key === 'queue_wakeup_at');
  if (!retainedIdentityWakeup) assertFenceIdentity(fence, identity);
  if (
    (updates.identity && !sameQueuedIsolateIdentity(fence.identity, updates.identity)) ||
    (updates.identity_digest !== undefined && updates.identity_digest !== fence.identity_digest) ||
    (fence.identity_cleanup_requested && updates.identity_cleanup_requested === false)
  ) {
    throw new Error('Isolate publication fence identity mismatch');
  }
  const next = { ...fence, ...updates };
  const cleanup = next.released_at ? isolateIdentityCleanup(next) : {};
  const [attempt] = await tx
    .update(cloud_agent_code_review_attempts)
    .set({
      publication_state: sql`${cloud_agent_code_review_attempts.publication_state} || ${JSON.stringify({ ...updates, ...cleanup })}::jsonb`,
      updated_at: new Date().toISOString(),
    })
    .where(eq(cloud_agent_code_review_attempts.id, identity.attemptId))
    .returning();
  const updated = attempt ? publicationFromAttempt(attempt) : null;
  if (!updated) throw new Error('Isolate publication fence not found');
  return updated;
}

export async function prepareIsolateRecoveryControl(
  identity: QueuedIsolateIdentity
): Promise<'status' | 'cancel' | null> {
  return db.transaction(async tx => {
    const fence = await lockMatchingFence(tx, identity);
    if (fence.released_at || fence.safety?.quiescent) return null;
    const [review] = await tx
      .select()
      .from(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.id, identity.reviewId))
      .for('update');
    const [attempt] = await tx
      .select()
      .from(cloud_agent_code_review_attempts)
      .where(eq(cloud_agent_code_review_attempts.code_review_id, identity.reviewId))
      .orderBy(desc(cloud_agent_code_review_attempts.attempt_number))
      .limit(1)
      .for('update');
    const active =
      review &&
      ['pending', 'queued', 'running'].includes(review.status) &&
      attempt?.id === identity.attemptId &&
      ['pending', 'queued', 'running'].includes(attempt.status);
    if (!active) return 'cancel';
    if (
      review.status === 'queued' &&
      review.dispatch_reservation_id &&
      new Date(review.updated_at).getTime() >=
        Date.now() - STALE_QUEUED_CODE_REVIEW_MINUTES * 60_000
    )
      return null;
    if (fence.preparation) return 'status';
    const completedAt = new Date().toISOString();
    const failure = {
      status: 'failed' as const,
      completed_at: completedAt,
      error_message: 'Isolate preparation reservation expired',
      terminal_reason: 'abandoned',
      updated_at: completedAt,
    };
    await tx
      .update(cloud_agent_code_reviews)
      .set({ ...failure, dispatch_reservation_id: null })
      .where(eq(cloud_agent_code_reviews.id, identity.reviewId));
    await tx
      .update(cloud_agent_code_review_attempts)
      .set(failure)
      .where(eq(cloud_agent_code_review_attempts.id, identity.attemptId));
    return 'cancel';
  });
}

export async function recordIsolatePublicationSafety(params: {
  identity: QueuedIsolateIdentity;
  safety: QueuedIsolateSafety;
}): Promise<'recorded' | 'duplicate' | 'stale'> {
  return db.transaction(tx => recordIsolatePublicationSafetyOn(tx, params));
}

export async function recordIsolatePublicationSafetyOn(
  tx: DrizzleTransaction,
  params: {
    identity: QueuedIsolateIdentity;
    safety: QueuedIsolateSafety;
  }
): Promise<'recorded' | 'duplicate' | 'stale'> {
  const identity = QueuedIsolateIdentitySchema.parse(params.identity);
  const safety = QueuedIsolateSafetySchema.parse(params.safety);
  const fence = await lockMatchingFence(tx, identity);
  const previous = fence.safety ? QueuedIsolateSafetySchema.parse(fence.safety) : null;
  if (previous) {
    if (safety.sequence < previous.sequence) return 'stale';
    if (safety.sequence === previous.sequence) {
      if (JSON.stringify(previous) !== JSON.stringify(safety)) {
        throw new Error('Conflicting isolate safety notification');
      }
      return 'duplicate';
    }
    if (
      (previous.quiescent && !safety.quiescent) ||
      (previous.cancellationRequested && !safety.cancellationRequested) ||
      (['completed', 'failed', 'cancelled'].includes(previous.execution) &&
        safety.execution !== previous.execution) ||
      (previous.execution === 'running' && safety.execution === 'not_started') ||
      (['completed', 'failed', 'cancelled'].includes(previous.execution) &&
        previous.publication === 'settled' &&
        safety.publication !== 'settled') ||
      (previous.publication !== 'not_started' && safety.publication === 'not_started')
    ) {
      throw new Error('Isolate safety notification regresses retained evidence');
    }
  }
  if (fence.released_at) throw new Error('Isolate publication fence is already released');
  await updateIsolatePublicationOn(tx, identity, { safety });
  return 'recorded';
}

export async function setIsolateWebFinalization(params: {
  identity: QueuedIsolateIdentity;
  expected: IsolateWebFinalization;
  state: IsolateWebFinalization;
}): Promise<boolean> {
  const identity = QueuedIsolateIdentitySchema.parse(params.identity);
  return db.transaction(async tx => {
    const fence = await lockMatchingFence(tx, identity);
    if (fence.web_finalization === params.state) return true;
    if (fence.released_at || fence.web_finalization !== params.expected) return false;
    if (
      params.expected === 'settled' ||
      params.expected === 'suppressed' ||
      params.state === 'pending' ||
      (params.expected === 'uncertain' && params.state !== 'settled')
    ) {
      throw new Error('Cannot discard unresolved web publication evidence');
    }
    await updateIsolatePublicationOn(tx, identity, { web_finalization: params.state });
    return true;
  });
}

function isolateIdentityCleanup(fence: CodeReviewPublicationFence) {
  return fence.identity_cleanup_requested
    ? {
        identity_digest: fence.identity_digest ?? isolateIdentityDigest(fence.identity),
        identity: { ...fence.identity, executionUserId: 'deleted' },
        terminal_result: null,
        usage_settlement: null,
        gate_authorization: null,
        web_publications: fence.web_publications.map(operation => ({
          ...operation,
          body: undefined,
        })),
      }
    : {};
}

export async function requestIsolateIdentityCleanup(tx: DrizzleTransaction, userId: string) {
  const attempts = await tx
    .select()
    .from(cloud_agent_code_review_attempts)
    .where(
      and(
        isNotNull(cloud_agent_code_review_attempts.publication_state),
        sql`${cloud_agent_code_review_attempts.publication_state}->'identity'->>'executionUserId' = ${userId}`
      )
    )
    .orderBy(cloud_agent_code_review_attempts.id);
  for (const attempt of attempts) {
    const fence = publicationFromAttempt(attempt);
    if (fence)
      await updateIsolatePublicationOn(tx, fence.identity, { identity_cleanup_requested: true });
  }
}

export async function releaseIsolatePublicationFence(
  input: QueuedIsolateIdentity
): Promise<boolean> {
  const identity = QueuedIsolateIdentitySchema.parse(input);
  return db.transaction(async tx => {
    const fence = await lockMatchingFence(tx, identity);
    if (fence.released_at) return true;
    const safety = fence.safety ? QueuedIsolateSafetySchema.parse(fence.safety) : null;
    if (
      !safety?.quiescent ||
      (fence.web_finalization !== 'settled' && fence.web_finalization !== 'suppressed') ||
      fence.web_publications.some(
        operation => operation.state === 'sent' || operation.state === 'prepared'
      )
    ) {
      return false;
    }
    await updateIsolatePublicationOn(tx, identity, { released_at: new Date().toISOString() });
    return true;
  });
}
