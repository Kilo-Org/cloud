/**
 * Internal API Endpoint: Code Review Status Updates
 *
 * Called by:
 * - Code Review Orchestrator (for 'running' status and sessionId updates)
 * - Cloud-agent-next callback (for 'completed', 'failed', or 'interrupted' status)
 *
 * Accepts both legacy format (from orchestrator) and cloud-agent-next callback format:
 * - Legacy: { status, sessionId?, cliSessionId?, errorMessage? }
 * - cloud-agent-next: { status, sessionId?, cloudAgentSessionId?, executionId?,
 *     kiloSessionId?, errorMessage?, lastSeenBranch? }
 *
 * The reviewId is passed in the URL path.
 *
 * URL: POST /api/internal/code-review-status/{reviewId}
 * Protected by scoped callback token
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import * as z from 'zod';
import {
  updateCodeReviewStatus,
  updateCodeReviewStatusIfNonTerminal,
  updateCodeReviewUsage,
  getCodeReviewById,
  getSessionUsageFromBilling,
  updateCodeReviewAttemptForCallback,
  getLatestCodeReviewAttempt,
  createInfraRetryAttemptIfMissing,
} from '@/lib/code-reviews/db/code-reviews';
import { tryDispatchPendingReviews } from '@/lib/code-reviews/dispatch/dispatch-pending-reviews';
import { codeReviewWorkerClient } from '@/lib/code-reviews/client/code-review-worker-client';
import { getBotUserId } from '@/lib/bot-users/bot-user-service';
import { logExceptInTest, errorExceptInTest } from '@/lib/utils.server';
import {
  addReactionToPR,
  createPRComment,
  hasPRCommentWithMarker,
  findKiloReviewComment,
  updateKiloReviewComment,
  updateCheckRun,
} from '@/lib/integrations/platforms/github/adapter';
import type { CheckRunConclusion } from '@/lib/integrations/platforms/github/adapter';
import {
  addReactionToMR,
  createMRNote,
  hasMRNoteWithMarker,
  findKiloReviewNote,
  updateKiloReviewNote,
  setCommitStatus,
} from '@/lib/integrations/platforms/gitlab/adapter';
import type { GitLabCommitStatusState } from '@/lib/integrations/platforms/gitlab/adapter';
import { getIntegrationById } from '@/lib/integrations/db/platform-integrations';
import {
  getValidGitLabProjectAccessToken,
  getValidGitLabToken,
} from '@/lib/integrations/gitlab-service';
import { captureException, captureMessage } from '@sentry/nextjs';
import { CALLBACK_TOKEN_SECRET } from '@/lib/config.server';
import { verifyCallbackToken } from '@kilocode/worker-utils/callback-token';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { appendPreviousReviewSummaryHistory } from '@/lib/code-reviews/summary/history';
import {
  appendReviewSummaryFooter,
  buildReviewSummaryFooter,
} from '@/lib/code-reviews/summary/usage-footer';
import { APP_URL } from '@/lib/constants';
import type {
  CloudAgentCodeReview,
  CloudAgentCodeReviewAttempt,
  PlatformIntegration,
} from '@kilocode/db/schema';
import type { GitHubAppType } from '@/lib/integrations/platforms/github/app-selector';
import {
  CODE_REVIEW_TERMINAL_REASONS,
  type CodeReviewTerminalReason,
  type CodeReviewCouncilResult,
} from '@kilocode/db/schema-types';
import {
  buildCouncilReviewSection,
  councilDecisionBlocksMerge,
  upsertCouncilVerdictInBody,
} from '@kilocode/worker-utils/code-review-council';
import { isCloudAgentNextBillingErrorBody } from '@kilocode/worker-utils/cloud-agent-next-client';
import {
  CloudAgentCallbackFailureSchema,
  type CloudAgentSafeFailure,
} from '@kilocode/worker-utils/cloud-agent-failure';
import {
  classifyCodeReviewActionRequiredFailure,
  disableCodeReviewForActionRequiredFailure,
  disableCodeReviewForRepeatedCloneTimeoutsToday,
  getCodeReviewActionRequiredCopy,
  isCodeReviewActionRequiredReason,
  type CodeReviewActionRequiredReason,
} from '@/lib/code-reviews/action-required';
import type { Owner } from '@/lib/code-reviews/core';
import { CodeReviewPlatformSchema, type CodeReviewPlatform } from '@/lib/code-reviews/core/schemas';
import { parseCodeReviewAnalyticsManifest } from '@/lib/code-reviews/analytics/contracts';
import { finalizeCompletedCodeReviewWithAnalytics } from '@/lib/code-reviews/analytics/db';
import {
  computeCouncilResultForReview,
  finalizeCouncilResultForReview,
} from '@/lib/code-reviews/council/finalize-council-result';
import {
  getManualCodeReviewConfig,
  shouldPublishCodeReviewToProvider,
} from '@/lib/code-reviews/manual-config';

const CallbackTextTruncationSchema = z
  .object({
    originalUtf8ByteLength: z.number().int().nonnegative(),
    retainedUtf8ByteLength: z.number().int().nonnegative(),
  })
  .strict();

const StatusUpdatePayloadSchema = z
  .object({
    sessionId: z.string().optional(),
    cliSessionId: z.string().optional(),
    cloudAgentSessionId: z.string().optional(),
    executionId: z.string().optional(),
    messageId: z.string().optional(),
    kiloSessionId: z.string().optional(),
    idempotencyKey: z.string().optional(),
    status: z.enum(['running', 'completed', 'failed', 'cancelled', 'interrupted']),
    errorMessage: z.string().optional(),
    terminalReason: z.enum(CODE_REVIEW_TERMINAL_REASONS).optional(),
    modelNotFoundRuntimeDiagnostics: z.unknown().optional(),
    failure: z.unknown().optional(),
    failureStage: z.unknown().optional(),
    clientError: z.unknown().optional(),
    errorMessageTruncation: CallbackTextTruncationSchema.optional(),
    lastSeenBranch: z.string().optional(),
    gateResult: z.enum(['pass', 'fail']).optional(),
    lastAssistantMessageText: z.string().optional(),
    lastAssistantMessageTextTruncation: CallbackTextTruncationSchema.optional(),
  })
  .refine(
    payload =>
      !(
        payload.lastAssistantMessageText !== undefined &&
        payload.lastAssistantMessageTextTruncation?.retainedUtf8ByteLength === 0
      ),
    { message: 'Assistant text cannot be present when it was omitted' }
  );

type StatusUpdatePayload = z.infer<typeof StatusUpdatePayloadSchema>;

type TerminalOwnerResolution = {
  owner: Owner;
  canDispatch: boolean;
};

type ModelNotFoundRuntimeDiagnostics = {
  requestedModel: string;
  availableModelCount: number;
  availableModels: string[];
  suggestedModels: string[];
  suggestionSource: ModelNotFoundSuggestionSource;
};

type ModelNotFoundSuggestionSource = 'fuzzy' | 'first-five' | 'none';

const MODEL_DIAGNOSTIC_MAX_MODEL_ID_LENGTH = 512;
const MODEL_DIAGNOSTIC_MAX_SUGGESTIONS = 5;
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCodeReviewPlatform(platform: string): CodeReviewPlatform {
  return CodeReviewPlatformSchema.parse(platform);
}

function isValidDiagnosticModelId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MODEL_DIAGNOSTIC_MAX_MODEL_ID_LENGTH
  );
}

function hasUniqueEntries(values: string[]): boolean {
  return new Set(values).size === values.length;
}

function isModelDiagnosticSuggestionSource(value: unknown): value is ModelNotFoundSuggestionSource {
  return value === 'fuzzy' || value === 'first-five' || value === 'none';
}

function parseModelNotFoundRuntimeDiagnostics(
  value: unknown
): ModelNotFoundRuntimeDiagnostics | undefined {
  if (!isRecord(value)) return undefined;
  const requestedModel = value.requestedModel;
  const availableModelCount = value.availableModelCount;
  const availableModels = value.availableModels;
  const suggestedModels = value.suggestedModels;
  const suggestionSource = value.suggestionSource;

  if (!isValidDiagnosticModelId(requestedModel)) return undefined;
  if (
    typeof availableModelCount !== 'number' ||
    !Number.isInteger(availableModelCount) ||
    availableModelCount < 0
  ) {
    return undefined;
  }
  if (!Array.isArray(availableModels) || !availableModels.every(isValidDiagnosticModelId)) {
    return undefined;
  }
  if (availableModels.length !== availableModelCount || !hasUniqueEntries(availableModels)) {
    return undefined;
  }
  if (
    !Array.isArray(suggestedModels) ||
    suggestedModels.length > MODEL_DIAGNOSTIC_MAX_SUGGESTIONS ||
    !suggestedModels.every(isValidDiagnosticModelId) ||
    !hasUniqueEntries(suggestedModels)
  ) {
    return undefined;
  }
  if (!isModelDiagnosticSuggestionSource(suggestionSource)) {
    return undefined;
  }
  if (suggestionSource === 'none' && suggestedModels.length > 0) return undefined;
  if (availableModelCount === 0 && (availableModels.length > 0 || suggestedModels.length > 0)) {
    return undefined;
  }

  return {
    requestedModel,
    availableModelCount,
    availableModels,
    suggestedModels,
    suggestionSource,
  };
}

function getModelNotFoundRuntimeDiagnostics(
  payload: StatusUpdatePayload,
  terminalReason?: CodeReviewTerminalReason
): ModelNotFoundRuntimeDiagnostics | undefined {
  if (terminalReason !== 'model_not_found') return undefined;
  if (!('modelNotFoundRuntimeDiagnostics' in payload)) return undefined;
  return parseModelNotFoundRuntimeDiagnostics(payload.modelNotFoundRuntimeDiagnostics);
}

function getLoggableStatusErrorMessage(
  errorMessage: string | undefined,
  terminalReason: CodeReviewTerminalReason | undefined
): string | undefined {
  if (!errorMessage) return undefined;
  if (terminalReason === 'model_not_found') return 'Model not found';
  return errorMessage;
}

function captureRuntimeModelNotFoundDiagnostics(params: {
  reviewId: string;
  sessionId?: string;
  diagnostics: ModelNotFoundRuntimeDiagnostics;
}): void {
  const { reviewId, sessionId, diagnostics } = params;
  const tags = {
    source: 'code-review-runtime-model-not-found',
    review_id: reviewId,
    cloud_agent_session_id: sessionId ?? '',
  };
  const extra = {
    requestedModel: diagnostics.requestedModel,
    availableModelCount: diagnostics.availableModelCount,
    availableModels: diagnostics.availableModels,
    suggestedModels: diagnostics.suggestedModels,
    suggestionSource: diagnostics.suggestionSource,
  };
  captureMessage('Code review runtime model not found', {
    level: 'warning',
    tags,
    extra,
  });
  logExceptInTest('[code-review-status] Code review runtime model not found', {
    reviewId,
    sessionId,
    ...extra,
  });
}

/**
 * Normalize a payload from either the orchestrator or cloud-agent-next callback
 * into the common format expected by the update logic.
 */
function normalizePayload(raw: StatusUpdatePayload): {
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  sessionId?: string;
  cliSessionId?: string;
  errorMessage?: string;
  terminalReason?: CodeReviewTerminalReason;
  gateResult?: 'pass' | 'fail';
  failure?: CloudAgentSafeFailure;
} {
  // Map cloud-agent-next 'interrupted' → 'cancelled'
  let status: 'running' | 'completed' | 'failed' | 'cancelled' =
    raw.status === 'interrupted' ? 'cancelled' : raw.status;

  // Map cloud-agent-next 'kiloSessionId' → 'cliSessionId'
  const cliSessionId =
    'cliSessionId' in raw
      ? raw.cliSessionId
      : 'kiloSessionId' in raw
        ? raw.kiloSessionId
        : undefined;

  // Map cloud-agent-next 'cloudAgentSessionId' → 'sessionId' as fallback
  const sessionId =
    raw.sessionId ?? ('cloudAgentSessionId' in raw ? raw.cloudAgentSessionId : undefined);
  const failure =
    'cloudAgentSessionId' in raw ? CloudAgentCallbackFailureSchema.parse(raw.failure) : undefined;

  // Validate terminalReason against allowlist to prevent free-form text in the DB
  const validReasons: ReadonlySet<string> = new Set(CODE_REVIEW_TERMINAL_REASONS);
  let terminalReason: CodeReviewTerminalReason | undefined =
    raw.terminalReason && validReasons.has(raw.terminalReason) ? raw.terminalReason : undefined;

  if (terminalReason && isCodeReviewActionRequiredReason(terminalReason)) {
    if (status === 'cancelled') {
      status = 'failed';
    }
  }

  const actionRequiredReason = classifyCodeReviewActionRequiredFailure(raw.errorMessage);
  if (!terminalReason && actionRequiredReason) {
    if (status === 'cancelled') {
      status = 'failed';
    }
    terminalReason = actionRequiredReason;
  }

  // Infer billing when no explicit terminalReason was provided.
  // v1: billing errors arrive as 'interrupted' (→ cancelled) with billing error text
  // v2: billing errors arrive as 'failed' with billing error text (after wrapper fix)
  if (!terminalReason && isBillingCodeReviewTerminalReason(undefined, raw.errorMessage)) {
    if (status === 'cancelled') {
      status = 'failed'; // billing is not a user cancellation
    }
    terminalReason = 'billing';
  }

  if (
    (raw.status === 'failed' || raw.status === 'interrupted') &&
    isModelNotFoundCodeReviewTerminalReason(terminalReason, raw.errorMessage)
  ) {
    status = 'cancelled';
    terminalReason = 'model_not_found';
  }

  if (!terminalReason && raw.status === 'interrupted') {
    terminalReason = 'interrupted';
  }

  return {
    status,
    sessionId,
    cliSessionId,
    errorMessage: raw.errorMessage,
    terminalReason,
    gateResult: raw.gateResult,
    failure,
  };
}

function isBillingCodeReviewTerminalReason(
  terminalReason?: CodeReviewTerminalReason,
  errorMessage?: string | null
): boolean {
  if (terminalReason === 'billing') {
    return true;
  }

  if (!errorMessage) {
    return false;
  }

  return isCloudAgentNextBillingErrorBody(errorMessage);
}

function isModelNotFoundCodeReviewTerminalReason(
  terminalReason?: CodeReviewTerminalReason,
  errorMessage?: string | null
): boolean {
  if (terminalReason === 'model_not_found') {
    return true;
  }

  return /\bmodel\s+not\s+found\b/i.test(errorMessage ?? '');
}

function getActionRequiredTerminalReason(
  terminalReason?: CodeReviewTerminalReason,
  errorMessage?: string | null
): CodeReviewActionRequiredReason | null {
  if (isCodeReviewActionRequiredReason(terminalReason)) {
    return terminalReason;
  }

  return classifyCodeReviewActionRequiredFailure(errorMessage);
}

const MAX_FAILED_SESSION_TOKENS_FOR_AUTO_RETRY = 100_000;
const MAX_FAILED_SESSION_COST_MUSD_FOR_AUTO_RETRY = 200_000;

function hasKnownUnretryableTerminalReason(terminalReason?: CodeReviewTerminalReason): boolean {
  return (
    terminalReason === 'billing' ||
    terminalReason === 'model_not_found' ||
    terminalReason === 'user_cancelled' ||
    terminalReason === 'superseded' ||
    terminalReason === 'interrupted' ||
    isCodeReviewActionRequiredReason(terminalReason)
  );
}

function hasKnownUnretryableFailureMessage(errorMessage?: string | null): boolean {
  const message = errorMessage?.toLowerCase();
  if (!message) return false;

  return (
    message.includes('maximum runtime') ||
    message.includes('assistant request was not authorized') ||
    /\b(unauthorized|authentication|authorization|forbidden|401|403)\b/i.test(message) ||
    /\b(cancelled|canceled)\b/i.test(message) ||
    message.includes('superseded') ||
    message.includes('user interrupted') ||
    message.includes(
      '[byok] your api key has hit its rate limit. please try again later or check your rate limit settings with your api provider.'
    ) ||
    /code reviewer is disabled for owner [^\s]+ on (github|gitlab|bitbucket)/i.test(message)
  );
}

function isKnownUnretryableCodeReviewFailure(
  terminalReason?: CodeReviewTerminalReason,
  errorMessage?: string | null
): boolean {
  return (
    hasKnownUnretryableTerminalReason(terminalReason) ||
    classifyCodeReviewActionRequiredFailure(errorMessage) !== null ||
    isBillingCodeReviewTerminalReason(terminalReason, errorMessage) ||
    isModelNotFoundCodeReviewTerminalReason(terminalReason, errorMessage) ||
    hasKnownUnretryableFailureMessage(errorMessage)
  );
}

function shouldAutoRetryCodeReviewFailure(
  status: 'running' | 'completed' | 'failed' | 'cancelled',
  terminalReason?: CodeReviewTerminalReason,
  errorMessage?: string | null
): boolean {
  if (status !== 'failed') return false;
  return !isKnownUnretryableCodeReviewFailure(terminalReason, errorMessage);
}

function isInfraRetryAttempt(attempt: CloudAgentCodeReviewAttempt): boolean {
  return attempt.retry_reason === 'infra_failure' || attempt.retry_of_attempt_id !== null;
}

function isPreDispatchSandboxConnectFailure(failure?: CloudAgentSafeFailure): boolean {
  return failure?.stage === 'pre_dispatch' && failure.code === 'sandbox_connect_failed';
}

type FailedSessionUsage = NonNullable<Awaited<ReturnType<typeof getSessionUsageFromBilling>>>;

function failedSessionTokenCount(usage: FailedSessionUsage): number {
  return usage.totalTokensIn + usage.totalTokensOut;
}

function canRetryFailedSessionUsage(usage: FailedSessionUsage): boolean {
  return (
    usage.totalCostMusd < MAX_FAILED_SESSION_COST_MUSD_FOR_AUTO_RETRY &&
    failedSessionTokenCount(usage) < MAX_FAILED_SESSION_TOKENS_FOR_AUTO_RETRY
  );
}

async function shouldSkipAutoRetryForFailedSessionUsage(params: {
  reviewId: string;
  failedAttemptId: string;
  failedCliSessionId?: string | null;
  reviewCreatedAt: string;
  failure?: CloudAgentSafeFailure;
}): Promise<boolean> {
  if (!params.failedCliSessionId) {
    logExceptInTest('[code-review-status] Auto-retry token guard could not measure usage', {
      reviewId: params.reviewId,
      failedAttemptId: params.failedAttemptId,
      reason: 'missing_cli_session_id',
    });
    return false;
  }

  const usage = await getSessionUsageFromBilling(params.failedCliSessionId, params.reviewCreatedAt);
  if (!usage) {
    const allowUnavailableUsage = isPreDispatchSandboxConnectFailure(params.failure);
    logExceptInTest('[code-review-status] Auto-retry token guard could not measure usage', {
      reviewId: params.reviewId,
      failedAttemptId: params.failedAttemptId,
      cliSessionId: params.failedCliSessionId,
      reason: 'usage_unavailable',
      failureStage: params.failure?.stage,
      failureCode: params.failure?.code,
      allowUnavailableUsage,
    });
    return !allowUnavailableUsage;
  }

  const failedSessionTokens = failedSessionTokenCount(usage);
  if (canRetryFailedSessionUsage(usage)) {
    return false;
  }

  logExceptInTest('[code-review-status] Skipping infra retry after expensive failed session', {
    reviewId: params.reviewId,
    failedAttemptId: params.failedAttemptId,
    cliSessionId: params.failedCliSessionId,
    totalTokensIn: usage.totalTokensIn,
    totalTokensOut: usage.totalTokensOut,
    totalCostMusd: usage.totalCostMusd,
    failedSessionTokens,
    maxFailedSessionCostMusdForAutoRetry: MAX_FAILED_SESSION_COST_MUSD_FOR_AUTO_RETRY,
    maxFailedSessionTokensForAutoRetry: MAX_FAILED_SESSION_TOKENS_FOR_AUTO_RETRY,
  });
  return true;
}

function isSupersededReview(review: CloudAgentCodeReview): boolean {
  return review.terminal_reason === 'superseded';
}

async function resolveTerminalOwner(
  review: CloudAgentCodeReview,
  reviewId: string
): Promise<TerminalOwnerResolution | undefined> {
  if (review.owned_by_organization_id) {
    const botUserId = await getBotUserId(review.owned_by_organization_id, 'code-review');
    if (!botUserId) {
      errorExceptInTest('[code-review-status] Bot user not found for organization', {
        organizationId: review.owned_by_organization_id,
        reviewId,
      });
      captureMessage('Bot user missing for organization code review', {
        level: 'error',
        tags: { source: 'code-review-status' },
        extra: {
          organizationId: review.owned_by_organization_id,
          reviewId,
        },
      });
    }

    return {
      owner: {
        type: 'org',
        id: review.owned_by_organization_id,
        userId: botUserId ?? 'system',
      },
      canDispatch: !!botUserId,
    };
  }

  if (review.owned_by_user_id) {
    return {
      owner: {
        type: 'user',
        id: review.owned_by_user_id,
        userId: review.owned_by_user_id,
      },
      canDispatch: true,
    };
  }

  return undefined;
}

const GITHUB_COMMENT_MAX_CHARACTERS = 65_536;
const BILLING_NOTICE_MARKER = '<!-- kilo-billing-notice -->';
const MODEL_NOT_FOUND_SUMMARY_URL = 'https://app.kilo.ai/code-reviews';
const MODEL_NOT_FOUND_CHECK_TITLE = 'Selected model is no longer available';
const MODEL_NOT_FOUND_STATUS_SUMMARY = `The review did not run because the selected model is no longer available. Choose another model in Kilo Code review settings: ${MODEL_NOT_FOUND_SUMMARY_URL}`;
const MODEL_NOT_FOUND_GITLAB_DESCRIPTION = `Selected model is no longer available. Choose another model: ${MODEL_NOT_FOUND_SUMMARY_URL}`;

const MODEL_NOT_FOUND_SUMMARY_BODY = `<!-- kilo-review -->
## Code Review Summary

The review did not run because the selected model is no longer available.

Choose another model in Kilo Code review settings: ${MODEL_NOT_FOUND_SUMMARY_URL}`;

const BILLING_NOTICE_BODY = `${BILLING_NOTICE_MARKER}
**Kilo Code Review could not run — your account is out of credits.**

[Add credits](https://app.kilo.ai/) or [switch to a free model](https://app.kilo.ai/code-reviews) to enable reviews on this change.`;

/**
 * Read a review's usage data.
 *
 * Billing rows are the source of truth for review token usage. If no billing
 * usage exists, keep the persisted review totals because older reviews only
 * stored usage on the review row.
 */
async function getReviewUsageData(reviewId: string) {
  const review = await getCodeReviewById(reviewId);
  const persistedUsage = {
    model: review?.model ?? null,
    tokensIn: review?.total_tokens_in ?? 0,
    tokensOut: review?.total_tokens_out ?? 0,
    cachedTokens: 0,
  };

  if (!review?.cli_session_id || !review.created_at) {
    return persistedUsage;
  }

  const billing = await getSessionUsageFromBilling(
    review.cli_session_id,
    review.created_at,
    review.completed_at ?? undefined
  );
  if (!billing) {
    return persistedUsage;
  }

  updateCodeReviewUsage(reviewId, {
    ...(review.model == null ? { model: billing.model } : {}),
    totalTokensIn: billing.totalTokensIn,
    totalTokensOut: billing.totalTokensOut,
    totalCostMusd: billing.totalCostMusd,
  }).catch(err => {
    logExceptInTest('[code-review-status] Failed to back-fill usage from billing', err);
  });

  return {
    model: review.model ?? billing.model,
    tokensIn: billing.tokensIn,
    tokensOut: billing.tokensOut,
    cachedTokens: billing.cachedTokens,
  };
}

function getReviewGuidanceFooterData(review: CloudAgentCodeReview) {
  return {
    used: review.repository_review_instructions_used,
    ref: review.repository_review_instructions_ref,
    truncated: review.repository_review_instructions_truncated,
  };
}

/**
 * Maps a review status to a GitHub Check Run update.
 * Returns null for statuses that don't have a check run mapping (e.g. 'queued').
 *
 * When `gateResult` is `'fail'` and the review completed successfully (no system error),
 * the conclusion is set to `'failure'` — the agent determined that the review found
 * blocking issues (based on the `gate_threshold` setting in the agent config).
 */
function mapStatusToCheckRun(
  reviewStatus: string,
  errorMessage?: string,
  terminalReason?: CodeReviewTerminalReason,
  gateResult?: 'pass' | 'fail'
) {
  const statusMap: Record<string, 'in_progress' | 'completed'> = {
    running: 'in_progress',
    completed: 'completed',
    failed: 'completed',
    cancelled: 'completed',
  };

  const checkStatus = statusMap[reviewStatus];
  if (!checkStatus) return null;

  // When the review completed but the agent reported a gate failure
  // (e.g. findings exceeding the gate_threshold), fail the check.
  const reviewFailed = reviewStatus === 'completed' && gateResult === 'fail';
  const billingFailure =
    reviewStatus === 'failed' && isBillingCodeReviewTerminalReason(terminalReason, errorMessage);
  const actionRequiredReason =
    reviewStatus === 'failed'
      ? getActionRequiredTerminalReason(terminalReason, errorMessage)
      : null;
  const modelNotFoundCancellation =
    reviewStatus === 'cancelled' &&
    isModelNotFoundCodeReviewTerminalReason(terminalReason, errorMessage);
  const actionRequiredCopy = actionRequiredReason
    ? getCodeReviewActionRequiredCopy(actionRequiredReason)
    : null;

  const conclusionMap: Record<string, CheckRunConclusion> = {
    completed: reviewFailed ? 'failure' : 'success',
    failed: billingFailure || actionRequiredReason ? 'action_required' : 'failure',
    cancelled: 'cancelled',
  };

  const titleMap: Record<string, string> = {
    running: 'Kilo Code Review in progress',
    completed: reviewFailed ? 'Kilo Code Review found issues' : 'Kilo Code Review completed',
    failed: actionRequiredCopy
      ? actionRequiredCopy.checkTitle
      : billingFailure
        ? 'Insufficient credits to run review'
        : 'Kilo Code Review failed',
    cancelled: modelNotFoundCancellation
      ? MODEL_NOT_FOUND_CHECK_TITLE
      : 'Kilo Code Review cancelled',
  };

  const summaryMap: Record<string, string> = {
    running: 'Review is running...',
    completed: reviewFailed
      ? 'Code review completed with findings that require attention.'
      : 'Code review completed successfully.',
    failed: actionRequiredCopy
      ? actionRequiredCopy.checkSummary
      : billingFailure
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

/**
 * Maps a review status to a GitLab commit status state.
 */
function mapStatusToGitLabState(
  reviewStatus: string,
  gateResult?: 'pass' | 'fail'
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

function getGitLabStatusDescription(
  reviewStatus: string,
  errorMessage?: string,
  terminalReason?: CodeReviewTerminalReason,
  gateResult?: 'pass' | 'fail'
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
  const actionRequiredReason =
    reviewStatus === 'failed'
      ? getActionRequiredTerminalReason(terminalReason, errorMessage)
      : null;
  if (actionRequiredReason) {
    return getCodeReviewActionRequiredCopy(actionRequiredReason).gitlabDescription;
  }
  if (reviewStatus === 'failed' && errorMessage) {
    const desc = `Review failed: ${errorMessage}`;
    return desc.length > 255 ? desc.slice(0, 252) + '...' : desc;
  }
  if (reviewStatus === 'failed') return 'Kilo Code Review failed';
  return undefined;
}

async function upsertModelNotFoundSummary(
  review: CloudAgentCodeReview,
  integration: PlatformIntegration,
  gitlabAccessToken?: string
): Promise<void> {
  const platform = parseCodeReviewPlatform(review.platform);
  if (platform === PLATFORM.BITBUCKET) return;

  if (platform === PLATFORM.GITHUB && integration.platform_installation_id) {
    const [repoOwner, repoName] = review.repo_full_name.split('/');
    const appType: GitHubAppType = integration.github_app_type || 'standard';
    const existing = await findKiloReviewComment(
      integration.platform_installation_id,
      repoOwner,
      repoName,
      review.pr_number,
      appType
    );

    if (existing) {
      await updateKiloReviewComment(
        integration.platform_installation_id,
        repoOwner,
        repoName,
        existing.commentId,
        MODEL_NOT_FOUND_SUMMARY_BODY,
        appType
      );
    } else {
      await createPRComment(
        integration.platform_installation_id,
        repoOwner,
        repoName,
        review.pr_number,
        MODEL_NOT_FOUND_SUMMARY_BODY,
        appType
      );
    }

    logExceptInTest(
      `[code-review-status] Upserted model unavailable summary on ${review.repo_full_name}#${review.pr_number}`
    );
    return;
  }

  if (platform === PLATFORM.GITLAB) {
    const instanceUrl = getGitLabInstanceUrl(integration);
    const accessToken =
      gitlabAccessToken ??
      (await resolveGitLabAccessToken(integration, review.platform_project_id));
    const existing = await findKiloReviewNote(
      accessToken,
      review.repo_full_name,
      review.pr_number,
      instanceUrl
    );

    if (existing) {
      await updateKiloReviewNote(
        accessToken,
        review.repo_full_name,
        review.pr_number,
        existing.noteId,
        MODEL_NOT_FOUND_SUMMARY_BODY,
        instanceUrl
      );
    } else {
      await createMRNote(
        accessToken,
        review.repo_full_name,
        review.pr_number,
        MODEL_NOT_FOUND_SUMMARY_BODY,
        instanceUrl
      );
    }

    logExceptInTest(
      `[code-review-status] Upserted model unavailable summary on GitLab MR ${review.repo_full_name}!${review.pr_number}`
    );
  }
}

/**
 * Resolves a GitLab access token for a review's project.
 * Uses the exact project credential when a project ID is present.
 */
async function resolveGitLabAccessToken(
  integration: PlatformIntegration,
  projectId: number | null
): Promise<string> {
  let userId: string;
  let organizationId: string | undefined;
  if (integration.owned_by_organization_id) {
    organizationId = integration.owned_by_organization_id;
    const botUserId = await getBotUserId(organizationId, 'code-review');
    if (!botUserId) throw new Error('GitLab organization has no configured acting user');
    userId = botUserId;
  } else if (integration.owned_by_user_id) {
    userId = integration.owned_by_user_id;
  } else {
    throw new Error('GitLab integration has no owner');
  }
  const actor = { userId, ...(organizationId ? { organizationId } : {}) };
  return projectId
    ? await getValidGitLabProjectAccessToken(integration, projectId, actor)
    : await getValidGitLabToken(integration, actor);
}

/**
 * Extracts the GitLab instance URL from an integration's metadata.
 */
function getGitLabInstanceUrl(integration: PlatformIntegration): string {
  const metadata = integration.metadata as {
    gitlab_instance_url?: string;
  } | null;
  return metadata?.gitlab_instance_url || 'https://gitlab.com';
}

/**
 * Update the GitHub Check Run or GitLab commit status for a review.
 * Non-blocking — errors are logged but don't fail the callback.
 */
async function updatePRGateCheck(
  review: CloudAgentCodeReview,
  integration: PlatformIntegration,
  reviewStatus: string,
  errorMessage?: string,
  terminalReason?: CodeReviewTerminalReason,
  gitlabAccessToken?: string,
  gateResult?: 'pass' | 'fail'
) {
  const platform = parseCodeReviewPlatform(review.platform);
  if (platform === PLATFORM.BITBUCKET) return;
  const detailsUrl = `${APP_URL}/code-reviews/${review.id}`;

  const checkRunMapping = mapStatusToCheckRun(
    reviewStatus,
    errorMessage,
    terminalReason,
    gateResult
  );
  if (!checkRunMapping) return; // unsupported status (e.g. 'queued') — nothing to update

  if (platform === PLATFORM.GITHUB && integration.platform_installation_id) {
    // GitHub: update Check Run (only if we have a check_run_id)
    if (!review.check_run_id) return;

    const [repoOwner, repoName] = review.repo_full_name.split('/');

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
      integration.github_app_type ?? 'standard'
    );

    logExceptInTest(
      `[code-review-status] Updated check run for ${review.repo_full_name}#${review.pr_number}`,
      {
        status: checkRunMapping.status,
        conclusion: checkRunMapping.conclusion,
      }
    );
  } else if (platform === PLATFORM.GITLAB) {
    // GitLab: update commit status
    const instanceUrl = getGitLabInstanceUrl(integration);
    const projectId = review.platform_project_id;
    const accessToken =
      gitlabAccessToken ?? (await resolveGitLabAccessToken(integration, projectId));

    const state = mapStatusToGitLabState(reviewStatus, gateResult);

    await setCommitStatus(
      accessToken,
      projectId ?? review.repo_full_name,
      review.head_sha,
      state,
      {
        targetUrl: detailsUrl,
        description: getGitLabStatusDescription(
          reviewStatus,
          errorMessage,
          terminalReason,
          gateResult
        ),
      },
      instanceUrl
    );

    logExceptInTest(
      `[code-review-status] Updated commit status for GitLab MR ${review.repo_full_name}!${review.pr_number}`,
      { state }
    );
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ reviewId: string }> }
) {
  try {
    const { reviewId } = await params;
    const callbackAttemptId = req.nextUrl.searchParams.get('attemptId') ?? '';
    const callbackToken = req.headers.get('X-Callback-Token');
    const validCallbackToken =
      !!CALLBACK_TOKEN_SECRET &&
      (await verifyCallbackToken({
        token: callbackToken,
        secret: CALLBACK_TOKEN_SECRET,
        scope: 'code-review-status-callback',
        resourceParts: [reviewId, callbackAttemptId],
      }));
    if (!validCallbackToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const rawBody: unknown = await req.json();
    const parsedPayload = StatusUpdatePayloadSchema.safeParse(rawBody);
    if (!parsedPayload.success) {
      return NextResponse.json({ error: 'Invalid callback payload' }, { status: 400 });
    }

    const rawPayload = parsedPayload.data;
    const attemptId = callbackAttemptId || undefined;
    const { status, sessionId, cliSessionId, errorMessage, terminalReason, gateResult, failure } =
      normalizePayload(rawPayload);
    const executionId = rawPayload.executionId;
    const validGateResult = gateResult;

    const loggableErrorMessage = getLoggableStatusErrorMessage(errorMessage, terminalReason);
    logExceptInTest('[code-review-status] Received status update', {
      reviewId,
      attemptId,
      sessionId,
      cliSessionId,
      status,
      hasError: !!errorMessage,
      ...(loggableErrorMessage ? { errorMessage: loggableErrorMessage } : {}),
    });

    // Get current review to check if update is needed
    const review = await getCodeReviewById(reviewId);

    if (!review) {
      logExceptInTest('[code-review-status] Review not found', { reviewId });
      return NextResponse.json({ error: 'Review not found' }, { status: 404 });
    }

    const manualConfig = getManualCodeReviewConfig(review);
    const isManualReview = manualConfig !== null;
    const shouldPublishToProvider = shouldPublishCodeReviewToProvider(review);

    const callbackCompletedAt = new Date();
    let attempt: CloudAgentCodeReviewAttempt;
    let latestAttempt = await getLatestCodeReviewAttempt(reviewId);
    let analyticsCompletionApplied = false;
    // Code-owned council outcome for a completed council run. Set on whichever completion path
    // runs below, then used to drive the merge gate (the council LLM never sets `gateResult`).
    let councilResult: CodeReviewCouncilResult | null = null;

    if (
      status === 'completed' &&
      review.platform !== PLATFORM.BITBUCKET &&
      latestAttempt?.analytics_enabled_at_dispatch === true
    ) {
      const capture = parseCodeReviewAnalyticsManifest(rawPayload.lastAssistantMessageText, {
        assistantTextWasOmitted:
          rawPayload.lastAssistantMessageText === undefined &&
          rawPayload.lastAssistantMessageTextTruncation?.retainedUtf8ByteLength === 0,
      });
      // Compute once here: persisted atomically with the completion claim below AND reused to
      // drive the merge gate. `null` for standard (non-council) runs.
      councilResult = computeCouncilResultForReview({
        review,
        lastAssistantMessageText: rawPayload.lastAssistantMessageText,
      });
      const completionResult = await finalizeCompletedCodeReviewWithAnalytics({
        codeReviewId: reviewId,
        sourceAttemptId: attemptId,
        sessionId,
        cliSessionId,
        executionId,
        completedAt: callbackCompletedAt,
        capture,
        // Persist the council outcome atomically with the completion claim, so a council
        // write failure can't leave a completed council review without a result (redelivery
        // would short-circuit on the already-terminal parent). No-op for standard runs.
        councilResult,
      });

      if (completionResult.outcome !== 'applied') {
        return NextResponse.json({
          success: true,
          message:
            completionResult.outcome === 'stale'
              ? 'Stale callback from superseded attempt'
              : completionResult.outcome === 'terminal'
                ? 'Review already in terminal state'
                : 'Review completion already processed',
          outcome: completionResult.outcome,
          currentStatus: completionResult.currentStatus,
          terminalReason: completionResult.terminalReason,
        });
      }

      attempt = latestAttempt;
      analyticsCompletionApplied = true;
    } else {
      attempt = await updateCodeReviewAttemptForCallback({
        codeReviewId: reviewId,
        attemptId: attemptId ?? undefined,
        status,
        sessionId,
        cliSessionId,
        executionId,
        errorMessage,
        terminalReason,
        startedAt: status === 'running' ? callbackCompletedAt : undefined,
        completedAt:
          status === 'completed' || status === 'failed' || status === 'cancelled'
            ? callbackCompletedAt
            : undefined,
      });

      latestAttempt = await getLatestCodeReviewAttempt(reviewId);
      const isStaleAttempt = !!latestAttempt && attempt.id !== latestAttempt.id;
      if (isStaleAttempt) {
        logExceptInTest(
          '[code-review-status] Stale callback updated old attempt, skipping parent',
          {
            reviewId,
            attemptId: attempt.id,
            latestAttemptId: latestAttempt?.id,
            requestedStatus: status,
          }
        );
        return NextResponse.json({
          success: true,
          message: 'Stale callback from superseded attempt',
        });
      }
    }

    // Determine valid transitions based on incoming status
    const isTerminalState =
      review.status === 'completed' || review.status === 'failed' || review.status === 'cancelled';

    if (isTerminalState) {
      // Already in terminal state - skip parent update, but attempt history above is still recorded.
      logExceptInTest('[code-review-status] Review already in terminal state, skipping update', {
        reviewId,
        currentStatus: review.status,
        requestedStatus: status,
      });
      return NextResponse.json({
        success: true,
        message: 'Review already in terminal state',
        currentStatus: review.status,
        terminalReason: review.terminal_reason,
      });
    }

    // Defense-in-depth: reject callbacks from superseded sessions.
    // When the orchestrator retries with a fresh session after a failed
    // continuation attempt, a stale failure callback from the old session
    // may arrive and corrupt the new review's state.  If the review already
    // has a session_id and the callback carries a different sessionId, the
    // callback belongs to a previous (superseded) session — ignore it.
    const updatesLatestAttemptSession =
      sessionId && latestAttempt?.id === attempt.id && attempt.session_id === sessionId;
    if (
      !analyticsCompletionApplied &&
      sessionId &&
      review.session_id &&
      sessionId !== review.session_id &&
      !updatesLatestAttemptSession
    ) {
      logExceptInTest(
        '[code-review-status] Stale callback from superseded session, skipping update',
        {
          reviewId,
          callbackSessionId: sessionId,
          reviewSessionId: review.session_id,
          requestedStatus: status,
        }
      );
      return NextResponse.json({
        success: true,
        message: 'Stale callback from superseded session',
      });
    }

    const modelNotFoundRuntimeDiagnostics = getModelNotFoundRuntimeDiagnostics(
      rawPayload,
      terminalReason
    );

    let terminalOwnerResolution: TerminalOwnerResolution | undefined;
    const getTerminalOwnerResolution = async () => {
      terminalOwnerResolution ??= await resolveTerminalOwner(review, reviewId);
      return terminalOwnerResolution;
    };

    if (shouldAutoRetryCodeReviewFailure(status, terminalReason, errorMessage)) {
      const retryableReview = await getCodeReviewById(reviewId);
      if (!retryableReview || isSupersededReview(retryableReview)) {
        logExceptInTest('[code-review-status] Skipping infra retry for superseded review', {
          reviewId,
          status: retryableReview?.status,
          terminalReason: retryableReview?.terminal_reason,
        });
        return NextResponse.json({ success: true, retried: false, skipped: 'superseded' });
      }

      if (isInfraRetryAttempt(attempt)) {
        logExceptInTest('[code-review-status] Fresh retry attempt failed, terminalizing parent', {
          reviewId,
          failedAttemptId: attempt.id,
          retryOfAttemptId: attempt.retry_of_attempt_id,
          retryReason: attempt.retry_reason,
          sessionId,
        });
      } else {
        const failedCliSessionId = attempt.cli_session_id ?? cliSessionId ?? review.cli_session_id;
        const skipRetryForSessionUsage = await shouldSkipAutoRetryForFailedSessionUsage({
          reviewId,
          failedAttemptId: attempt.id,
          failedCliSessionId,
          reviewCreatedAt: review.created_at,
          failure,
        });

        if (!skipRetryForSessionUsage) {
          const retryAttemptResult = await createInfraRetryAttemptIfMissing({
            codeReviewId: reviewId,
            retryOfAttemptId: attempt.id,
          });

          if (retryAttemptResult.outcome === 'created') {
            const retryAttempt = retryAttemptResult.attempt;

            try {
              const latestReview = await getCodeReviewById(reviewId);
              if (!latestReview || isSupersededReview(latestReview)) {
                await updateCodeReviewAttemptForCallback({
                  codeReviewId: reviewId,
                  attemptId: retryAttempt.id,
                  status: 'cancelled',
                  errorMessage: 'Superseded by new push',
                  terminalReason: 'superseded',
                  completedAt: new Date(),
                });
                logExceptInTest('[code-review-status] Skipping fresh retry for superseded review', {
                  reviewId,
                  retryAttemptId: retryAttempt.id,
                  status: latestReview?.status,
                  terminalReason: latestReview?.terminal_reason,
                });
                return NextResponse.json({ success: true, retried: false, skipped: 'superseded' });
              }

              const retryResult = await codeReviewWorkerClient.retryReviewFresh(reviewId, {
                sessionId,
                reason: errorMessage ?? terminalReason ?? 'retryable infra failure',
                failedAttemptId: attempt.id,
                retryAttemptId: retryAttempt.id,
              });

              if (retryResult.success) {
                logExceptInTest('[code-review-status] Scheduled fresh retry after infra failure', {
                  reviewId,
                  failedAttemptId: attempt.id,
                  retryAttemptId: retryAttempt.id,
                  sessionId,
                });
                return NextResponse.json({ success: true, retried: true });
              }

              await updateCodeReviewAttemptForCallback({
                codeReviewId: reviewId,
                attemptId: retryAttempt.id,
                status: 'failed',
                errorMessage: 'Worker declined fresh retry after infra failure',
                terminalReason: 'sandbox_error',
                completedAt: new Date(),
              });
            } catch (retryError) {
              await updateCodeReviewAttemptForCallback({
                codeReviewId: reviewId,
                attemptId: retryAttempt.id,
                status: 'failed',
                errorMessage: retryError instanceof Error ? retryError.message : String(retryError),
                terminalReason: 'sandbox_error',
                completedAt: new Date(),
              });
              logExceptInTest('[code-review-status] Fresh retry startup failed, falling through', {
                reviewId,
                failedAttemptId: attempt.id,
                retryAttemptId: retryAttempt.id,
                error: retryError instanceof Error ? retryError.message : String(retryError),
              });
            }
          } else if (retryAttemptResult.outcome === 'existing-for-attempt') {
            logExceptInTest('[code-review-status] Fresh retry already queued for failed attempt', {
              reviewId,
              failedAttemptId: attempt.id,
              retryAttemptId: retryAttemptResult.attempt.id,
              sessionId,
            });
            return NextResponse.json({ success: true, retried: true });
          } else if (retryAttemptResult.outcome === 'existing-for-review') {
            logExceptInTest('[code-review-status] Fresh retry already consumed for review', {
              reviewId,
              failedAttemptId: attempt.id,
              retryAttemptId: retryAttemptResult.attempt.id,
              sessionId,
            });
            return NextResponse.json({ success: true, retried: false, skipped: 'already-retried' });
          } else if (retryAttemptResult.outcome === 'skipped-inactive') {
            logExceptInTest('[code-review-status] Skipping infra retry for inactive review', {
              reviewId,
              failedAttemptId: attempt.id,
              reviewStatus: retryAttemptResult.reviewStatus,
              terminalReason: retryAttemptResult.terminalReason,
            });
            return NextResponse.json({ success: true, retried: false, skipped: 'inactive' });
          }
        }
      }
    }

    // Valid transitions:
    // - queued -> running (orchestrator starting)
    // - running -> running (sessionId update)
    // - running -> completed/failed (callback)
    // - queued -> completed/failed (edge case: immediate failure)

    const parentStatusUpdates = {
      sessionId,
      cliSessionId,
      errorMessage,
      terminalReason,
      startedAt:
        status === 'running'
          ? review.started_at
            ? new Date(review.started_at)
            : new Date()
          : undefined,
      completedAt:
        status === 'completed' || status === 'failed' || status === 'cancelled'
          ? new Date()
          : undefined,
    };
    const isModelNotFoundCancellation =
      status === 'cancelled' &&
      isModelNotFoundCodeReviewTerminalReason(terminalReason, errorMessage);

    // Non-analytics completion path only: persist the council outcome BEFORE marking the
    // review completed. Writing it first means a `completed` council review always has a
    // `council_result`; if this write fails it throws, the callback returns an error, and
    // cloud-agent-next redelivers — retrying finalization — rather than leaving a completed
    // run permanently without a result. The ANALYTICS path is handled above, where
    // council_result is written atomically inside the completion transaction (its parent
    // is already completed by the time control reaches here, so the redelivery-retry design
    // would not hold on that path).
    if (status === 'completed' && review.review_type === 'council' && !analyticsCompletionApplied) {
      councilResult = await finalizeCouncilResultForReview({
        review,
        lastAssistantMessageText: rawPayload.lastAssistantMessageText,
      });
    }

    if (analyticsCompletionApplied) {
      // Parent and accepted attempt completion were claimed with analytics in one transaction.
    } else if (isModelNotFoundCancellation) {
      const claimedTerminalUpdate = await updateCodeReviewStatusIfNonTerminal(
        reviewId,
        status,
        parentStatusUpdates
      );
      if (!claimedTerminalUpdate) {
        logExceptInTest(
          '[code-review-status] Model unavailable cancellation was already persisted, skipping summary upsert',
          { reviewId }
        );
        return NextResponse.json({
          success: true,
          message: 'Review already in terminal state',
        });
      }
      if (modelNotFoundRuntimeDiagnostics) {
        captureRuntimeModelNotFoundDiagnostics({
          reviewId,
          sessionId,
          diagnostics: modelNotFoundRuntimeDiagnostics,
        });
      }
    } else {
      await updateCodeReviewStatus(reviewId, status, parentStatusUpdates);
    }

    let providerTerminalReason = terminalReason;
    const actionRequiredReason =
      status === 'failed' ? getActionRequiredTerminalReason(terminalReason, errorMessage) : null;
    if (actionRequiredReason && !isManualReview) {
      const ownerResolution = await getTerminalOwnerResolution();
      if (ownerResolution) {
        try {
          await disableCodeReviewForActionRequiredFailure({
            owner: ownerResolution.owner,
            platform: parseCodeReviewPlatform(review.platform),
            reviewId,
            reason: actionRequiredReason,
            errorMessage: errorMessage ?? actionRequiredReason,
          });
        } catch (disableError) {
          logExceptInTest(
            '[code-review-status] Failed to disable Code Reviewer for action-required failure:',
            disableError
          );
          captureException(disableError, {
            tags: { source: 'code-review-status-action-required-disable' },
            extra: { reviewId, reason: actionRequiredReason },
          });
        }
      }
    } else if (status === 'failed' && !isManualReview) {
      const ownerResolution = await getTerminalOwnerResolution();
      if (ownerResolution) {
        try {
          const repeatedCloneTimeoutReason = await disableCodeReviewForRepeatedCloneTimeoutsToday({
            owner: ownerResolution.owner,
            platform: parseCodeReviewPlatform(review.platform),
            reviewId,
            errorMessage,
          });
          if (repeatedCloneTimeoutReason) {
            providerTerminalReason = repeatedCloneTimeoutReason;
          }
        } catch (disableError) {
          logExceptInTest(
            '[code-review-status] Failed to disable Code Reviewer for repeated repository clone timeouts:',
            disableError
          );
          captureException(disableError, {
            tags: { source: 'code-review-status-repeated-clone-timeout-disable' },
            extra: { reviewId },
          });
        }
      }
    }

    // Fetch integration once — used for gate check updates and post-completion actions
    const integration =
      shouldPublishToProvider && review.platform_integration_id
        ? await getIntegrationById(review.platform_integration_id)
        : null;

    // Resolve GitLab token once, shared between gate check and reaction/footer logic
    const reviewPlatform = parseCodeReviewPlatform(review.platform);
    const isGitLab = reviewPlatform === PLATFORM.GITLAB;
    const gitlabAccessToken =
      integration && isGitLab
        ? await resolveGitLabAccessToken(integration, review.platform_project_id).catch(
            () => undefined
          )
        : undefined;

    // Council decisions are code-owned (the LLM never reports a `gateResult`), so derive the gate
    // from the computed decision. `councilGates` is the SINGLE source of truth for whether this
    // review actually enforces a merge gate: manual runs report the decision but never block merge
    // (GitHub has no check run; GitLab must not post a blocking commit status either). It drives
    // BOTH the gate result and the injected section's wording, so they can never disagree.
    // Advisory (decision `null`) never gates; a code-`block` under Unanimous/Majority fails the check.
    const isCompletedCouncil = status === 'completed' && review.review_type === 'council';
    const councilGates = isCompletedCouncil && !isManualReview;
    const effectiveGateResult = isCompletedCouncil
      ? councilGates && councilResult && councilDecisionBlocksMerge(councilResult.decision)
        ? 'fail'
        : 'pass'
      : validGateResult;
    // Code-owned Council Review section (decision, governance, per-specialist table), injected into
    // the summary comment below alongside the footer/history update (one fetch + one update).
    const councilSection =
      isCompletedCouncil && councilResult
        ? buildCouncilReviewSection(councilResult, { gates: councilGates })
        : null;

    if (integration) {
      try {
        await updatePRGateCheck(
          review,
          integration,
          status,
          errorMessage,
          providerTerminalReason,
          gitlabAccessToken,
          effectiveGateResult
        );
      } catch (gateCheckError) {
        logExceptInTest('[code-review-status] Failed to update PR gate check:', gateCheckError);
        const isTerminal = status === 'completed' || status === 'failed' || status === 'cancelled';
        if (isTerminal) {
          captureException(gateCheckError, {
            tags: { source: 'code-review-status-gate-check' },
            extra: {
              reviewId,
              status,
              checkRunId: String(review.check_run_id ?? ''),
            },
          });
        }
      }
    }

    if (integration && isModelNotFoundCancellation) {
      try {
        await upsertModelNotFoundSummary(review, integration, gitlabAccessToken);
      } catch (summaryError) {
        logExceptInTest(
          '[code-review-status] Failed to upsert model unavailable summary:',
          summaryError
        );
        captureException(summaryError, {
          tags: { source: 'code-review-status-model-not-found-summary' },
          extra: { reviewId, platform: reviewPlatform },
        });
      }
    }

    logExceptInTest('[code-review-status] Updated review status', {
      reviewId,
      sessionId,
      cliSessionId,
      status,
    });

    // Only trigger dispatch for terminal states (completed/failed/cancelled)
    // This frees up a slot for the next pending review
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      const ownerResolution = await getTerminalOwnerResolution();
      if (ownerResolution?.canDispatch) {
        // Trigger dispatch in background (don't await - fire and forget)
        tryDispatchPendingReviews(ownerResolution.owner).catch(dispatchError => {
          errorExceptInTest(
            '[code-review-status] Error dispatching pending reviews:',
            dispatchError
          );
          captureException(dispatchError, {
            tags: { source: 'code-review-status-dispatch' },
            extra: { reviewId, owner: ownerResolution.owner },
          });
        });

        logExceptInTest('[code-review-status] Triggered dispatch for pending reviews', {
          reviewId,
          owner: ownerResolution.owner,
        });
      }

      // Add reaction to indicate review completion status and finalize summary metadata
      if (status === 'completed' || status === 'failed') {
        if (integration) {
          try {
            const platform = parseCodeReviewPlatform(review.platform);

            if (platform === PLATFORM.GITHUB && integration.platform_installation_id) {
              const [repoOwner, repoName] = review.repo_full_name.split('/');
              const appType: GitHubAppType = integration.github_app_type || 'standard';

              // Reaction
              const reaction = status === 'completed' ? 'hooray' : 'confused';
              await addReactionToPR(
                integration.platform_installation_id,
                repoOwner,
                repoName,
                review.pr_number,
                reaction,
                appType
              );
              logExceptInTest(
                `[code-review-status] Added ${reaction} reaction to ${review.repo_full_name}#${review.pr_number}`
              );

              // Billing notice (failed + billing only)
              if (
                status === 'failed' &&
                isBillingCodeReviewTerminalReason(terminalReason, errorMessage)
              ) {
                const alreadyPosted = await hasPRCommentWithMarker(
                  integration.platform_installation_id,
                  repoOwner,
                  repoName,
                  review.pr_number,
                  BILLING_NOTICE_MARKER,
                  appType
                );
                if (!alreadyPosted) {
                  await createPRComment(
                    integration.platform_installation_id,
                    repoOwner,
                    repoName,
                    review.pr_number,
                    BILLING_NOTICE_BODY,
                    appType
                  );
                  logExceptInTest(
                    `[code-review-status] Posted billing notice on ${review.repo_full_name}#${review.pr_number}`
                  );
                }
              }

              // Summary history and footer (completed only)
              if (status === 'completed') {
                const { model, tokensIn, tokensOut, cachedTokens } =
                  await getReviewUsageData(reviewId);
                const usage = model ? { model, tokensIn, tokensOut, cachedTokens } : undefined;
                const reviewGuidance = getReviewGuidanceFooterData(review);
                const summaryFooter = { usage, reviewGuidance };
                const reservedFooterCharacters = buildReviewSummaryFooter(summaryFooter).length;

                const existing = await findKiloReviewComment(
                  integration.platform_installation_id,
                  repoOwner,
                  repoName,
                  review.pr_number,
                  appType
                );
                if (existing) {
                  // Inject the code-owned Council Review section first (no-op for non-council),
                  // then history + footer, so the whole comment updates in a single PATCH.
                  const baseBody = councilSection
                    ? upsertCouncilVerdictInBody(existing.body, councilSection)
                    : existing.body;
                  const bodyWithHistory = appendPreviousReviewSummaryHistory(
                    baseBody,
                    review.previous_summary_body,
                    review.previous_summary_head_sha,
                    {
                      maxBodyCharacters: GITHUB_COMMENT_MAX_CHARACTERS,
                      reservedCharacters: reservedFooterCharacters,
                    }
                  );
                  const bodyWithFooter = appendReviewSummaryFooter(bodyWithHistory, summaryFooter);
                  const updatedBody =
                    bodyWithFooter.length <= GITHUB_COMMENT_MAX_CHARACTERS
                      ? bodyWithFooter
                      : bodyWithHistory;
                  if (updatedBody !== existing.body) {
                    await updateKiloReviewComment(
                      integration.platform_installation_id,
                      repoOwner,
                      repoName,
                      existing.commentId,
                      updatedBody,
                      appType
                    );
                    logExceptInTest(
                      `[code-review-status] Updated summary comment metadata on ${review.repo_full_name}#${review.pr_number}`
                    );
                  }
                }
              }
            } else if (platform === PLATFORM.GITLAB) {
              const instanceUrl = getGitLabInstanceUrl(integration);
              const accessToken =
                gitlabAccessToken ??
                (await resolveGitLabAccessToken(integration, review.platform_project_id));

              // Reaction
              const emoji = status === 'completed' ? 'tada' : 'confused';
              await addReactionToMR(
                accessToken,
                review.repo_full_name,
                review.pr_number,
                emoji,
                instanceUrl
              );
              logExceptInTest(
                `[code-review-status] Added ${emoji} reaction to GitLab MR ${review.repo_full_name}!${review.pr_number}`
              );

              // Billing notice (failed + billing only)
              if (
                status === 'failed' &&
                isBillingCodeReviewTerminalReason(terminalReason, errorMessage)
              ) {
                const alreadyPosted = await hasMRNoteWithMarker(
                  accessToken,
                  review.repo_full_name,
                  review.pr_number,
                  BILLING_NOTICE_MARKER,
                  instanceUrl
                );
                if (!alreadyPosted) {
                  await createMRNote(
                    accessToken,
                    review.repo_full_name,
                    review.pr_number,
                    BILLING_NOTICE_BODY,
                    instanceUrl
                  );
                  logExceptInTest(
                    `[code-review-status] Posted billing notice on GitLab MR ${review.repo_full_name}!${review.pr_number}`
                  );
                }
              }

              // Summary history and footer (completed only)
              if (status === 'completed') {
                const { model, tokensIn, tokensOut, cachedTokens } =
                  await getReviewUsageData(reviewId);
                const usage = model ? { model, tokensIn, tokensOut, cachedTokens } : undefined;
                const reviewGuidance = getReviewGuidanceFooterData(review);

                const existing = await findKiloReviewNote(
                  accessToken,
                  review.repo_full_name,
                  review.pr_number,
                  instanceUrl
                );
                if (existing) {
                  // Inject the code-owned Council Review section first (no-op for non-council),
                  // then history + footer, so the whole note updates in a single PUT.
                  const baseBody = councilSection
                    ? upsertCouncilVerdictInBody(existing.body, councilSection)
                    : existing.body;
                  const bodyWithHistory = appendPreviousReviewSummaryHistory(
                    baseBody,
                    review.previous_summary_body,
                    review.previous_summary_head_sha
                  );
                  const updatedBody = appendReviewSummaryFooter(bodyWithHistory, {
                    usage,
                    reviewGuidance,
                  });
                  if (updatedBody !== existing.body) {
                    await updateKiloReviewNote(
                      accessToken,
                      review.repo_full_name,
                      review.pr_number,
                      existing.noteId,
                      updatedBody,
                      instanceUrl
                    );
                    logExceptInTest(
                      `[code-review-status] Updated summary note metadata on GitLab MR ${review.repo_full_name}!${review.pr_number}`
                    );
                  }
                }
              }
            } else if (platform === PLATFORM.BITBUCKET) {
              logExceptInTest(
                '[code-review-status] Skipping deferred Bitbucket provider completion actions',
                { reviewId }
              );
            }
          } catch (postCompletionError) {
            // Non-blocking - log but don't fail the callback
            logExceptInTest(
              '[code-review-status] Failed to add completion reaction or summary metadata:',
              postCompletionError
            );
          }
        }
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    errorExceptInTest('[code-review-status] Error processing status update:', error);
    captureException(error, {
      tags: { source: 'code-review-status-api' },
    });

    return NextResponse.json(
      {
        error: 'Failed to process status update',
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
