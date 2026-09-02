import 'server-only';

import { createHash } from 'node:crypto';
import { Octokit } from '@octokit/rest';
import { NextResponse, type NextRequest } from 'next/server';
import { and, desc, eq, gte, inArray, isNull, lte, sql, sum } from 'drizzle-orm';
import { z } from 'zod';
import { verifyCallbackToken } from '@kilocode/worker-utils/callback-token';
import {
  cloud_agent_code_reviews,
  cloud_agent_code_review_attempts,
  code_review_analytics_results,
  code_review_analytics_findings,
  kilocode_users,
  organization_memberships,
  organizations,
  platform_integrations,
  microdollar_usage,
  microdollar_usage_metadata,
  type CodeReviewPublicationFence,
} from '@kilocode/db/schema';
import {
  QueuedIsolateGateAuthorizationSchema,
  type IsolateWebPublication,
} from '@kilocode/db/schema-types';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import { INTERNAL_API_SECRET } from '@/lib/config.server';
import { getUnblockedBotUserForOrg } from '@/lib/bot-users/bot-user-service';
import { generateGitHubInstallationToken } from '@/lib/integrations/platforms/github/adapter';
import {
  getGitHubAppCredentials,
  getGitHubAppName,
} from '@/lib/integrations/platforms/github/app-selector';
import {
  IsolateReviewRequestSchema,
  type IsolateReviewRequest,
} from '@/lib/isolate-review-worker-client';
import { settleCodeReviewLedgerRowOn } from './code-review-ledger';
import { parseCodeReviewAnalyticsManifest } from './analytics/contracts';
import {
  assertFenceIdentity,
  lockMatchingFence,
  publicationFromAttempt,
  recordIsolatePublicationSafetyOn,
  releaseIsolatePublicationFence,
  updateIsolatePublicationOn,
} from './db/publication-fences';
import {
  QueuedIsolateIdentitySchema,
  QueuedIsolateAuthorityRequestSchema,
  QueuedIsolateNotificationSchema,
  QueuedIsolatePreparationBindingSchema,
  QueuedIsolateResultSchema,
  QueuedIsolateUsageSettlementSchema,
  IsolateWebPublicationSchema,
  type QueuedIsolateIdentity,
} from './queued-isolate-contract';
import { appendReviewSummaryFooter } from './summary/usage-footer';
import {
  disableCodeReviewForActionRequiredFailureOn,
  getCodeReviewActionRequiredCopy,
  isCodeReviewActionRequiredReason,
  sendAndMarkActionRequiredEmailNotifications,
} from './action-required';
import { getManualCodeReviewConfig } from './manual-config';
import type { TryDispatchPendingReviewsOptions } from './dispatch/dispatch-pending-reviews';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const activeStatuses = ['pending', 'queued', 'running'];
const terminalStatuses = ['completed', 'failed', 'cancelled'];
type Notification = z.infer<typeof QueuedIsolateNotificationSchema>;

async function canonicalState(tx: DrizzleTransaction, identity: QueuedIsolateIdentity) {
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
  const matching = Boolean(
    review &&
    attempt &&
    attempt.id === identity.attemptId &&
    attempt.reviewer_backend === 'isolate' &&
    attempt.reviewer_execution_id === identity.attemptId &&
    review.platform === 'github' &&
    review.review_type === 'standard' &&
    review.owned_by_organization_id === identity.organizationId &&
    review.owned_by_user_id === null &&
    review.platform_integration_id === identity.integrationId &&
    review.repo_full_name.toLowerCase() === identity.target.repoFullName &&
    review.pr_number === identity.target.prNumber &&
    review.head_sha === identity.snapshot.headSha &&
    (!review.manual_config || review.manual_config.outputMode === 'provider')
  );
  return { review, attempt, matching };
}

async function assertIsolateAttempt(tx: DrizzleTransaction, identity: QueuedIsolateIdentity) {
  const [attempt] = await tx
    .select({ id: cloud_agent_code_review_attempts.id })
    .from(cloud_agent_code_review_attempts)
    .where(
      and(
        eq(cloud_agent_code_review_attempts.id, identity.attemptId),
        eq(cloud_agent_code_review_attempts.code_review_id, identity.reviewId),
        eq(cloud_agent_code_review_attempts.reviewer_backend, 'isolate'),
        eq(cloud_agent_code_review_attempts.reviewer_execution_id, identity.attemptId)
      )
    );
  if (!attempt) throw new Error('Isolate attempt affinity mismatch');
}

async function authorizedIntegration(tx: DrizzleTransaction, identity: QueuedIsolateIdentity) {
  const [integration] = await tx
    .select()
    .from(platform_integrations)
    .innerJoin(organizations, eq(organizations.id, platform_integrations.owned_by_organization_id))
    .where(
      and(
        eq(platform_integrations.id, identity.integrationId),
        eq(platform_integrations.owned_by_organization_id, identity.organizationId),
        isNull(platform_integrations.owned_by_user_id),
        eq(platform_integrations.platform, 'github'),
        eq(platform_integrations.integration_status, 'active'),
        isNull(platform_integrations.auth_invalid_at),
        isNull(organizations.deleted_at)
      )
    );
  const value = integration?.platform_integrations;
  return value &&
    (value.github_app_type ?? 'standard') === 'standard' &&
    value.platform_installation_id
    ? value
    : null;
}

async function authorizedExecutionUser(tx: DrizzleTransaction, identity: QueuedIsolateIdentity) {
  const [user] = await tx
    .select({ id: kilocode_users.id })
    .from(kilocode_users)
    .innerJoin(
      organization_memberships,
      and(
        eq(organization_memberships.kilo_user_id, kilocode_users.id),
        eq(organization_memberships.organization_id, identity.organizationId)
      )
    )
    .where(
      and(
        eq(kilocode_users.id, identity.executionUserId),
        isNull(kilocode_users.blocked_at),
        isNull(kilocode_users.blocked_reason)
      )
    );
  return Boolean(user);
}

export async function bindQueuedIsolatePreparation(
  identity: QueuedIsolateIdentity,
  input: IsolateReviewRequest
) {
  const review = IsolateReviewRequestSchema.parse(input);
  const preparation = review.preparation;
  if (
    review.dryRun !== false ||
    review.previousRunId ||
    (review.reviewMode ?? 'full') !== 'full' ||
    review.expectedAppType !== 'standard' ||
    preparation?.executionUserId !== identity.executionUserId ||
    review.organizationId !== identity.organizationId ||
    review.expectedIntegrationId !== identity.integrationId ||
    `${review.owner}/${review.repo}`.toLowerCase() !== identity.target.repoFullName ||
    review.pullNumber !== identity.target.prNumber ||
    review.headSha !== identity.snapshot.headSha ||
    review.baseTipSha !== identity.snapshot.baseTipSha ||
    review.mergeBaseSha !== identity.snapshot.mergeBaseSha
  )
    throw new Error('Preparation does not match the canonical snapshot and execution identity');
  if (
    !preparation?.queued ||
    JSON.stringify(QueuedIsolateIdentitySchema.parse(preparation.queued.identity)) !==
      JSON.stringify(QueuedIsolateIdentitySchema.parse(identity))
  )
    throw new Error('Preparation identity mismatch');
  const binding = QueuedIsolatePreparationBindingSchema.parse({
    hash: hash(JSON.stringify(review)),
    preparedAt: preparation.preparedAt,
    installationId: preparation.github.installationId,
    model: preparation.settings.model,
    gateThreshold: preparation.queued.gateThreshold,
    reviewGuidance: {
      used: Boolean(preparation.reviewInstructions),
      ref: preparation.reviewInstructions?.sha ?? null,
      truncated: preparation.reviewInstructions?.truncated ?? false,
    },
  });
  return db.transaction(async tx => {
    const fence = await lockMatchingFence(tx, identity);
    const canonical = await canonicalState(tx, identity);
    const integration = await authorizedIntegration(tx, identity);
    if (
      fence.released_at ||
      fence.identity_cleanup_requested ||
      !canonical.matching ||
      !activeStatuses.includes(canonical.review.status) ||
      !activeStatuses.includes(canonical.attempt.status) ||
      integration?.platform_installation_id !== binding.installationId ||
      !(await authorizedExecutionUser(tx, identity))
    )
      throw new Error('Preparation is no longer authorized');
    if (
      fence.preparation &&
      JSON.stringify(QueuedIsolatePreparationBindingSchema.parse(fence.preparation)) !==
        JSON.stringify(binding)
    )
      throw new Error('Attempt preparation is immutable');
    await updateIsolatePublicationOn(tx, identity, { preparation: binding });
    return binding;
  });
}

export async function authorizeQueuedIsolate(
  input: z.infer<typeof QueuedIsolateAuthorityRequestSchema>
) {
  const request = QueuedIsolateAuthorityRequestSchema.parse(input);
  const authorized = await db.transaction(async tx => {
    const { identity } = request;
    const fence = await lockMatchingFence(tx, identity);
    await assertIsolateAttempt(tx, identity);
    if (fence.released_at || fence.preparation?.hash !== request.preparationHash) return false;
    const integration = await authorizedIntegration(tx, identity);
    if (integration?.platform_installation_id !== fence.preparation.installationId) return false;
    if (request.operation === 'reconcile')
      return fence.authorized_operation_ids.includes(request.operationId);
    const canonical = await canonicalState(tx, identity);
    if (
      !canonical.matching ||
      !activeStatuses.includes(canonical.review.status) ||
      !activeStatuses.includes(canonical.attempt.status) ||
      fence.identity_cleanup_requested ||
      fence.safety?.cancellationRequested ||
      fence.safety?.quiescent ||
      (fence.safety && terminalStatuses.includes(fence.safety.execution)) ||
      !(await authorizedExecutionUser(tx, identity))
    )
      return false;
    if (request.operation === 'execute') return request.operationId === identity.attemptId;
    if (!fence.authorized_operation_ids.includes(request.operationId)) {
      if (fence.authorized_operation_ids.length >= 4) return false;
      await updateIsolatePublicationOn(tx, identity, {
        authorized_operation_ids: [...fence.authorized_operation_ids, request.operationId],
      });
    }
    return true;
  });
  if (authorized && request.operation === 'reconcile') {
    const bot = await getUnblockedBotUserForOrg(request.identity.organizationId, 'code-review');
    return bot
      ? { ...request, authorized: true, reconciliationUserId: bot.id }
      : { ...request, authorized: false };
  }
  return { ...request, authorized };
}

export async function getQueuedIsolateUsage(
  tx: DrizzleTransaction,
  identity: QueuedIsolateIdentity,
  result: z.infer<typeof QueuedIsolateResultSchema>,
  start: string
) {
  if (result.sessions.some(session => session.requestCount === undefined)) return { totals: null };
  const usageDeadline = Math.min(
    new Date(result.completedAt).getTime() + 24 * 60 * 60 * 1000,
    new Date(start).getTime() + 48 * 60 * 60 * 1000
  );
  const now = Date.now();
  const usageEnd = new Date(Math.min(now, usageDeadline)).toISOString();
  const records = await tx
    .select({
      sessionId: microdollar_usage_metadata.session_id,
      requests:
        sql<number>`count(*) filter (where ${microdollar_usage.model} is distinct from ${'auto-routing/classifier'})`.mapWith(
          Number
        ),
      tokensIn: sum(microdollar_usage.input_tokens).mapWith(Number),
      tokensOut: sum(microdollar_usage.output_tokens).mapWith(Number),
      cacheHit: sum(microdollar_usage.cache_hit_tokens).mapWith(Number),
      cacheWrite: sum(microdollar_usage.cache_write_tokens).mapWith(Number),
      cost: sum(microdollar_usage.cost).mapWith(Number),
    })
    .from(microdollar_usage)
    .innerJoin(microdollar_usage_metadata, eq(microdollar_usage.id, microdollar_usage_metadata.id))
    .where(
      and(
        eq(microdollar_usage.kilo_user_id, identity.executionUserId),
        eq(microdollar_usage.organization_id, identity.organizationId),
        inArray(
          microdollar_usage_metadata.session_id,
          result.sessions.map(session => session.sessionId)
        ),
        gte(microdollar_usage_metadata.created_at, start),
        lte(microdollar_usage_metadata.created_at, usageEnd),
        gte(microdollar_usage.created_at, start),
        lte(microdollar_usage.created_at, usageEnd)
      )
    )
    .groupBy(microdollar_usage_metadata.session_id);
  if (
    result.sessions.some(
      session =>
        (records.find(record => record.sessionId === session.sessionId)?.requests ?? 0) !==
        session.requestCount
    )
  )
    return now < usageDeadline
      ? null
      : QueuedIsolateUsageSettlementSchema.parse({
          totals: null,
          unavailableReason: 'billing_incomplete',
        });
  return QueuedIsolateUsageSettlementSchema.parse({
    totals: records.length
      ? records.reduce(
          (totals, record) => ({
            tokensIn: totals.tokensIn + (record.tokensIn ?? 0),
            tokensOut: totals.tokensOut + (record.tokensOut ?? 0),
            cacheHit: totals.cacheHit + (record.cacheHit ?? 0),
            cacheWrite: totals.cacheWrite + (record.cacheWrite ?? 0),
            cost: totals.cost + (record.cost ?? 0),
          }),
          { tokensIn: 0, tokensOut: 0, cacheHit: 0, cacheWrite: 0, cost: 0 }
        )
      : null,
  });
}

async function settleQueuedIsolateUsage(identity: QueuedIsolateIdentity) {
  await db.transaction(async tx => {
    const fence = await lockMatchingFence(tx, identity);
    if (fence.usage_settlement || fence.identity_cleanup_requested || !fence.terminal_result)
      return;
    const canonical = await canonicalState(tx, identity);
    const eligible =
      canonical.matching &&
      fence.canonical_settled_at &&
      canonical.review.terminal_reason !== 'superseded';
    const settlement =
      eligible && fence.preparation
        ? await getQueuedIsolateUsage(
            tx,
            identity,
            QueuedIsolateResultSchema.parse(fence.terminal_result),
            fence.preparation.preparedAt
          )
        : { totals: null };
    if (!settlement) return;
    if (eligible && settlement.totals) {
      await tx
        .update(cloud_agent_code_reviews)
        .set({
          total_tokens_in: settlement.totals.tokensIn,
          total_tokens_out: settlement.totals.tokensOut,
          total_cost_musd: settlement.totals.cost,
        })
        .where(eq(cloud_agent_code_reviews.id, identity.reviewId));
    }
    await updateIsolatePublicationOn(tx, identity, { usage_settlement: settlement });
  });
}

async function recordNotification(notification: Notification) {
  const { identity, safety, result } = notification;
  const actionRequiredNotification = await db.transaction(async tx => {
    const fence = await lockMatchingFence(tx, identity);
    await assertIsolateAttempt(tx, identity);
    const recorded = await recordIsolatePublicationSafetyOn(tx, { identity, safety });
    if (recorded === 'stale' || fence.released_at) return;
    if (
      fence.terminal_result &&
      result &&
      JSON.stringify(QueuedIsolateResultSchema.parse(fence.terminal_result)) !==
        JSON.stringify(result)
    )
      throw new Error('Terminal result is immutable');
    if (result) {
      const start = new Date(fence.preparation?.preparedAt ?? fence.created_at).getTime();
      const end = new Date(result.completedAt).getTime();
      if (end < start || end > Date.now() + 60_000)
        throw new Error('Invalid execution time bounds');
      await updateIsolatePublicationOn(tx, identity, { terminal_result: result });
    }
    const { review, attempt, matching } = await canonicalState(tx, identity);
    if (
      matching &&
      result &&
      !fence.canonical_settled_at &&
      terminalStatuses.includes(review.status)
    ) {
      await tx
        .update(cloud_agent_code_review_attempts)
        .set({
          status: review.status,
          terminal_reason: review.terminal_reason,
          completed_at: review.completed_at ?? result.completedAt,
        })
        .where(
          and(
            eq(cloud_agent_code_review_attempts.id, attempt.id),
            inArray(cloud_agent_code_review_attempts.status, activeStatuses)
          )
        );
      await settleCodeReviewLedgerRowOn(tx, {
        reviewId: review.id,
        status: review.status,
        terminalReason: review.terminal_reason,
        triggerSource: review.trigger_source,
      });
      if (review.terminal_reason !== 'superseded')
        await updateIsolatePublicationOn(tx, identity, {
          canonical_settled_at: new Date().toISOString(),
        });
      return;
    }
    if (
      !matching ||
      review.terminal_reason === 'superseded' ||
      fence.canonical_settled_at ||
      !activeStatuses.includes(review.status) ||
      !activeStatuses.includes(attempt.status)
    )
      return;
    if (!result) {
      if (safety.execution === 'running') {
        const now = new Date().toISOString();
        await tx
          .update(cloud_agent_code_reviews)
          .set({ status: 'running', started_at: review.started_at ?? now })
          .where(eq(cloud_agent_code_reviews.id, review.id));
        await tx
          .update(cloud_agent_code_review_attempts)
          .set({ status: 'running', started_at: attempt.started_at ?? now })
          .where(eq(cloud_agent_code_review_attempts.id, attempt.id));
      }
      return;
    }
    const binding = fence.preparation
      ? QueuedIsolatePreparationBindingSchema.parse(fence.preparation)
      : null;
    const validCompletion =
      binding &&
      result.summary &&
      safety.publication === 'settled' &&
      (binding.gateThreshold === 'off' || result.gateResult !== null);
    const status =
      safety.execution === 'completed'
        ? validCompletion
          ? 'completed'
          : 'failed'
        : safety.execution === 'cancelled'
          ? 'cancelled'
          : 'failed';
    const reason =
      safety.execution === 'completed' && !validCompletion
        ? 'publication_incomplete'
        : result.reason;
    await tx
      .update(cloud_agent_code_review_attempts)
      .set({
        status,
        terminal_reason: reason,
        completed_at: result.completedAt,
        error_message: status === 'failed' ? `Isolate review: ${reason}` : null,
      })
      .where(eq(cloud_agent_code_review_attempts.id, attempt.id));
    await tx
      .update(cloud_agent_code_reviews)
      .set({
        status,
        terminal_reason: reason,
        dispatch_reservation_id: null,
        completed_at: result.completedAt,
        error_message: status === 'failed' ? `Isolate review: ${reason}` : null,
        ...(binding
          ? {
              model: binding.model,
              repository_review_instructions_used: binding.reviewGuidance.used,
              repository_review_instructions_ref: binding.reviewGuidance.ref,
              repository_review_instructions_truncated: binding.reviewGuidance.truncated,
            }
          : {}),
      })
      .where(eq(cloud_agent_code_reviews.id, review.id));
    if (status === 'completed' && attempt.analytics_enabled_at_dispatch === true) {
      const capture = parseCodeReviewAnalyticsManifest(result.analytics.marker, {
        assistantTextWasOmitted: result.analytics.omitted,
      });
      const manifest = capture.status === 'captured' ? capture.manifest : null;
      const [analytics] = await tx
        .insert(code_review_analytics_results)
        .values({
          code_review_id: review.id,
          source_attempt_id: attempt.id,
          capture_status: capture.status,
          schema_version: manifest?.schemaVersion ?? 1,
          taxonomy_version: manifest?.taxonomyVersion ?? 1,
          change_type: manifest?.change.type ?? null,
          impact_level: manifest?.change.impact ?? null,
          complexity_level: manifest?.change.complexity ?? null,
          classification_confidence: manifest?.change.confidence ?? null,
          finalized_at: result.completedAt,
        })
        .onConflictDoNothing()
        .returning();
      if (analytics && manifest?.findings.length)
        await tx.insert(code_review_analytics_findings).values(
          manifest.findings.map((finding, ordinal) => ({
            analytics_result_id: analytics.id,
            ordinal,
            severity: finding.severity,
            category: finding.category,
            security_class: finding.securityClass,
          }))
        );
    }
    await settleCodeReviewLedgerRowOn(tx, {
      reviewId: review.id,
      status,
      terminalReason: reason,
      triggerSource: review.trigger_source,
    });
    const actionRequired =
      status === 'failed' &&
      isCodeReviewActionRequiredReason(reason) &&
      !fence.identity_cleanup_requested &&
      getManualCodeReviewConfig(review) === null
        ? {
            owner: {
              type: 'org' as const,
              id: identity.organizationId,
              userId: identity.executionUserId,
            },
            platform: 'github' as const,
            reviewId: review.id,
            reason,
          }
        : null;
    const shouldSendEmail = actionRequired
      ? await disableCodeReviewForActionRequiredFailureOn(tx, actionRequired)
      : false;
    await updateIsolatePublicationOn(tx, identity, {
      canonical_settled_at: new Date().toISOString(),
    });
    return shouldSendEmail ? actionRequired : null;
  });
  if (actionRequiredNotification)
    await sendAndMarkActionRequiredEmailNotifications(actionRequiredNotification, true);
}

async function readFence(identity: QueuedIsolateIdentity) {
  const [attempt] = await db
    .select()
    .from(cloud_agent_code_review_attempts)
    .where(
      and(
        eq(cloud_agent_code_review_attempts.id, identity.attemptId),
        eq(cloud_agent_code_review_attempts.code_review_id, identity.reviewId)
      )
    );
  const fence = attempt ? publicationFromAttempt(attempt) : null;
  if (!fence) throw new Error('Isolate fence not found');
  assertFenceIdentity(fence, identity);
  return fence;
}

function publicationInstallationId(
  fence: CodeReviewPublicationFence,
  operation?: IsolateWebPublication
) {
  if (fence.preparation) return fence.preparation.installationId;
  const gate = fence.gate_authorization
    ? QueuedIsolateGateAuthorizationSchema.parse(fence.gate_authorization)
    : null;
  if (
    operation &&
    (operation.kind !== 'gate' ||
      operation.targetId !== gate?.checkRunId ||
      operation.conclusion === 'success')
  )
    return undefined;
  return gate?.installationId;
}

async function publicationClient(
  identity: QueuedIsolateIdentity,
  fence: CodeReviewPublicationFence,
  operation?: IsolateWebPublication
) {
  const integration = await db.transaction(tx => authorizedIntegration(tx, identity));
  if (
    !integration ||
    integration.platform_installation_id !== publicationInstallationId(fence, operation)
  )
    throw new Error('Publication integration unavailable');
  const { token } = await generateGitHubInstallationToken(
    integration.platform_installation_id,
    'standard'
  );
  return new Octokit({ auth: token, request: { timeout: 10_000 } });
}

const CommentSchema = z.object({
  id: z.number().int().positive().safe(),
  body: z.string().max(70_000),
  issue_url: z.string(),
  user: z.object({ login: z.string(), type: z.literal('Bot') }),
  performed_via_github_app: z.object({ id: z.number() }),
});

function validComment(raw: unknown, identity: QueuedIsolateIdentity, id: number) {
  const parsed = CommentSchema.safeParse(raw);
  if (!parsed.success) return null;
  const comment = parsed.data;
  if (
    comment.id !== id ||
    !comment.body.startsWith('<!-- kilo-review -->') ||
    comment.issue_url.toLowerCase() !==
      `https://api.github.com/repos/${identity.target.repoFullName}/issues/${identity.target.prNumber}` ||
    comment.user.login.toLowerCase() !== `${getGitHubAppName('standard').toLowerCase()}[bot]` ||
    comment.performed_via_github_app.id !== Number(getGitHubAppCredentials('standard').appId)
  )
    return null;
  return comment;
}

async function readGithubResource<T>(read: () => Promise<{ data: T }>): Promise<T | null> {
  try {
    return (await read()).data;
  } catch (error) {
    const missing = z.object({ status: z.literal(404) }).safeParse(error);
    if (missing.success) return null;
    throw error;
  }
}

async function prepareWebPublications(
  identity: QueuedIsolateIdentity,
  fence: CodeReviewPublicationFence
) {
  if (
    !fence.safety?.quiescent ||
    !fence.terminal_result ||
    fence.web_finalization !== 'pending' ||
    fence.web_publications.length
  )
    return;
  const result = QueuedIsolateResultSchema.parse(fence.terminal_result);
  const operations: IsolateWebPublication[] = [];
  const eligible = await db.transaction(async tx => {
    const locked = await lockMatchingFence(tx, identity);
    const canonical = await canonicalState(tx, identity);
    const integration = await authorizedIntegration(tx, identity);
    return integration?.platform_installation_id === publicationInstallationId(locked) &&
      !locked.identity_cleanup_requested &&
      canonical.matching &&
      Boolean(locked.canonical_settled_at) &&
      canonical.review.terminal_reason !== 'superseded' &&
      (await authorizedExecutionUser(tx, identity))
      ? canonical.review
      : null;
  });
  if (
    eligible &&
    (fence.preparation ||
      (['failed', 'cancelled'].includes(eligible.status) &&
        eligible.check_run_id === fence.gate_authorization?.checkRunId))
  ) {
    if (eligible.check_run_id)
      operations.push({
        id: crypto.randomUUID(),
        kind: 'gate',
        targetId: eligible.check_run_id,
        state: 'prepared',
        conclusion:
          eligible.status === 'completed'
            ? result.gateResult === 'fail'
              ? 'failure'
              : 'success'
            : eligible.status === 'cancelled'
              ? 'cancelled'
              : isCodeReviewActionRequiredReason(eligible.terminal_reason)
                ? 'action_required'
                : 'failure',
      });
    if (fence.preparation && eligible.status === 'completed' && result.summary) {
      const summary = result.summary;
      const octokit = await publicationClient(identity, fence);
      const [owner, repo] = identity.target.repoFullName.split('/');
      const comment = validComment(
        await readGithubResource(() =>
          octokit.issues.getComment({ owner, repo, comment_id: summary.commentId })
        ),
        identity,
        result.summary.commentId
      );
      if (comment && hash(comment.body) === result.summary.bodyHash) {
        const usage = fence.usage_settlement
          ? QueuedIsolateUsageSettlementSchema.parse(fence.usage_settlement).totals
          : null;
        const body = appendReviewSummaryFooter(comment.body, {
          reviewGuidance: fence.preparation.reviewGuidance,
          ...(usage
            ? {
                usage: {
                  model: fence.preparation.model,
                  tokensIn: Math.max(0, usage.tokensIn - usage.cacheHit - usage.cacheWrite),
                  tokensOut: usage.tokensOut,
                  cachedTokens: usage.cacheHit + usage.cacheWrite,
                },
              }
            : {}),
        });
        if (Buffer.byteLength(body, 'utf8') <= 65_536 && body !== comment.body)
          operations.push({
            id: crypto.randomUUID(),
            kind: 'footer',
            targetId: comment.id,
            state: 'prepared',
            body,
            previousBodyHash: result.summary.bodyHash,
          });
      }
    }
  }
  await db.transaction(async tx => {
    const current = await lockMatchingFence(tx, identity);
    if (
      current.web_finalization !== 'pending' ||
      current.web_publications.length ||
      current.released_at
    )
      return;
    const canonical = await canonicalState(tx, identity);
    const allowed =
      !current.identity_cleanup_requested &&
      canonical.matching &&
      current.canonical_settled_at &&
      canonical.review.terminal_reason !== 'superseded' &&
      (await authorizedExecutionUser(tx, identity));
    await updateIsolatePublicationOn(tx, identity, {
      web_publications: allowed ? operations : [],
      web_finalization: allowed && operations.length ? 'pending' : 'suppressed',
    });
  });
}

async function setPublicationOutcome(
  identity: QueuedIsolateIdentity,
  operation: IsolateWebPublication,
  state: 'confirmed' | 'rejected' | 'suppressed'
) {
  await db.transaction(async tx => {
    const fence = await lockMatchingFence(tx, identity);
    await updateIsolatePublicationOn(tx, identity, {
      web_publications: fence.web_publications.map(item =>
        item.id === operation.id && item.state === (state === 'suppressed' ? 'prepared' : 'sent')
          ? { ...item, state }
          : item
      ),
    });
  });
}

async function finalizePublication(
  identity: QueuedIsolateIdentity,
  fence: CodeReviewPublicationFence,
  raw: IsolateWebPublication
) {
  const operation = IsolateWebPublicationSchema.parse(raw);
  if (!['prepared', 'sent'].includes(operation.state)) return;
  if (operation.state === 'prepared') {
    const allowed = await db.transaction(async tx => {
      const current = await lockMatchingFence(tx, identity);
      const canonical = await canonicalState(tx, identity);
      const integration = await authorizedIntegration(tx, identity);
      const eligible =
        integration?.platform_installation_id === publicationInstallationId(current, operation) &&
        (operation.kind !== 'gate' || canonical.review?.check_run_id === operation.targetId) &&
        !current.released_at &&
        !current.identity_cleanup_requested &&
        canonical.matching &&
        current.canonical_settled_at &&
        canonical.review.terminal_reason !== 'superseded' &&
        (await authorizedExecutionUser(tx, identity));
      if (!eligible)
        await updateIsolatePublicationOn(tx, identity, {
          web_publications: current.web_publications.map(item =>
            item.id === operation.id && item.state === 'prepared'
              ? { ...item, state: 'suppressed' }
              : item
          ),
        });
      return Boolean(eligible);
    });
    if (!allowed) return;
  }
  const octokit = await publicationClient(identity, fence, operation);
  const [owner, repo] = identity.target.repoFullName.split('/');
  const externalId = `queued-isolate:${identity.generation}:${operation.id}`;
  let matches = false;
  let writable = true;
  if (operation.kind === 'footer') {
    const comment = validComment(
      await readGithubResource(() =>
        octokit.issues.getComment({ owner, repo, comment_id: operation.targetId })
      ),
      identity,
      operation.targetId
    );
    if (!comment) {
      if (operation.state === 'prepared')
        await setPublicationOutcome(identity, operation, 'suppressed');
      return;
    }
    matches = comment.body === operation.body;
    writable = hash(comment.body) === operation.previousBodyHash;
  } else {
    const check = await readGithubResource(() =>
      octokit.checks.get({ owner, repo, check_run_id: operation.targetId })
    );
    if (
      !check ||
      check.id !== operation.targetId ||
      check.head_sha !== identity.snapshot.headSha ||
      check.app?.id !== Number(getGitHubAppCredentials('standard').appId)
    ) {
      if (operation.state === 'prepared')
        await setPublicationOutcome(identity, operation, 'suppressed');
      return;
    }
    matches =
      check.external_id === externalId &&
      check.status === 'completed' &&
      check.conclusion === operation.conclusion;
  }
  if (operation.state === 'sent') {
    if (matches) await setPublicationOutcome(identity, operation, 'confirmed');
    return;
  }
  if (!writable) {
    await setPublicationOutcome(identity, operation, 'suppressed');
    return;
  }
  const pull = (await octokit.pulls.get({ owner, repo, pull_number: identity.target.prNumber }))
    .data;
  if (
    pull.state !== 'open' ||
    pull.head.sha !== identity.snapshot.headSha ||
    pull.base.repo.full_name.toLowerCase() !== identity.target.repoFullName
  ) {
    await setPublicationOutcome(identity, operation, 'suppressed');
    return;
  }
  const send = await db.transaction(async tx => {
    const current = await lockMatchingFence(tx, identity);
    const item = current.web_publications.find(item => item.id === operation.id);
    if (current.released_at || item?.state !== 'prepared') return false;
    const canonical = await canonicalState(tx, identity);
    const integration = await authorizedIntegration(tx, identity);
    const allowed =
      integration?.platform_installation_id === publicationInstallationId(current, operation) &&
      (operation.kind !== 'gate' || canonical.review?.check_run_id === operation.targetId) &&
      !current.identity_cleanup_requested &&
      canonical.matching &&
      current.canonical_settled_at &&
      canonical.review.terminal_reason !== 'superseded' &&
      (await authorizedExecutionUser(tx, identity));
    await updateIsolatePublicationOn(tx, identity, {
      web_publications: current.web_publications.map(item =>
        item.id === operation.id ? { ...item, state: allowed ? 'sent' : 'suppressed' } : item
      ),
      ...(allowed ? { web_finalization: 'uncertain' as const } : {}),
    });
    return Boolean(allowed);
  });
  if (!send) return;
  try {
    if (operation.kind === 'footer') {
      if (!operation.body) throw new Error('Footer body is missing');
      const response = await octokit.issues.updateComment({
        owner,
        repo,
        comment_id: operation.targetId,
        body: operation.body,
      });
      const comment = validComment(response.data, identity, operation.targetId);
      if (!comment || comment.body !== operation.body) throw new Error('Footer response mismatch');
    } else {
      const reason = fence.terminal_result?.reason;
      const actionRequiredCopy =
        operation.conclusion === 'action_required' && isCodeReviewActionRequiredReason(reason)
          ? getCodeReviewActionRequiredCopy(reason)
          : null;
      const response = await octokit.checks.update({
        owner,
        repo,
        check_run_id: operation.targetId,
        status: 'completed',
        conclusion: operation.conclusion,
        external_id: externalId,
        ...(actionRequiredCopy
          ? {
              output: {
                title: actionRequiredCopy.checkTitle,
                summary: actionRequiredCopy.checkSummary,
              },
            }
          : {}),
      });
      if (
        response.data.id !== operation.targetId ||
        response.data.external_id !== externalId ||
        response.data.status !== 'completed' ||
        response.data.conclusion !== operation.conclusion
      )
        throw new Error('Gate response mismatch');
    }
    await setPublicationOutcome(identity, operation, 'confirmed');
  } catch (error) {
    const rejection = z.object({ status: z.number() }).safeParse(error);
    if (rejection.success && [400, 401, 403, 404, 422].includes(rejection.data.status))
      await setPublicationOutcome(identity, operation, 'rejected');
  }
}

export async function resumeQueuedIsolateFinalization(
  identity: QueuedIsolateIdentity,
  options: TryDispatchPendingReviewsOptions = {}
) {
  await settleQueuedIsolateUsage(identity);
  let fence = await readFence(identity);
  if (!fence.released_at && fence.safety?.quiescent && fence.terminal_result) {
    await prepareWebPublications(identity, fence);
    fence = await readFence(identity);
    for (const operation of fence.web_publications)
      await finalizePublication(identity, fence, operation);
    await db.transaction(async tx => {
      const current = await lockMatchingFence(tx, identity);
      if (current.web_finalization === 'suppressed' || current.released_at) return;
      if (current.web_publications.every(item => !['prepared', 'sent'].includes(item.state)))
        await updateIsolatePublicationOn(tx, identity, { web_finalization: 'settled' });
    });
    await releaseIsolatePublicationFence(identity);
  }
  fence = await readFence(identity);
  if (fence.released_at && !fence.queue_wakeup_at) {
    const { tryDispatchPendingReviews } = await import('./dispatch/dispatch-pending-reviews');
    const bot = await getUnblockedBotUserForOrg(identity.organizationId, 'code-review');
    if (!bot) throw new Error('Organization queue execution user unavailable');
    await tryDispatchPendingReviews(
      { type: 'org', id: identity.organizationId, userId: bot.id },
      options
    );
    await db.transaction(tx =>
      updateIsolatePublicationOn(tx, identity, { queue_wakeup_at: new Date().toISOString() })
    );
  }
  return Boolean(fence.released_at);
}

export async function isQueuedIsolateCallbackTarget(reviewId: string, attemptId: string) {
  if (
    !z.uuid().safeParse(reviewId).success ||
    (attemptId && !z.uuid().safeParse(attemptId).success)
  )
    return false;
  const [attempt] = await db
    .select({ backend: cloud_agent_code_review_attempts.reviewer_backend })
    .from(cloud_agent_code_review_attempts)
    .where(
      and(
        eq(cloud_agent_code_review_attempts.code_review_id, reviewId),
        attemptId ? eq(cloud_agent_code_review_attempts.id, attemptId) : undefined
      )
    )
    .orderBy(desc(cloud_agent_code_review_attempts.attempt_number))
    .limit(1);
  return attempt?.backend === 'isolate';
}

export async function handleQueuedIsolateCallback(req: NextRequest, reviewId: string) {
  try {
    const reader = req.body?.getReader();
    if (!reader) return NextResponse.json({ error: 'Missing payload' }, { status: 400 });
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 65_536) {
        void reader.cancel().catch(() => {});
        return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
      }
      chunks.push(chunk.value);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const authority = QueuedIsolateAuthorityRequestSchema.safeParse(body);
    const notification = QueuedIsolateNotificationSchema.safeParse(body);
    const payload = authority.success
      ? authority.data
      : notification.success
        ? notification.data
        : null;
    if (!payload) return NextResponse.json({ error: 'Invalid isolate payload' }, { status: 400 });
    const { identity } = payload;
    if (
      identity.reviewId !== reviewId ||
      identity.attemptId !== req.nextUrl.searchParams.get('attemptId') ||
      !INTERNAL_API_SECRET ||
      !(await verifyCallbackToken({
        token: req.headers.get('X-Callback-Token'),
        secret: INTERNAL_API_SECRET,
        scope: 'queued-isolate-callback',
        resourceParts: [JSON.stringify(QueuedIsolateIdentitySchema.parse(identity))],
      }))
    )
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (authority.success) return NextResponse.json(await authorizeQueuedIsolate(authority.data));
    if (!notification.success)
      return NextResponse.json({ error: 'Invalid isolate notification' }, { status: 400 });
    await recordNotification(notification.data);
    let released = false;
    try {
      released = await resumeQueuedIsolateFinalization(identity);
    } catch {
      released = false;
    }
    const fence = await readFence(identity);
    return NextResponse.json({
      version: 1,
      identity,
      sequence: notification.data.safety.sequence,
      notificationRecorded: true,
      fenceReleased: released,
      usageSettled: Boolean(fence.usage_settlement || fence.identity_cleanup_requested),
    });
  } catch {
    return NextResponse.json({ error: 'Isolate callback could not be recorded' }, { status: 409 });
  }
}
