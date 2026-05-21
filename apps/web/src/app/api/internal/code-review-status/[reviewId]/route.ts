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
import {
  updateCodeReviewStatus,
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
  getValidGitLabToken,
  getStoredProjectAccessToken,
} from '@/lib/integrations/gitlab-service';
import { captureException, captureMessage } from '@sentry/nextjs';
import { CALLBACK_TOKEN_SECRET } from '@/lib/config.server';
import { verifyCallbackToken } from '@kilocode/worker-utils/callback-token';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { appendReviewSummaryFooter } from '@/lib/code-reviews/summary/usage-footer';
import { APP_URL } from '@/lib/constants';
import type { CloudAgentCodeReview, PlatformIntegration } from '@kilocode/db/schema';
import type { GitHubAppType } from '@/lib/integrations/platforms/github/app-selector';
import {
  CODE_REVIEW_TERMINAL_REASONS,
  type CodeReviewTerminalReason,
} from '@kilocode/db/schema-types';

/**
 * Payload from the orchestrator DO (legacy format).
 */
type OrchestratorPayload = {
  sessionId?: string;
  cliSessionId?: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  errorMessage?: string;
  terminalReason?: CodeReviewTerminalReason;
  gateResult?: 'pass' | 'fail';
};

/**
 * Payload from cloud-agent-next callback (ExecutionCallbackPayload).
 */
type CloudAgentNextCallbackPayload = {
  sessionId?: string;
  cloudAgentSessionId?: string;
  executionId?: string;
  kiloSessionId?: string;
  status: 'completed' | 'failed' | 'interrupted';
  errorMessage?: string;
  terminalReason?: CodeReviewTerminalReason;
  lastSeenBranch?: string;
  gateResult?: 'pass' | 'fail';
};

type StatusUpdatePayload = OrchestratorPayload | CloudAgentNextCallbackPayload;

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

  // Validate terminalReason against allowlist to prevent free-form text in the DB
  const validReasons: ReadonlySet<string> = new Set(CODE_REVIEW_TERMINAL_REASONS);
  let terminalReason: CodeReviewTerminalReason | undefined =
    raw.terminalReason && validReasons.has(raw.terminalReason) ? raw.terminalReason : undefined;

  // Infer billing when no explicit terminalReason was provided.
  // v1: billing errors arrive as 'interrupted' (→ cancelled) with billing error text
  // v2: billing errors arrive as 'failed' with billing error text (after wrapper fix)
  if (!terminalReason && isBillingCodeReviewTerminalReason(undefined, raw.errorMessage)) {
    if (status === 'cancelled') {
      status = 'failed'; // billing is not a user cancellation
    }
    terminalReason = 'billing';
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
  };
}

function isBillingCodeReviewTerminalReason(
  terminalReason?: CodeReviewTerminalReason,
  errorMessage?: string | null
): boolean {
  if (terminalReason === 'billing') {
    return true;
  }

  const message = errorMessage?.toLowerCase();
  if (!message) {
    return false;
  }

  return ['insufficient credits', 'paid model', 'add credits', 'credits required'].some(pattern =>
    message.includes(pattern)
  );
}

function isRetryableInfraFailure(
  status: 'running' | 'completed' | 'failed' | 'cancelled',
  terminalReason?: CodeReviewTerminalReason,
  errorMessage?: string
): boolean {
  if (status !== 'failed') return false;
  if (terminalReason === 'billing') return false;
  if (isBillingCodeReviewTerminalReason(terminalReason, errorMessage)) return false;

  const message = errorMessage?.toLowerCase();
  if (!message) return false;

  if (message.includes('execution exceeded maximum runtime')) return false;
  if (message.includes('cancelled') || message.includes('canceled')) return false;
  if (message.includes('superseded')) return false;
  if (message.includes('user interrupted')) return false;

  return (
    message.includes('container shutdown: sigterm') ||
    message.includes('execution timeout - no heartbeat received') ||
    ((message.includes('sandbox') ||
      message.includes('container') ||
      message.includes('cloudflare')) &&
      (message.includes('http 500') ||
        message.includes('status: 500') ||
        message.includes('internal server error') ||
        message.includes('internal_server_error')))
  );
}

function isSupersededReview(review: CloudAgentCodeReview): boolean {
  return review.terminal_reason === 'superseded';
}

const BILLING_NOTICE_MARKER = '<!-- kilo-billing-notice -->';

const BILLING_NOTICE_BODY = `${BILLING_NOTICE_MARKER}
**Kilo Code Review could not run — your account is out of credits.**

[Add credits](https://app.kilo.ai/) or [switch to a free model](https://app.kilo.ai/code-reviews) to enable reviews on this change.`;

/**
 * Read a review's usage data.
 *
 * For v1 (SSE) reviews the orchestrator writes usage to the record just
 * before the completion callback, so a short poll handles the race.
 * For v2 (cloud-agent-next) the orchestrator never writes usage — we
 * skip the poll and go straight to the billing tables.
 *
 * When the billing fallback is used we also back-fill the code_reviews
 * record so later reads (e.g. admin panel) don't repeat the aggregation.
 */
async function getReviewUsageData(reviewId: string) {
  let review = await getCodeReviewById(reviewId);

  // v1 only: poll briefly — usage may arrive from the orchestrator
  // right before the callback. v2 never writes usage to the record,
  // so polling would just waste ~1.4s for nothing.
  if (review && !review.model && review.agent_version !== 'v2') {
    const MAX_RETRIES = 3;
    const BASE_DELAY_MS = 200;
    for (let attempt = 0; attempt < MAX_RETRIES && review && !review.model; attempt++) {
      await new Promise(resolve => setTimeout(resolve, BASE_DELAY_MS * 2 ** attempt));
      review = await getCodeReviewById(reviewId);
    }
  }

  if (review?.model) {
    return {
      model: review.model,
      tokensIn: review.total_tokens_in ?? null,
      tokensOut: review.total_tokens_out ?? null,
    };
  }

  // Fallback: aggregate from billing tables (covers v2 / cloud-agent-next reviews)
  if (review?.cli_session_id && review.created_at) {
    const billing = await getSessionUsageFromBilling(review.cli_session_id, review.created_at);
    if (billing) {
      // Back-fill the code_reviews record so we don't repeat this aggregation
      updateCodeReviewUsage(reviewId, {
        model: billing.model,
        totalTokensIn: billing.totalTokensIn,
        totalTokensOut: billing.totalTokensOut,
        totalCostMusd: billing.totalCostMusd,
      }).catch(err => {
        logExceptInTest('[code-review-status] Failed to back-fill usage from billing', err);
      });

      return {
        model: billing.model,
        tokensIn: billing.totalTokensIn,
        tokensOut: billing.totalTokensOut,
      };
    }
  }

  return { model: null, tokensIn: null, tokensOut: null };
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

  const conclusionMap: Record<string, CheckRunConclusion> = {
    completed: reviewFailed ? 'failure' : 'success',
    failed: billingFailure ? 'action_required' : 'failure',
    cancelled: 'cancelled',
  };

  const titleMap: Record<string, string> = {
    running: 'Kilo Code Review in progress',
    completed: reviewFailed ? 'Kilo Code Review found issues' : 'Kilo Code Review completed',
    failed: billingFailure ? 'Insufficient credits to run review' : 'Kilo Code Review failed',
    cancelled: 'Kilo Code Review cancelled',
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
    cancelled: 'Review was cancelled.',
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
  if (reviewStatus === 'cancelled') return 'Kilo Code Review cancelled';
  if (
    reviewStatus === 'failed' &&
    isBillingCodeReviewTerminalReason(terminalReason, errorMessage)
  ) {
    return 'Insufficient credits to run review';
  }
  if (reviewStatus === 'failed' && errorMessage) {
    const desc = `Review failed: ${errorMessage}`;
    return desc.length > 255 ? desc.slice(0, 252) + '...' : desc;
  }
  if (reviewStatus === 'failed') return 'Kilo Code Review failed';
  return undefined;
}

/**
 * Resolves a GitLab access token for a review's project.
 * Prefers a stored Project Access Token; falls back to the user's OAuth token.
 */
async function resolveGitLabAccessToken(
  integration: PlatformIntegration,
  projectId: number | null
): Promise<string> {
  const storedPrat = projectId ? getStoredProjectAccessToken(integration, projectId) : null;
  return storedPrat ? storedPrat.token : await getValidGitLabToken(integration);
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
  const platform = review.platform || 'github';
  const detailsUrl = `${APP_URL}/code-reviews/${review.id}`;

  const checkRunMapping = mapStatusToCheckRun(
    reviewStatus,
    errorMessage,
    terminalReason,
    gateResult
  );
  if (!checkRunMapping) return; // unsupported status (e.g. 'queued') — nothing to update

  if (platform === 'github' && integration.platform_installation_id) {
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

    const rawPayload: StatusUpdatePayload = await req.json();
    const attemptId = callbackAttemptId || undefined;
    const { status, sessionId, cliSessionId, errorMessage, terminalReason, gateResult } =
      normalizePayload(rawPayload);
    const executionId = 'executionId' in rawPayload ? rawPayload.executionId : undefined;

    // Validate payload
    if (!status) {
      return NextResponse.json({ error: 'Missing required field: status' }, { status: 400 });
    }

    // Warn on unexpected gateResult values so agent-side typos surface early
    const validGateResult = gateResult === 'pass' || gateResult === 'fail' ? gateResult : undefined;
    if (gateResult && !validGateResult) {
      logExceptInTest('[code-review-status] Unexpected gateResult value, ignoring', {
        gateResult,
      });
    }

    logExceptInTest('[code-review-status] Received status update', {
      reviewId,
      attemptId,
      sessionId,
      cliSessionId,
      status,
      hasError: !!errorMessage,
      ...(errorMessage ? { errorMessage } : {}),
    });

    // Get current review to check if update is needed
    const review = await getCodeReviewById(reviewId);

    if (!review) {
      logExceptInTest('[code-review-status] Review not found', { reviewId });
      return NextResponse.json({ error: 'Review not found' }, { status: 404 });
    }

    const attempt = await updateCodeReviewAttemptForCallback({
      codeReviewId: reviewId,
      attemptId: attemptId ?? undefined,
      status,
      sessionId,
      cliSessionId,
      executionId,
      errorMessage,
      terminalReason,
      startedAt: status === 'running' ? new Date() : undefined,
      completedAt:
        status === 'completed' || status === 'failed' || status === 'cancelled'
          ? new Date()
          : undefined,
    });

    const latestAttempt = await getLatestCodeReviewAttempt(reviewId);
    const isStaleAttempt = !!latestAttempt && attempt.id !== latestAttempt.id;
    if (isStaleAttempt) {
      logExceptInTest('[code-review-status] Stale callback updated old attempt, skipping parent', {
        reviewId,
        attemptId: attempt.id,
        latestAttemptId: latestAttempt?.id,
        requestedStatus: status,
      });
      return NextResponse.json({
        success: true,
        message: 'Stale callback from superseded attempt',
      });
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

    if (isRetryableInfraFailure(status, terminalReason, errorMessage)) {
      const retryableReview = await getCodeReviewById(reviewId);
      if (!retryableReview || isSupersededReview(retryableReview)) {
        logExceptInTest('[code-review-status] Skipping infra retry for superseded review', {
          reviewId,
          status: retryableReview?.status,
          terminalReason: retryableReview?.terminal_reason,
        });
        return NextResponse.json({ success: true, retried: false, skipped: 'superseded' });
      }

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
            logExceptInTest('[code-review-status] Started fresh retry after infra failure', {
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

    // Valid transitions:
    // - queued -> running (orchestrator starting)
    // - running -> running (sessionId update)
    // - running -> completed/failed (callback)
    // - queued -> completed/failed (edge case: immediate failure)

    // Fetch integration once — used for gate check updates and post-completion actions
    const integration = review.platform_integration_id
      ? await getIntegrationById(review.platform_integration_id)
      : null;

    // Resolve GitLab token once, shared between gate check and reaction/footer logic
    const isGitLab = (review.platform || 'github') === PLATFORM.GITLAB;
    const gitlabAccessToken =
      integration && isGitLab
        ? await resolveGitLabAccessToken(integration, review.platform_project_id).catch(
            () => undefined
          )
        : undefined;

    // Update PR gate check BEFORE writing terminal DB state.
    // Once the DB moves to a terminal status, subsequent callbacks hit the early-return
    // above, so a flaky gate update would be unrecoverable.
    if (integration) {
      try {
        await updatePRGateCheck(
          review,
          integration,
          status,
          errorMessage,
          terminalReason,
          gitlabAccessToken,
          validGateResult
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
          // Abort so the caller retries — once the DB moves to a terminal status
          // the early-return above prevents any later attempt to update the gate.
          throw gateCheckError;
        }
      }
    }

    // Update review status in database
    await updateCodeReviewStatus(reviewId, status, {
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
    });

    logExceptInTest('[code-review-status] Updated review status', {
      reviewId,
      sessionId,
      cliSessionId,
      status,
    });

    // Only trigger dispatch for terminal states (completed/failed/cancelled)
    // This frees up a slot for the next pending review
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      let owner: Parameters<typeof tryDispatchPendingReviews>[0] | undefined;
      if (review.owned_by_organization_id) {
        const botUserId = await getBotUserId(review.owned_by_organization_id, 'code-review');
        if (botUserId) {
          owner = {
            type: 'org' as const,
            id: review.owned_by_organization_id,
            userId: botUserId,
          };
        } else {
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
      } else {
        owner = {
          type: 'user' as const,
          id: review.owned_by_user_id || '',
          userId: review.owned_by_user_id || '',
        };
      }

      if (owner) {
        // Trigger dispatch in background (don't await - fire and forget)
        tryDispatchPendingReviews(owner).catch(dispatchError => {
          errorExceptInTest(
            '[code-review-status] Error dispatching pending reviews:',
            dispatchError
          );
          captureException(dispatchError, {
            tags: { source: 'code-review-status-dispatch' },
            extra: { reviewId, owner },
          });
        });

        logExceptInTest('[code-review-status] Triggered dispatch for pending reviews', {
          reviewId,
          owner,
        });
      }

      // Add reaction to indicate review completion status AND update usage footer
      if (status === 'completed' || status === 'failed') {
        if (integration) {
          try {
            const platform = review.platform || 'github';

            if (platform === 'github' && integration.platform_installation_id) {
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

              // Usage footer (completed only)
              if (status === 'completed') {
                const { model, tokensIn, tokensOut } = await getReviewUsageData(reviewId);
                const usage =
                  model && tokensIn != null && tokensOut != null
                    ? { model, tokensIn, tokensOut }
                    : undefined;
                const reviewGuidance = getReviewGuidanceFooterData(review);

                if (usage || reviewGuidance.used) {
                  const existing = await findKiloReviewComment(
                    integration.platform_installation_id,
                    repoOwner,
                    repoName,
                    review.pr_number,
                    appType
                  );
                  if (existing) {
                    const updatedBody = appendReviewSummaryFooter(existing.body, {
                      usage,
                      reviewGuidance,
                    });
                    await updateKiloReviewComment(
                      integration.platform_installation_id,
                      repoOwner,
                      repoName,
                      existing.commentId,
                      updatedBody,
                      appType
                    );
                    logExceptInTest(
                      `[code-review-status] Updated summary comment footer on ${review.repo_full_name}#${review.pr_number}`
                    );
                  }
                } else {
                  logExceptInTest(
                    '[code-review-status] Usage data not available for footer update',
                    {
                      reviewId,
                      model,
                      tokensIn,
                      tokensOut,
                    }
                  );
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

              // Usage footer (completed only)
              if (status === 'completed') {
                const { model, tokensIn, tokensOut } = await getReviewUsageData(reviewId);
                const usage =
                  model && tokensIn != null && tokensOut != null
                    ? { model, tokensIn, tokensOut }
                    : undefined;
                const reviewGuidance = getReviewGuidanceFooterData(review);

                if (usage || reviewGuidance.used) {
                  const existing = await findKiloReviewNote(
                    accessToken,
                    review.repo_full_name,
                    review.pr_number,
                    instanceUrl
                  );
                  if (existing) {
                    const updatedBody = appendReviewSummaryFooter(existing.body, {
                      usage,
                      reviewGuidance,
                    });
                    await updateKiloReviewNote(
                      accessToken,
                      review.repo_full_name,
                      review.pr_number,
                      existing.noteId,
                      updatedBody,
                      instanceUrl
                    );
                    logExceptInTest(
                      `[code-review-status] Updated summary note footer on GitLab MR ${review.repo_full_name}!${review.pr_number}`
                    );
                  }
                } else {
                  logExceptInTest(
                    '[code-review-status] Usage data not available for footer update',
                    {
                      reviewId,
                      model,
                      tokensIn,
                      tokensOut,
                    }
                  );
                }
              }
            }
          } catch (postCompletionError) {
            // Non-blocking - log but don't fail the callback
            logExceptInTest(
              '[code-review-status] Failed to add completion reaction or usage footer:',
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
