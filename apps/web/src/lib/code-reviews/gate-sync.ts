import { randomUUID } from 'node:crypto';
import { captureException } from '@sentry/nextjs';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import {
  cloud_agent_code_review_gate_syncs,
  cloud_agent_code_reviews,
  type CloudAgentCodeReview,
  type CloudAgentCodeReviewGateSync,
  type PlatformIntegration,
} from '@kilocode/db/schema';
import { APP_URL } from '@/lib/constants';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { getIntegrationById } from '@/lib/integrations/db/platform-integrations';
import {
  updateCheckRun,
  type CheckRunConclusion,
} from '@/lib/integrations/platforms/github/adapter';
import type { GitHubAppType } from '@/lib/integrations/platforms/github/app-selector';
import {
  setCommitStatus,
  type GitLabCommitStatusState,
} from '@/lib/integrations/platforms/gitlab/adapter';
import {
  getStoredProjectAccessToken,
  getValidGitLabToken,
} from '@/lib/integrations/gitlab-service';
import { logExceptInTest } from '@/lib/utils.server';

type GateStatus = 'running' | 'completed' | 'failed' | 'cancelled';
type GateResult = 'pass' | 'fail';
type GateSyncStatus = 'pending' | 'processing' | 'retry' | 'synced' | 'skipped';

type ClaimedGateSync = CloudAgentCodeReviewGateSync & {
  desired_status: GateStatus;
  desired_gate_result: GateResult | null;
  sync_status: GateSyncStatus;
  claim_token: string;
};

type GateSyncFailureCode =
  | 'permission'
  | 'rate_limited'
  | 'upstream_5xx'
  | 'timeout'
  | 'network'
  | 'not_found'
  | 'configuration'
  | 'provider_error';

type FailureClassification = {
  code: GateSyncFailureCode;
  retryDelayMs: number;
  permissionBlocked: boolean;
  ambiguous: boolean;
};

export type GateSyncProcessOutcome =
  | { outcome: 'none-due' }
  | { outcome: 'synchronized'; reviewId: string; revision: number }
  | { outcome: 'skipped'; reviewId: string; revision: number; reason: string }
  | {
      outcome: 'retried';
      reviewId: string;
      revision: number;
      errorCode: GateSyncFailureCode;
      permissionBlocked: boolean;
      nextRetryAt: string;
    }
  | { outcome: 'deferred'; reviewId: string; revision: number };

export type GateSyncBatchSummary = {
  attempted: number;
  synchronized: number;
  skipped: number;
  retried: number;
  permissionBlocked: number;
  deferred: number;
  failed: number;
  hasMore: boolean;
};

const CLAIM_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_BATCH_LIMIT = 25;
const MAX_GATE_SYNC_ATTEMPTS = 12;
const MODEL_NOT_FOUND_SUMMARY_URL = 'https://app.kilo.ai/code-reviews';
const MODEL_NOT_FOUND_CHECK_TITLE = 'Selected model is no longer available';
const MODEL_NOT_FOUND_STATUS_SUMMARY = `The review did not run because the selected model is no longer available. Choose another model in Kilo Code review settings: ${MODEL_NOT_FOUND_SUMMARY_URL}`;
const MODEL_NOT_FOUND_GITLAB_DESCRIPTION = `Selected model is no longer available. Choose another model: ${MODEL_NOT_FOUND_SUMMARY_URL}`;

function isTerminalStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function isGateStatus(status: string): status is GateStatus {
  return status === 'running' || isTerminalStatus(status);
}

function isGateSyncStatus(status: string): status is GateSyncStatus {
  return (
    status === 'pending' ||
    status === 'processing' ||
    status === 'retry' ||
    status === 'synced' ||
    status === 'skipped'
  );
}

function isGateResult(result: string | null): result is GateResult | null {
  return result === null || result === 'pass' || result === 'fail';
}

function isClaimedGateSync(
  sync: CloudAgentCodeReviewGateSync | undefined
): sync is ClaimedGateSync {
  return (
    !!sync?.claim_token &&
    isGateStatus(sync.desired_status) &&
    isGateResult(sync.desired_gate_result) &&
    isGateSyncStatus(sync.sync_status)
  );
}

function isBillingCodeReviewTerminalReason(
  terminalReason?: string | null,
  errorMessage?: string | null
): boolean {
  if (terminalReason === 'billing') return true;
  const message = errorMessage?.toLowerCase();
  if (!message) return false;
  return ['insufficient credits', 'paid model', 'add credits', 'credits required'].some(pattern =>
    message.includes(pattern)
  );
}

function isModelNotFoundCodeReviewTerminalReason(
  terminalReason?: string | null,
  errorMessage?: string | null
): boolean {
  if (terminalReason === 'model_not_found') return true;
  return /\bmodel\s+not\s+found\b/i.test(errorMessage ?? '');
}

export function mapStatusToCheckRun(
  reviewStatus: string,
  errorMessage?: string | null,
  terminalReason?: string | null,
  gateResult?: GateResult | null
) {
  const statusMap: Record<string, 'in_progress' | 'completed'> = {
    running: 'in_progress',
    completed: 'completed',
    failed: 'completed',
    cancelled: 'completed',
  };

  const checkStatus = statusMap[reviewStatus];
  if (!checkStatus) return null;

  const reviewFailed = reviewStatus === 'completed' && gateResult === 'fail';
  const billingFailure =
    reviewStatus === 'failed' && isBillingCodeReviewTerminalReason(terminalReason, errorMessage);
  const modelNotFoundCancellation =
    reviewStatus === 'cancelled' &&
    isModelNotFoundCodeReviewTerminalReason(terminalReason, errorMessage);

  const conclusionMap: Record<string, CheckRunConclusion> = {
    completed: reviewFailed ? 'failure' : 'success',
    failed: billingFailure ? 'action_required' : 'failure',
    cancelled: 'cancelled',
  };

  const titleMap: Record<string, string> = {
    running: 'Kilo Code Review in progress',
    completed: reviewFailed ? 'Kilo Code Review found issues' : 'Kilo Code Review completed',
    failed: billingFailure ? 'Insufficient credits to run review' : 'Kilo Code Review failed',
    cancelled: modelNotFoundCancellation
      ? MODEL_NOT_FOUND_CHECK_TITLE
      : 'Kilo Code Review cancelled',
  };

  const summaryMap: Record<string, string> = {
    running: 'Review is running...',
    completed: reviewFailed
      ? 'Code review completed with findings that require attention.'
      : 'Code review completed successfully.',
    failed: billingFailure
      ? 'Review could not start because the account has insufficient credits.'
      : errorMessage
        ? `Review failed: ${errorMessage}`
        : 'Review failed.',
    cancelled: modelNotFoundCancellation ? MODEL_NOT_FOUND_STATUS_SUMMARY : 'Review was cancelled.',
  };

  return {
    status: checkStatus,
    conclusion: conclusionMap[reviewStatus],
    title: titleMap[reviewStatus] ?? 'Kilo Code Review',
    summary: summaryMap[reviewStatus] ?? '',
  };
}

export function mapStatusToGitLabState(
  reviewStatus: string,
  gateResult?: GateResult | null
): GitLabCommitStatusState {
  if (reviewStatus === 'completed' && gateResult === 'fail') return 'failed';
  const stateMap: Record<string, GitLabCommitStatusState> = {
    running: 'running',
    completed: 'success',
    failed: 'failed',
    cancelled: 'canceled',
  };
  return stateMap[reviewStatus] ?? 'pending';
}

export function getGitLabStatusDescription(
  reviewStatus: string,
  errorMessage?: string | null,
  terminalReason?: string | null,
  gateResult?: GateResult | null
): string | undefined {
  if (reviewStatus === 'running') return 'Kilo Code Review in progress';
  if (reviewStatus === 'completed' && gateResult === 'fail') {
    return 'Kilo Code Review found issues that require attention';
  }
  if (reviewStatus === 'completed') return 'Kilo Code Review completed';
  if (
    reviewStatus === 'cancelled' &&
    isModelNotFoundCodeReviewTerminalReason(terminalReason, errorMessage)
  ) {
    return MODEL_NOT_FOUND_GITLAB_DESCRIPTION;
  }
  if (reviewStatus === 'cancelled') return 'Kilo Code Review cancelled';
  if (
    reviewStatus === 'failed' &&
    isBillingCodeReviewTerminalReason(terminalReason, errorMessage)
  ) {
    return 'Insufficient credits to run review';
  }
  if (reviewStatus === 'failed' && errorMessage) {
    const description = `Review failed: ${errorMessage}`;
    return description.length > 255 ? description.slice(0, 252) + '...' : description;
  }
  if (reviewStatus === 'failed') return 'Kilo Code Review failed';
  return undefined;
}

export async function resolveGitLabAccessToken(
  integration: PlatformIntegration,
  projectId: number | null
): Promise<string> {
  const storedPrat = projectId ? getStoredProjectAccessToken(integration, projectId) : null;
  return storedPrat ? storedPrat.token : await getValidGitLabToken(integration);
}

export function getGitLabInstanceUrl(integration: PlatformIntegration): string {
  const metadata = integration.metadata as {
    gitlab_instance_url?: string;
  } | null;
  return metadata?.gitlab_instance_url || 'https://gitlab.com';
}

function redactGateSyncError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/glpat-[A-Za-z0-9_-]+/gi, 'glpat-[REDACTED]')
    .replace(/PRIVATE-TOKEN\s*[:=]\s*["']?[^"'\s,}]+["']?/gi, 'PRIVATE-TOKEN=[REDACTED]')
    .replace(
      /("(?:access[_-]?token|token|authorization|private-token)"\s*:\s*")[^"]+/gi,
      '$1[REDACTED]'
    )
    .replace(/((?:access[_-]?token|token|authorization|private-token)=)([^\s&]+)/gi, '$1[REDACTED]')
    .slice(0, 1000);
}

function createRedactedGateSyncError(error: unknown, redactedError: string): Error {
  const sanitized = new Error(redactedError);
  sanitized.name = error instanceof Error ? error.name : 'GateSyncProviderError';
  return sanitized;
}

function classifyGateSyncError(error: unknown, attemptCount: number): FailureClassification {
  const message = redactGateSyncError(error).toLowerCase();
  const retryableBackoffMs = Math.min(30 * 60 * 1000, 2 ** Math.max(1, attemptCount) * 60 * 1000);

  if (/\b(401|403)\b/.test(message) || /auth|permission|forbidden|unauthorized/.test(message)) {
    return {
      code: 'permission',
      retryDelayMs: Math.min(12 * 60 * 60 * 1000, Math.max(60 * 60 * 1000, retryableBackoffMs)),
      permissionBlocked: true,
      ambiguous: false,
    };
  }
  if (/\b429\b|rate limit/.test(message)) {
    return {
      code: 'rate_limited',
      retryDelayMs: Math.min(60 * 60 * 1000, Math.max(10 * 60 * 1000, retryableBackoffMs)),
      permissionBlocked: false,
      ambiguous: false,
    };
  }
  if (/\b5\d\d\b|internal server|bad gateway|service unavailable|gateway timeout/.test(message)) {
    return {
      code: 'upstream_5xx',
      retryDelayMs: retryableBackoffMs,
      permissionBlocked: false,
      ambiguous: false,
    };
  }
  if (/timeout|timed out|abort/.test(message)) {
    return {
      code: 'timeout',
      retryDelayMs: retryableBackoffMs,
      permissionBlocked: false,
      ambiguous: true,
    };
  }
  if (/network|econnreset|econnrefused|socket hang up|fetch failed/.test(message)) {
    return {
      code: 'network',
      retryDelayMs: retryableBackoffMs,
      permissionBlocked: false,
      ambiguous: true,
    };
  }
  if (/\b404\b|not found/.test(message)) {
    return {
      code: 'not_found',
      retryDelayMs: Math.min(60 * 60 * 1000, Math.max(10 * 60 * 1000, retryableBackoffMs)),
      permissionBlocked: false,
      ambiguous: false,
    };
  }
  if (/missing|not configured|unsupported/.test(message)) {
    return {
      code: 'configuration',
      retryDelayMs: 60 * 60 * 1000,
      permissionBlocked: false,
      ambiguous: false,
    };
  }
  return {
    code: 'provider_error',
    retryDelayMs: retryableBackoffMs,
    permissionBlocked: false,
    ambiguous: false,
  };
}

async function claimDueGateSync(reviewId?: string): Promise<ClaimedGateSync | null> {
  const claimToken = randomUUID();
  const staleClaimCutoff = new Date(Date.now() - CLAIM_TIMEOUT_MS).toISOString();
  const reviewFilter = reviewId
    ? sql`AND ${cloud_agent_code_review_gate_syncs.code_review_id} = ${reviewId}`
    : sql``;

  const result = await db.execute<ClaimedGateSync>(sql`
    WITH due AS (
      SELECT ${cloud_agent_code_review_gate_syncs.code_review_id}
      FROM ${cloud_agent_code_review_gate_syncs}
      WHERE (
          (
            ${cloud_agent_code_review_gate_syncs.sync_status} IN ('pending', 'retry')
            AND (
              ${cloud_agent_code_review_gate_syncs.next_retry_at} IS NULL
              OR ${cloud_agent_code_review_gate_syncs.next_retry_at} <= now()
            )
          )
          OR (
            ${cloud_agent_code_review_gate_syncs.sync_status} = 'processing'
            AND ${cloud_agent_code_review_gate_syncs.claimed_at} < ${staleClaimCutoff}
          )
        )
        ${reviewFilter}
      ORDER BY
        COALESCE(${cloud_agent_code_review_gate_syncs.next_retry_at}, '-infinity'::timestamptz),
        ${cloud_agent_code_review_gate_syncs.updated_at},
        ${cloud_agent_code_review_gate_syncs.code_review_id}
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE ${cloud_agent_code_review_gate_syncs} AS syncs
    SET
      sync_status = 'processing',
      claim_token = ${claimToken},
      claimed_at = now(),
      last_attempted_at = now(),
      attempt_count = syncs.attempt_count + 1,
      updated_at = now()
    FROM due
    WHERE syncs.code_review_id = due.code_review_id
    RETURNING syncs.*
  `);

  const row = result.rows[0];
  return row?.claim_token ? row : null;
}

async function hasDueGateSync(): Promise<boolean> {
  const staleClaimCutoff = new Date(Date.now() - CLAIM_TIMEOUT_MS).toISOString();
  const result = await db.execute<{ code_review_id: string }>(sql`
    SELECT ${cloud_agent_code_review_gate_syncs.code_review_id}
    FROM ${cloud_agent_code_review_gate_syncs}
    WHERE (
        ${cloud_agent_code_review_gate_syncs.sync_status} IN ('pending', 'retry')
        AND (
          ${cloud_agent_code_review_gate_syncs.next_retry_at} IS NULL
          OR ${cloud_agent_code_review_gate_syncs.next_retry_at} <= now()
        )
      )
      OR (
        ${cloud_agent_code_review_gate_syncs.sync_status} = 'processing'
        AND ${cloud_agent_code_review_gate_syncs.claimed_at} < ${staleClaimCutoff}
      )
    LIMIT 1
  `);

  return result.rows.length > 0;
}

async function refreshClaimedGateSync(sync: ClaimedGateSync): Promise<ClaimedGateSync | null> {
  const [current] = await db
    .select()
    .from(cloud_agent_code_review_gate_syncs)
    .where(
      and(
        eq(cloud_agent_code_review_gate_syncs.code_review_id, sync.code_review_id),
        eq(cloud_agent_code_review_gate_syncs.claim_token, sync.claim_token)
      )
    )
    .limit(1);

  return isClaimedGateSync(current) ? current : null;
}

async function markSupersededClaimPending(sync: ClaimedGateSync): Promise<GateSyncProcessOutcome> {
  const now = new Date().toISOString();
  const updates: Partial<typeof cloud_agent_code_review_gate_syncs.$inferInsert> = {
    sync_status: 'pending',
    claim_token: null,
    claimed_at: null,
    next_retry_at: now,
    updated_at: now,
  };

  await db
    .update(cloud_agent_code_review_gate_syncs)
    .set(updates)
    .where(
      and(
        eq(cloud_agent_code_review_gate_syncs.code_review_id, sync.code_review_id),
        sql`${cloud_agent_code_review_gate_syncs.desired_revision} > ${sync.desired_revision}`,
        inArray(cloud_agent_code_review_gate_syncs.sync_status, [
          'pending',
          'retry',
          'synced',
          'skipped',
        ])
      )
    );

  return { outcome: 'deferred', reviewId: sync.code_review_id, revision: sync.desired_revision };
}

async function markGateSyncSuccess(
  sync: ClaimedGateSync,
  status: 'synced' | 'skipped',
  skippedReason?: string
): Promise<GateSyncProcessOutcome> {
  const now = new Date().toISOString();
  const [updated] = await db
    .update(cloud_agent_code_review_gate_syncs)
    .set({
      sync_status: status,
      claim_token: null,
      claimed_at: null,
      next_retry_at: null,
      synced_at: now,
      last_error_code: skippedReason ?? null,
      last_error_redacted: null,
      terminal_confirmation_required: false,
      last_ambiguous_at: null,
      updated_at: now,
    })
    .where(
      and(
        eq(cloud_agent_code_review_gate_syncs.code_review_id, sync.code_review_id),
        eq(cloud_agent_code_review_gate_syncs.claim_token, sync.claim_token),
        eq(cloud_agent_code_review_gate_syncs.desired_revision, sync.desired_revision)
      )
    )
    .returning();

  if (!updated) return await markSupersededClaimPending(sync);

  if (status === 'skipped') {
    return {
      outcome: 'skipped',
      reviewId: sync.code_review_id,
      revision: sync.desired_revision,
      reason: skippedReason ?? 'not_applicable',
    };
  }

  return {
    outcome: 'synchronized',
    reviewId: sync.code_review_id,
    revision: sync.desired_revision,
  };
}

async function markGateSyncFailure(
  sync: ClaimedGateSync,
  classification: FailureClassification,
  redactedError: string
): Promise<GateSyncProcessOutcome> {
  const now = new Date();
  const nowIso = now.toISOString();
  const nextRetryAt = new Date(now.getTime() + classification.retryDelayMs).toISOString();
  const terminalAmbiguity = classification.ambiguous && isTerminalStatus(sync.desired_status);

  if (sync.attempt_count >= MAX_GATE_SYNC_ATTEMPTS) {
    const [updated] = await db
      .update(cloud_agent_code_review_gate_syncs)
      .set({
        sync_status: 'skipped',
        claim_token: null,
        claimed_at: null,
        next_retry_at: null,
        last_error_code: classification.code,
        last_error_redacted: redactedError,
        terminal_confirmation_required: terminalAmbiguity || sync.terminal_confirmation_required,
        last_ambiguous_at: classification.ambiguous ? nowIso : sync.last_ambiguous_at,
        updated_at: nowIso,
      })
      .where(
        and(
          eq(cloud_agent_code_review_gate_syncs.code_review_id, sync.code_review_id),
          eq(cloud_agent_code_review_gate_syncs.claim_token, sync.claim_token),
          eq(cloud_agent_code_review_gate_syncs.desired_revision, sync.desired_revision)
        )
      )
      .returning();

    if (!updated) return await markSupersededClaimPending(sync);

    return {
      outcome: 'skipped',
      reviewId: sync.code_review_id,
      revision: sync.desired_revision,
      reason: `retry_exhausted:${classification.code}`,
    };
  }

  const [updated] = await db
    .update(cloud_agent_code_review_gate_syncs)
    .set({
      sync_status: 'retry',
      claim_token: null,
      claimed_at: null,
      next_retry_at: nextRetryAt,
      last_error_code: classification.code,
      last_error_redacted: redactedError,
      terminal_confirmation_required: terminalAmbiguity || sync.terminal_confirmation_required,
      last_ambiguous_at: classification.ambiguous ? nowIso : sync.last_ambiguous_at,
      updated_at: nowIso,
    })
    .where(
      and(
        eq(cloud_agent_code_review_gate_syncs.code_review_id, sync.code_review_id),
        eq(cloud_agent_code_review_gate_syncs.claim_token, sync.claim_token),
        eq(cloud_agent_code_review_gate_syncs.desired_revision, sync.desired_revision)
      )
    )
    .returning();

  if (!updated) {
    await db
      .update(cloud_agent_code_review_gate_syncs)
      .set({
        sync_status: 'pending',
        claim_token: null,
        claimed_at: null,
        next_retry_at: nowIso,
        terminal_confirmation_required: sql`CASE
          WHEN ${cloud_agent_code_review_gate_syncs.desired_status} IN ('completed', 'failed', 'cancelled')
            THEN TRUE
          ELSE ${cloud_agent_code_review_gate_syncs.terminal_confirmation_required}
        END`,
        last_ambiguous_at: classification.ambiguous
          ? nowIso
          : sql`${cloud_agent_code_review_gate_syncs.last_ambiguous_at}`,
        updated_at: nowIso,
      })
      .where(
        and(
          eq(cloud_agent_code_review_gate_syncs.code_review_id, sync.code_review_id),
          eq(cloud_agent_code_review_gate_syncs.claim_token, sync.claim_token)
        )
      );
    return { outcome: 'deferred', reviewId: sync.code_review_id, revision: sync.desired_revision };
  }

  return {
    outcome: 'retried',
    reviewId: sync.code_review_id,
    revision: sync.desired_revision,
    errorCode: classification.code,
    permissionBlocked: classification.permissionBlocked,
    nextRetryAt,
  };
}

async function publishGateSync(
  review: CloudAgentCodeReview,
  integration: PlatformIntegration,
  sync: ClaimedGateSync
): Promise<'published' | { skippedReason: string }> {
  const platform = review.platform || 'github';
  const detailsUrl = `${APP_URL}/code-reviews/${review.id}`;
  const checkRunMapping = mapStatusToCheckRun(
    sync.desired_status,
    sync.desired_error_message,
    sync.desired_terminal_reason,
    sync.desired_gate_result
  );

  if (!checkRunMapping) return { skippedReason: 'unsupported_status' };

  if (platform === 'github') {
    if (!integration.platform_installation_id) return { skippedReason: 'missing_installation' };
    if (!review.check_run_id) return { skippedReason: 'missing_check_run' };

    const [repoOwner, repoName] = review.repo_full_name.split('/');
    const appType: GitHubAppType = integration.github_app_type || 'standard';
    await updateCheckRun(
      integration.platform_installation_id,
      repoOwner,
      repoName,
      review.check_run_id,
      {
        status: checkRunMapping.status,
        conclusion: checkRunMapping.conclusion,
        detailsUrl,
        output: {
          title: checkRunMapping.title,
          summary: checkRunMapping.summary,
        },
      },
      appType
    );
    return 'published';
  }

  if (platform === PLATFORM.GITLAB) {
    const accessToken = await resolveGitLabAccessToken(integration, review.platform_project_id);
    await setCommitStatus(
      accessToken,
      review.platform_project_id ?? review.repo_full_name,
      review.head_sha,
      mapStatusToGitLabState(sync.desired_status, sync.desired_gate_result),
      {
        targetUrl: detailsUrl,
        description: getGitLabStatusDescription(
          sync.desired_status,
          sync.desired_error_message,
          sync.desired_terminal_reason,
          sync.desired_gate_result
        ),
      },
      getGitLabInstanceUrl(integration)
    );
    return 'published';
  }

  return { skippedReason: 'unsupported_platform' };
}

async function processClaimedGateSync(sync: ClaimedGateSync): Promise<GateSyncProcessOutcome> {
  const [review] = await db
    .select()
    .from(cloud_agent_code_reviews)
    .where(eq(cloud_agent_code_reviews.id, sync.code_review_id))
    .limit(1);

  if (!review) return await markGateSyncSuccess(sync, 'skipped', 'review_missing');
  if (!review.platform_integration_id) {
    return await markGateSyncSuccess(sync, 'skipped', 'missing_integration');
  }

  const integration = await getIntegrationById(review.platform_integration_id);
  if (!integration) return await markGateSyncSuccess(sync, 'skipped', 'integration_missing');

  const currentSync = await refreshClaimedGateSync(sync);
  if (!currentSync) return await markSupersededClaimPending(sync);

  try {
    const publishResult = await publishGateSync(review, integration, currentSync);
    if (publishResult !== 'published') {
      return await markGateSyncSuccess(currentSync, 'skipped', publishResult.skippedReason);
    }

    logExceptInTest('[code-review-gate-sync] Published gate status', {
      reviewId: currentSync.code_review_id,
      platform: review.platform,
      desiredStatus: currentSync.desired_status,
      desiredRevision: currentSync.desired_revision,
      attemptCount: currentSync.attempt_count,
    });
    return await markGateSyncSuccess(currentSync, 'synced');
  } catch (error) {
    const redactedError = redactGateSyncError(error);
    const classification = classifyGateSyncError(error, currentSync.attempt_count);
    captureException(createRedactedGateSyncError(error, redactedError), {
      tags: {
        source: 'code-review-gate-sync',
        platform: review.platform || 'github',
        code: classification.code,
      },
      extra: {
        reviewId: currentSync.code_review_id,
        desiredStatus: currentSync.desired_status,
        desiredRevision: currentSync.desired_revision,
        attemptCount: currentSync.attempt_count,
        redactedError,
      },
    });

    return await markGateSyncFailure(currentSync, classification, redactedError);
  }
}

export async function processDueCodeReviewGateSync(
  reviewId?: string
): Promise<GateSyncProcessOutcome> {
  const sync = await claimDueGateSync(reviewId);
  if (!sync) return { outcome: 'none-due' };
  return await processClaimedGateSync(sync);
}

export async function syncDueCodeReviewGateStatuses(
  params: { limit?: number } = {}
): Promise<GateSyncBatchSummary> {
  const limit = Math.max(1, Math.min(params.limit ?? DEFAULT_BATCH_LIMIT, 100));
  const summary: GateSyncBatchSummary = {
    attempted: 0,
    synchronized: 0,
    skipped: 0,
    retried: 0,
    permissionBlocked: 0,
    deferred: 0,
    failed: 0,
    hasMore: false,
  };

  for (let index = 0; index < limit; index++) {
    try {
      const outcome = await processDueCodeReviewGateSync();
      if (outcome.outcome === 'none-due') {
        summary.hasMore = false;
        return summary;
      }

      summary.attempted += 1;
      if (outcome.outcome === 'synchronized') summary.synchronized += 1;
      if (outcome.outcome === 'skipped') summary.skipped += 1;
      if (outcome.outcome === 'retried') {
        summary.retried += 1;
        if (outcome.permissionBlocked) summary.permissionBlocked += 1;
      }
      if (outcome.outcome === 'deferred') summary.deferred += 1;
    } catch (error) {
      summary.failed += 1;
      captureException(error, {
        tags: { source: 'code-review-gate-sync-batch' },
      });
    }
  }

  summary.hasMore = await hasDueGateSync();
  return summary;
}
