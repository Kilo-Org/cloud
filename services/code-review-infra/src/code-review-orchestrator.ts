/**
 * CodeReviewOrchestrator - Durable Object for managing code review lifecycle.
 *
 * Dispatches Cloud Agent Next sessions and tracks callback-based completion.
 */

import { DurableObject } from 'cloudflare:workers';
import {
  createCloudAgentNextFetchClient,
  CloudAgentNextBillingError,
  CloudAgentNextError,
  deriveCallbackToken,
  type CloudAgentNextFetchClient,
  type CloudAgentPrepareSessionInput,
  type CloudAgentSessionHealthOutput,
  type CloudAgentTerminalReason,
} from '@kilocode/worker-utils';
import type {
  Env,
  CodeReview,
  CodeReviewStatus,
  CodeReviewStatusResponse,
  CodeReviewStatusResult,
  SessionInput,
  ReviewAgentsConfig,
} from './types';
import { InternalStatusResponseSchema } from './types';
import { doNameForAttempt } from './do-name';
import {
  buildGitHubCloudReviewSkillCue,
  GITHUB_CLOUD_REVIEW_SKILL,
  GITHUB_CLOUD_REVIEW_SKILL_NAME,
  GITHUB_CLOUD_REVIEW_SKILL_VERSION,
} from './github-cloud-review-skill';
import {
  BITBUCKET_CLOUD_REVIEW_SKILL,
  BITBUCKET_CLOUD_REVIEW_SKILL_NAME,
  BITBUCKET_CLOUD_REVIEW_SKILL_VERSION,
  buildBitbucketCloudReviewSkillCue,
} from './bitbucket-cloud-review-skill';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BITBUCKET_SLUG_PATTERN = /^[A-Za-z0-9_.-]+$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

type BitbucketCloudReviewSessionInput = SessionInput &
  Required<
    Pick<
      SessionInput,
      | 'gitUrl'
      | 'kilocodeOrganizationId'
      | 'bitbucketWorkspaceUuid'
      | 'bitbucketWorkspaceSlug'
      | 'bitbucketRepositoryUuid'
      | 'bitbucketRepositorySlug'
      | 'bitbucketIntegrationId'
      | 'bitbucketPullRequestId'
      | 'bitbucketExpectedHeadSha'
    >
  > & { platform: 'bitbucket' };

export function isBitbucketCloudReviewSessionInput(
  sessionInput: SessionInput
): sessionInput is BitbucketCloudReviewSessionInput {
  return (
    sessionInput.platform === 'bitbucket' &&
    typeof sessionInput.gitUrl === 'string' &&
    sessionInput.gitUrl.trim().length > 0 &&
    typeof sessionInput.kilocodeOrganizationId === 'string' &&
    UUID_PATTERN.test(sessionInput.kilocodeOrganizationId) &&
    typeof sessionInput.bitbucketWorkspaceUuid === 'string' &&
    UUID_PATTERN.test(sessionInput.bitbucketWorkspaceUuid) &&
    typeof sessionInput.bitbucketWorkspaceSlug === 'string' &&
    BITBUCKET_SLUG_PATTERN.test(sessionInput.bitbucketWorkspaceSlug) &&
    typeof sessionInput.bitbucketRepositoryUuid === 'string' &&
    UUID_PATTERN.test(sessionInput.bitbucketRepositoryUuid) &&
    typeof sessionInput.bitbucketRepositorySlug === 'string' &&
    BITBUCKET_SLUG_PATTERN.test(sessionInput.bitbucketRepositorySlug) &&
    typeof sessionInput.bitbucketIntegrationId === 'string' &&
    UUID_PATTERN.test(sessionInput.bitbucketIntegrationId) &&
    typeof sessionInput.bitbucketPullRequestId === 'number' &&
    Number.isSafeInteger(sessionInput.bitbucketPullRequestId) &&
    sessionInput.bitbucketPullRequestId > 0 &&
    typeof sessionInput.bitbucketExpectedHeadSha === 'string' &&
    GIT_SHA_PATTERN.test(sessionInput.bitbucketExpectedHeadSha)
  );
}

function callbackUrlForAttempt(apiUrl: string, reviewId: string, attemptId?: string): string {
  const url = new URL(`/api/internal/code-review-status/${reviewId}`, apiUrl);
  if (attemptId) {
    url.searchParams.set('attemptId', attemptId);
  }
  return url.toString();
}

async function callbackTargetForAttempt(
  apiUrl: string,
  reviewId: string,
  attemptId: string | undefined,
  callbackTokenSecret: string
): Promise<{ url: string; headers: { 'X-Callback-Token': string } }> {
  return {
    url: callbackUrlForAttempt(apiUrl, reviewId, attemptId),
    headers: {
      'X-Callback-Token': await deriveCallbackToken({
        secret: callbackTokenSecret,
        scope: 'code-review-status-callback',
        resourceParts: [reviewId, attemptId ?? ''],
      }),
    },
  };
}

type UpdateStatusResult = 'updated' | 'db-terminal';

function canContinueCloudAgentNextSession(health: CloudAgentSessionHealthOutput): boolean {
  return (
    health.sandboxStatus === 'healthy' &&
    health.executionHealth === 'none' &&
    health.activeExecutionId === undefined
  );
}

const SELECTED_MODEL_UNAVAILABLE_MESSAGE =
  'selected model is not available for this cloud agent session';
const REQUESTED_MODEL_NOT_ALLOWED_FOR_TEAM_MESSAGE =
  'the requested model is not allowed for your team';

function isSelectedModelActionRequiredMessage(message: string): boolean {
  return (
    message.includes(SELECTED_MODEL_UNAVAILABLE_MESSAGE) ||
    message.includes(REQUESTED_MODEL_NOT_ALLOWED_FOR_TEAM_MESSAGE) ||
    message.includes('provider_not_allowed') ||
    message.includes('no eligible provider can serve the selected model.') ||
    message.includes('no allowed providers are specified.') ||
    message.includes('no allowed providers are available for the selected model.') ||
    message.includes('no endpoints found matching your data policy')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasRetryableSandboxMarker(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  if (value.error === 'sandbox_internal_server_error' && value.retryable === true) {
    return true;
  }

  return Object.values(value).some(nested => hasRetryableSandboxMarker(nested));
}

function parseJsonBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function isTerminalStatus(status: CodeReviewStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

type CloudAgentNextFreshRetryFailureCategory =
  | 'billing'
  | 'not_cloud_agent_next_error'
  | 'non_5xx'
  | 'cancelled'
  | 'deterministic_action_required_failure'
  | 'deterministic_non_retryable_failure'
  | 'sandbox_api_or_storage_failure'
  | 'wrapper_version_mismatch'
  | 'wrapper_wait_for_port_timeout'
  | 'wrapper_kilo_server_start_timeout'
  | 'configured_session_lookup_failure'
  | 'repo_clone_or_checkout_failure'
  | 'unclassified_5xx';

type CloudAgentNextFreshRetryClassification = {
  retryable: boolean;
  failureCategory: CloudAgentNextFreshRetryFailureCategory;
  retryClassificationReason: string;
  retryableWrapperReadinessFailure: boolean;
  cloudAgentNextProcedure?: string;
  cloudAgentNextStatus?: number;
};

function cloudAgentNextFreshRetryClassification(
  error: CloudAgentNextError | undefined,
  retryable: boolean,
  failureCategory: CloudAgentNextFreshRetryFailureCategory,
  retryClassificationReason: string
): CloudAgentNextFreshRetryClassification {
  return {
    retryable,
    failureCategory,
    retryClassificationReason,
    retryableWrapperReadinessFailure:
      failureCategory === 'wrapper_version_mismatch' ||
      failureCategory === 'wrapper_wait_for_port_timeout' ||
      failureCategory === 'wrapper_kilo_server_start_timeout',
    cloudAgentNextProcedure: error?.procedure,
    cloudAgentNextStatus: error?.status,
  };
}

const RETRYABLE_WRAPPER_VERSION_MISMATCH_PHRASE = 'Wrapper version mismatch'.toLowerCase();

function isWorkspaceAdmissionCapacityFailure(body: string): boolean {
  return (
    /workspace admission rejected: \d+ mb available below \d+ mb threshold after cleanup/i.test(
      body
    ) || body.includes('workspace admission rejected because disk capacity could not be measured')
  );
}

function hasKnownRetryableFreshSessionFailure(body: string): boolean {
  return (
    body.includes('failed to create workspace directory') ||
    body.includes('failed to prepare session home') ||
    body.includes(
      'disk capacity inspection cannot run because the sandbox filesystem is unusable'
    ) ||
    body.includes(
      'workspace admission probe cannot run because the sandbox filesystem is unusable'
    ) ||
    /\benospc\b/.test(body) ||
    body.includes('no space left on device') ||
    body.includes('wrapper cleanup is required before delivery can launch') ||
    body.includes("enoent: no such file or directory, posix_spawn 'git'") ||
    (body.includes('failed to checkout pull ref') &&
      body.includes(
        'your local changes to the following files would be overwritten by checkout'
      )) ||
    body.includes('session snapshot restore failed') ||
    body.includes(
      'internal error while starting up durable object storage caused object to be reset'
    )
  );
}

function classifyCloudAgentNextFreshSessionRetry(
  error: unknown
): CloudAgentNextFreshRetryClassification {
  if (error instanceof CloudAgentNextBillingError) {
    return cloudAgentNextFreshRetryClassification(error, false, 'billing', 'billing_protected');
  }

  const errorMessage = error instanceof Error ? error.message : String(error);
  const normalizedErrorMessage = errorMessage.toLowerCase();
  const cloudAgentNextError = error instanceof CloudAgentNextError ? error : undefined;

  if (/\b(cancelled|canceled)\b/i.test(errorMessage)) {
    return cloudAgentNextFreshRetryClassification(
      cloudAgentNextError,
      false,
      'cancelled',
      'cancelled_protected'
    );
  }

  if (isSelectedModelActionRequiredMessage(normalizedErrorMessage)) {
    return cloudAgentNextFreshRetryClassification(
      cloudAgentNextError,
      false,
      'deterministic_action_required_failure',
      'deterministic_action_required_failure_not_retryable'
    );
  }

  if (!cloudAgentNextError) {
    return cloudAgentNextFreshRetryClassification(
      undefined,
      false,
      'not_cloud_agent_next_error',
      'not_cloud_agent_next_error'
    );
  }

  if (cloudAgentNextError.status < 500 || cloudAgentNextError.status >= 600) {
    return cloudAgentNextFreshRetryClassification(cloudAgentNextError, false, 'non_5xx', 'non_5xx');
  }

  const body = cloudAgentNextError.body.toLowerCase();
  if (isWorkspaceAdmissionCapacityFailure(body)) {
    return cloudAgentNextFreshRetryClassification(
      cloudAgentNextError,
      true,
      'sandbox_api_or_storage_failure',
      'workspace_admission_capacity_retryable'
    );
  }

  if (
    body.includes('configured session') &&
    body.includes('not found: session get returned no data')
  ) {
    return cloudAgentNextFreshRetryClassification(
      cloudAgentNextError,
      false,
      'configured_session_lookup_failure',
      'configured_session_lookup_not_retryable'
    );
  }

  if (body.includes('git clone timed out')) {
    return cloudAgentNextFreshRetryClassification(
      cloudAgentNextError,
      true,
      'repo_clone_or_checkout_failure',
      'git_clone_timeout_retryable'
    );
  }

  if (
    body.includes('git-lfs filter-process') ||
    body.includes('object does not exist on the server')
  ) {
    return cloudAgentNextFreshRetryClassification(
      cloudAgentNextError,
      false,
      'repo_clone_or_checkout_failure',
      'repo_clone_or_checkout_not_retryable'
    );
  }

  if (
    body.includes('internal error in durable object storage') ||
    body.includes('durable object storage operation exceeded timeout')
  ) {
    return cloudAgentNextFreshRetryClassification(
      cloudAgentNextError,
      true,
      'sandbox_api_or_storage_failure',
      'durable_object_storage_failure_retryable'
    );
  }

  if (body.includes(RETRYABLE_WRAPPER_VERSION_MISMATCH_PHRASE)) {
    return cloudAgentNextFreshRetryClassification(
      cloudAgentNextError,
      true,
      'wrapper_version_mismatch',
      'wrapper_version_mismatch'
    );
  }

  if (hasKnownRetryableFreshSessionFailure(body)) {
    return cloudAgentNextFreshRetryClassification(
      cloudAgentNextError,
      true,
      'sandbox_api_or_storage_failure',
      'known_retryable_5xx_body_signal'
    );
  }

  const parsedBody = parseJsonBody(cloudAgentNextError.body);
  if (hasRetryableSandboxMarker(parsedBody)) {
    return cloudAgentNextFreshRetryClassification(
      cloudAgentNextError,
      true,
      'sandbox_api_or_storage_failure',
      'sandbox_retryable_marker'
    );
  }

  if (body.includes('failed to start kilo server: timeout waiting for server to start')) {
    return cloudAgentNextFreshRetryClassification(
      cloudAgentNextError,
      true,
      'wrapper_kilo_server_start_timeout',
      'wrapper_kilo_server_start_timeout'
    );
  }

  if (
    body.includes('wrapper did not become ready on port') &&
    body.includes('waitforport timed out')
  ) {
    return cloudAgentNextFreshRetryClassification(
      cloudAgentNextError,
      true,
      'wrapper_wait_for_port_timeout',
      'wrapper_wait_for_port_timeout'
    );
  }

  const hasSandboxSignal =
    body.includes('sandboxerror') ||
    body.includes('sandbox') ||
    body.includes('container') ||
    body.includes('cloudflare');
  const hasInternalServerSignal =
    body.includes('internal server error') ||
    body.includes('internal_server_error') ||
    /http\s+error!\s+status:\s*500\b/i.test(cloudAgentNextError.body) ||
    /\bstatus:\s*500\b/i.test(cloudAgentNextError.body) ||
    /\bhttp\s*500\b/i.test(cloudAgentNextError.body) ||
    /\b500\b/.test(cloudAgentNextError.body);

  if (hasSandboxSignal && hasInternalServerSignal) {
    return cloudAgentNextFreshRetryClassification(
      cloudAgentNextError,
      true,
      'sandbox_api_or_storage_failure',
      'sandbox_5xx_body_signal'
    );
  }

  return cloudAgentNextFreshRetryClassification(
    cloudAgentNextError,
    false,
    'unclassified_5xx',
    'unclassified_5xx'
  );
}

/**
 * CodeReviewOrchestrator manages the complete lifecycle of a code review.
 * Persists review state in storage and maintains connection to cloud agent.
 */
export class CodeReviewOrchestrator extends DurableObject<Env> {
  /** In-memory cache of current review state */
  private state!: CodeReview;

  /** Shared typed client for cloud-agent-next tRPC endpoints */
  private cloudAgentNextClient: CloudAgentNextFetchClient | undefined;

  /** Cleanup delay after review completion (7 days) */
  private static readonly CLEANUP_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

  /** Fallback alarm for queued reviews accepted by the Worker but not run via waitUntil. */
  private static readonly RUN_REVIEW_FALLBACK_DELAY_MS = 30_000;

  /** Jitter range before automatic infra retries start a fresh cloud-agent-next session. */
  private static readonly AUTO_RETRY_MIN_DELAY_MS = 2 * 60_000;
  private static readonly AUTO_RETRY_MAX_DELAY_MS = 5 * 60_000;

  /** Prevents retry scheduling after cancellation. */
  private cancelled = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  private getCloudAgentNextClient(): CloudAgentNextFetchClient {
    this.cloudAgentNextClient ??= createCloudAgentNextFetchClient(this.env.CLOUD_AGENT_NEXT_URL);
    return this.cloudAgentNextClient;
  }

  private static getAutoRetryDelayMs(): number {
    const delayRangeMs =
      CodeReviewOrchestrator.AUTO_RETRY_MAX_DELAY_MS -
      CodeReviewOrchestrator.AUTO_RETRY_MIN_DELAY_MS;
    return (
      CodeReviewOrchestrator.AUTO_RETRY_MIN_DELAY_MS +
      Math.floor(Math.random() * (delayRangeMs + 1))
    );
  }

  private logCloudAgentNextFreshSessionRetrySkipped(
    source: string,
    error: unknown,
    classification: CloudAgentNextFreshRetryClassification,
    retrySkipReason = classification.retryClassificationReason
  ): void {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    console.info('[CodeReviewOrchestrator] Fresh session retry skipped', {
      reviewId: this.state.reviewId,
      source,
      error: errorMessage,
      retryOutcome: 'skipped',
      retrySkipReason,
      sandboxRetryAttempted: this.state.sandboxRetryAttempted === true,
      reviewStatus: this.state.status,
      cancelled: this.cancelled,
      ...classification,
    });
  }

  private async tryRetryFreshSessionAfterSandboxError(
    source: string,
    error: unknown,
    classification: CloudAgentNextFreshRetryClassification
  ): Promise<boolean> {
    if (this.state.sandboxRetryAttempted === true) {
      this.logCloudAgentNextFreshSessionRetrySkipped(
        source,
        error,
        classification,
        'retry_already_attempted'
      );
      return false;
    }

    if (this.cancelled) {
      this.logCloudAgentNextFreshSessionRetrySkipped(
        source,
        error,
        classification,
        'review_cancelled'
      );
      return false;
    }

    if (isTerminalStatus(this.state.status)) {
      this.logCloudAgentNextFreshSessionRetrySkipped(
        source,
        error,
        classification,
        'review_already_terminal'
      );
      return false;
    }

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const previousCloudAgentSessionId = this.state.previousCloudAgentSessionId;
    const previousSessionId = this.state.sessionId;
    const previousCliSessionId = this.state.cliSessionId;
    const previousSandboxId = this.state.sandboxId;

    this.state.sandboxRetryAttempted = true;
    this.state.previousCloudAgentSessionId = undefined;
    this.state.sessionId = undefined;
    this.state.cliSessionId = undefined;
    this.state.sandboxId = undefined;
    this.state.status = 'queued';
    this.state.updatedAt = new Date().toISOString();
    const retryDelayMs = CodeReviewOrchestrator.getAutoRetryDelayMs();
    await this.saveState();
    await this.ctx.storage.setAlarm(Date.now() + retryDelayMs);

    console.warn(
      '[CodeReviewOrchestrator] Scheduled fresh-session retry after retryable cloud-agent-next failure',
      {
        reviewId: this.state.reviewId,
        source,
        error: errorMessage,
        previousCloudAgentSessionId,
        previousSessionId,
        previousCliSessionId,
        previousSandboxId,
        sandboxRetryAttempted: true,
        retryOutcome: 'scheduled',
        retryDelayMs,
        ...classification,
      }
    );

    return true;
  }

  private async runFreshCloudAgentNextFallback(previousSessionId: string): Promise<void> {
    this.state.previousCloudAgentSessionId = undefined;

    try {
      await this.runWithCloudAgentNext();
    } catch (freshError) {
      // runWithCloudAgentNext handles its own error/status updates, so this catch
      // is only for unexpected throws that bypass its internal error handling.
      const freshErrorMessage = freshError instanceof Error ? freshError.message : 'Unknown error';
      console.error('[CodeReviewOrchestrator] Fresh session fallback also failed', {
        reviewId: this.state.reviewId,
        previousCloudAgentSessionId: previousSessionId,
        error: freshErrorMessage,
      });
    }
  }

  /**
   * Alarm handler for review recovery and scheduled cleanup tasks.
   */
  async alarm(): Promise<void> {
    try {
      await this.loadState();

      // Guard against missing state (already cleaned up or never initialized)
      if (!this.state) {
        console.log('[CodeReviewOrchestrator] Alarm fired but no state found, skipping');
        return;
      }

      if (
        this.state.status === 'completed' ||
        this.state.status === 'failed' ||
        this.state.status === 'cancelled'
      ) {
        // Cleanup: Delete all DO storage after 7 days
        console.log('[CodeReviewOrchestrator] Cleaning up completed review', {
          reviewId: this.state.reviewId,
          status: this.state.status,
        });
        await this.ctx.storage.deleteAll();
      } else if (this.state.status === 'queued') {
        console.log('[CodeReviewOrchestrator] Queued review alarm starting review', {
          reviewId: this.state.reviewId,
        });
        await this.runReview();
      } else if (this.state.status === 'running') {
        console.log('[CodeReviewOrchestrator] Fallback alarm no-op for running review', {
          reviewId: this.state.reviewId,
        });
      } else {
        // Unexpected state - log for debugging
        console.warn('[CodeReviewOrchestrator] Alarm fired for non-terminal state', {
          reviewId: this.state.reviewId,
          status: this.state.status,
        });
      }
    } catch (error) {
      console.error('[CodeReviewOrchestrator] Alarm handler crashed:', {
        reviewId: this.state?.reviewId,
        status: this.state?.status,
        errorType: (error as Error)?.constructor?.name,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Load state from durable storage.
   */
  private async loadState(): Promise<void> {
    const storedState = await this.ctx.storage.get<CodeReview>('state');

    if (storedState) {
      this.state = storedState;

      console.log('[CodeReviewOrchestrator] State loaded from storage', {
        reviewId: storedState.reviewId,
        status: storedState.status,
      });
    }
  }

  /**
   * Save current state to durable storage.
   */
  private async saveState(): Promise<void> {
    await this.ctx.storage.put('state', this.state);
  }

  /**
   * Update review status locally and in Next.js DB
   */
  private async updateStatus(
    status: CodeReviewStatus,
    options?: {
      sessionId?: string;
      cliSessionId?: string;
      errorMessage?: string;
      terminalReason?: CloudAgentTerminalReason;
    }
  ): Promise<UpdateStatusResult> {
    // Check if there are any actual changes to process
    const statusChanged = this.state.status !== status;
    const sessionIdChanged =
      options !== undefined && 'sessionId' in options && options.sessionId !== this.state.sessionId;
    const cliSessionIdChanged =
      options !== undefined &&
      'cliSessionId' in options &&
      options.cliSessionId !== this.state.cliSessionId;
    const errorMessageChanged =
      options !== undefined &&
      'errorMessage' in options &&
      options.errorMessage !== this.state.errorMessage;
    const terminalReasonChanged =
      options !== undefined &&
      'terminalReason' in options &&
      options.terminalReason !== this.state.terminalReason;

    // Early return only if nothing has changed
    if (
      !statusChanged &&
      !sessionIdChanged &&
      !cliSessionIdChanged &&
      !errorMessageChanged &&
      !terminalReasonChanged
    ) {
      if (status !== 'running') {
        return 'updated';
      }

      try {
        return await this.updateDBStatus(status, options);
      } catch (error) {
        console.error('[CodeReviewOrchestrator] Failed to refresh DB running status:', error);
        return 'updated';
      }
    }

    // Update status if it changed
    if (statusChanged) {
      this.state.status = status;

      // Update timestamps based on status
      if (status === 'running' && !this.state.startedAt) {
        this.state.startedAt = new Date().toISOString();
      }

      if (status === 'completed' || status === 'failed' || status === 'cancelled') {
        this.state.completedAt = new Date().toISOString();

        // Schedule cleanup alarm for 7 days from now
        await this.ctx.storage.setAlarm(Date.now() + CodeReviewOrchestrator.CLEANUP_DELAY_MS);

        console.log('[CodeReviewOrchestrator] Scheduled cleanup alarm', {
          reviewId: this.state.reviewId,
          status,
          cleanupIn: '7 days',
        });
      }
    }

    // Update metadata (sessionId, cliSessionId, errorMessage) even if status didn't change
    if (options !== undefined && 'sessionId' in options) {
      // Only apply if it's a non-empty string (sessionId should be meaningful)
      if (options.sessionId) {
        this.state.sessionId = options.sessionId;
      }
    }

    if (options !== undefined && 'cliSessionId' in options) {
      // Only apply if it's a non-empty string (cliSessionId should be meaningful)
      if (options.cliSessionId) {
        this.state.cliSessionId = options.cliSessionId;
      }
    }

    if (options !== undefined && 'errorMessage' in options) {
      // Error messages can be empty strings (though unusual)
      this.state.errorMessage = options.errorMessage;
    }

    if (options !== undefined && 'terminalReason' in options) {
      this.state.terminalReason = options.terminalReason;
    }

    this.state.updatedAt = new Date().toISOString();
    await this.saveState();

    // Update Next.js DB via internal API
    try {
      const dbUpdateResult = await this.updateDBStatus(status, options);
      if (dbUpdateResult === 'db-terminal') {
        return 'db-terminal';
      }
    } catch (error) {
      console.error('[CodeReviewOrchestrator] Failed to update DB status:', error);

      // For terminal states (completed/failed/cancelled), DB update MUST succeed
      // Otherwise frontend will poll forever thinking review is still running and also blocking the slot in the queue
      const isTerminalState =
        status === 'completed' || status === 'failed' || status === 'cancelled';
      if (isTerminalState) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`Critical: Failed to update DB status to '${status}': ${errorMessage}`);
      }
      // For non-terminal states (queued/running), continue - we've saved state locally
    }

    return 'updated';
  }

  private async setLocalTerminalStateFromDB(
    status: Extract<CodeReviewStatus, 'completed' | 'failed' | 'cancelled'>,
    terminalReason?: CloudAgentTerminalReason | null
  ): Promise<void> {
    this.state.status = status;
    if (terminalReason !== undefined) {
      this.state.terminalReason = terminalReason ?? undefined;
    }
    this.state.completedAt = this.state.completedAt ?? new Date().toISOString();
    this.state.updatedAt = new Date().toISOString();
    await this.ctx.storage.setAlarm(Date.now() + CodeReviewOrchestrator.CLEANUP_DELAY_MS);
    await this.saveState();
    console.log('[CodeReviewOrchestrator] Local state synced to terminal DB status', {
      reviewId: this.state.reviewId,
      status,
    });
  }

  /**
   * Call Next.js internal API to update review status in DB
   */
  private async updateDBStatus(
    status: CodeReviewStatus,
    options?: {
      sessionId?: string;
      cliSessionId?: string;
      errorMessage?: string;
      terminalReason?: CloudAgentTerminalReason;
    }
  ): Promise<UpdateStatusResult> {
    // Use path-based endpoint (same as callback endpoint for consistency)
    const callbackTarget = await callbackTargetForAttempt(
      this.env.API_URL,
      this.state.reviewId,
      this.state.attemptId,
      this.env.CALLBACK_TOKEN_SECRET
    );

    // Payload without reviewId (it's in the URL path)
    const payload = {
      status,
      sessionId: options?.sessionId,
      cliSessionId: options?.cliSessionId,
      errorMessage: options?.errorMessage,
      terminalReason: options?.terminalReason,
    };

    const response = await fetch(callbackTarget.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...callbackTarget.headers,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to update DB status: ${response.status} ${errorText}`);
    }

    const body = InternalStatusResponseSchema.parse(await response.json());
    if (body.message === 'Review already in terminal state' && body.currentStatus) {
      await this.setLocalTerminalStateFromDB(body.currentStatus, body.terminalReason);
      return 'db-terminal';
    }

    return 'updated';
  }

  private getTerminalReason(error: unknown): CloudAgentTerminalReason | undefined {
    if (error instanceof CloudAgentNextBillingError) {
      return 'billing';
    }

    if (!(error instanceof Error)) {
      return undefined;
    }

    const message = error.message.toLowerCase();

    if (isSelectedModelActionRequiredMessage(message)) {
      return 'selected_model_unavailable';
    }

    if (
      message.includes('timeout') ||
      message.includes('timed out') ||
      message.includes('etimedout')
    ) {
      return 'timeout';
    }
    if (
      message.includes('upstream') ||
      message.includes('internal server') ||
      message.includes('502') ||
      message.includes('503') ||
      message.includes('504')
    ) {
      return 'upstream_error';
    }

    // Return undefined for unrecognized errors so NULL in the DB
    // differentiates "not yet classified" from a known category.
    return undefined;
  }

  /**
   * RPC method: Start the review.
   */
  async start(params: {
    reviewId: string;
    attemptId?: string;
    authToken: string;
    sessionInput: SessionInput;
    owner: {
      type: 'user' | 'org';
      id: string;
      userId: string;
    };
    skipBalanceCheck?: boolean;
    previousCloudAgentSessionId?: string;
    repositorySize?: string | null;
    runReviewDelayMs?: number;
    reviewAgents?: ReviewAgentsConfig;
  }): Promise<{ status: CodeReviewStatus }> {
    if (!this.state) {
      await this.loadState();
    }

    if (this.state) {
      console.log('[CodeReviewOrchestrator] Duplicate start ignored', {
        reviewId: this.state.reviewId,
        status: this.state.status,
      });

      return { status: this.state.status };
    }

    this.state = {
      reviewId: params.reviewId,
      attemptId: params.attemptId,
      authToken: params.authToken,
      sessionInput: params.sessionInput,
      owner: params.owner,
      status: 'queued',
      updatedAt: new Date().toISOString(),
      skipBalanceCheck: params.skipBalanceCheck,
      previousCloudAgentSessionId:
        params.sessionInput.platform === 'bitbucket'
          ? undefined
          : params.previousCloudAgentSessionId,
      repositorySize: params.repositorySize,
      reviewAgents: params.reviewAgents,
    };
    await this.saveState();

    // Forward plumbing: today execution consumes only the standard reviewer settings
    // (agents[0] / sessionInput). Log the full selection for observability ahead of
    // council (multi-agent) mode, which will consume the rest. This is a pure
    // observability log sitting between saveState() and setAlarm(): a malformed
    // payload (non-array agents, null entries, etc.) must never throw here, or the
    // review would be persisted as queued but never scheduled. Keep it total.
    if (params.reviewAgents) {
      const agents = params.reviewAgents.agents;
      console.log('[CodeReviewOrchestrator] Review agent selections', {
        reviewId: params.reviewId,
        reviewType: params.reviewAgents.reviewType,
        agentCount: Array.isArray(agents) ? agents.length : 0,
        agentRoles: Array.isArray(agents) ? agents.map(agent => agent?.role) : [],
      });
    }
    const runReviewDelayMs =
      params.runReviewDelayMs ?? CodeReviewOrchestrator.RUN_REVIEW_FALLBACK_DELAY_MS;
    await this.ctx.storage.setAlarm(Date.now() + runReviewDelayMs);

    console.log('[CodeReviewOrchestrator] Review created and queued', {
      reviewId: params.reviewId,
      owner: params.owner,
    });

    console.log('[CodeReviewOrchestrator] Scheduled queued review fallback alarm', {
      reviewId: params.reviewId,
      fallbackInMs: runReviewDelayMs,
    });

    return { status: this.state.status };
  }

  /**
   * RPC method: Return current state.
   */
  async status(): Promise<CodeReviewStatusResponse> {
    const currentStatus = await this.getStatus();
    if (!currentStatus) {
      throw new Error('Review not found');
    }

    return currentStatus;
  }

  async getStatus(): Promise<CodeReviewStatusResult> {
    if (!this.state) {
      await this.loadState();
    }

    if (!this.state) {
      return null;
    }

    return {
      reviewId: this.state.reviewId,
      attemptId: this.state.attemptId,
      status: this.state.status,
      sessionId: this.state.sessionId,
      cliSessionId: this.state.cliSessionId,
      startedAt: this.state.startedAt,
      completedAt: this.state.completedAt,
      model: this.state.model,
      totalTokensIn: this.state.totalTokensIn,
      totalTokensOut: this.state.totalTokensOut,
      totalCost: this.state.totalCost,
      errorMessage: this.state.errorMessage,
      terminalReason: this.state.terminalReason,
    };
  }

  async retryFreshAfterInfraFailure(params: {
    sessionId?: string;
    reason: string;
    retryAttemptId?: string;
  }): Promise<boolean> {
    await this.loadState();

    if (!this.state) {
      return false;
    }

    if (this.state.sandboxRetryAttempted === true) {
      return false;
    }

    if (params.sessionId && this.state.sessionId && params.sessionId !== this.state.sessionId) {
      console.warn(
        '[CodeReviewOrchestrator] retryFreshAfterInfraFailure ignored session mismatch',
        {
          reviewId: this.state.reviewId,
          requestedSessionId: params.sessionId,
          currentSessionId: this.state.sessionId,
        }
      );
      return false;
    }

    if (!params.retryAttemptId) {
      return false;
    }

    this.state.sandboxRetryAttempted = true;
    await this.saveState();
    const retryDelayMs = CodeReviewOrchestrator.getAutoRetryDelayMs();

    const retryId = this.env.CODE_REVIEW_ORCHESTRATOR.idFromName(
      doNameForAttempt(this.state.reviewId, params.retryAttemptId)
    );
    const retryStub = this.env.CODE_REVIEW_ORCHESTRATOR.get(retryId);
    const started = await retryStub.start({
      reviewId: this.state.reviewId,
      attemptId: params.retryAttemptId,
      authToken: this.state.authToken,
      sessionInput: this.state.sessionInput,
      owner: this.state.owner,
      skipBalanceCheck: this.state.skipBalanceCheck,
      previousCloudAgentSessionId: undefined,
      repositorySize: this.state.repositorySize,
      reviewAgents: this.state.reviewAgents,
      runReviewDelayMs: retryDelayMs,
    });

    console.warn(
      '[CodeReviewOrchestrator] Retrying review with fresh session after infra failure',
      {
        reviewId: this.state.reviewId,
        failedAttemptId: this.state.attemptId,
        retryAttemptId: params.retryAttemptId,
        reason: params.reason,
        status: started.status,
        retryDelayMs,
      }
    );

    return started.status === 'queued' || started.status === 'running';
  }

  /**
   * RPC method: Cancel a running review.
   * Prevents retries and interrupts the Cloud Agent Next session.
   */
  async cancel(reason?: string): Promise<boolean> {
    await this.loadState();

    if (!this.state) {
      return false;
    }

    // Only cancel if review is queued or running
    const cancellableStatuses: CodeReviewStatus[] = ['queued', 'running'];
    if (!cancellableStatuses.includes(this.state.status)) {
      return false;
    }

    this.cancelled = true;

    const errorMessage = reason ? `Review cancelled: ${reason}` : 'Review cancelled';
    await this.updateStatus('cancelled', { errorMessage });

    // If we have a sessionId, interrupt the cloud agent session to stop it from posting comments
    if (this.state.sessionId) {
      try {
        await this.interruptCloudAgentSession(this.state.sessionId);
        console.log('[CodeReviewOrchestrator] Cloud agent session interrupted', {
          reviewId: this.state.reviewId,
          sessionId: this.state.sessionId,
        });
      } catch (interruptError) {
        // Log but don't fail - the review is already marked as cancelled
        console.warn('[CodeReviewOrchestrator] Failed to interrupt cloud agent session', {
          reviewId: this.state.reviewId,
          sessionId: this.state.sessionId,
          error: interruptError instanceof Error ? interruptError.message : String(interruptError),
        });
      }
    }

    console.log('[CodeReviewOrchestrator] Review cancelled', {
      reviewId: this.state.reviewId,
      reason,
    });

    return true;
  }

  /** Interrupt the cloud agent session to stop it from running and posting comments. */
  private async interruptCloudAgentSession(sessionId: string): Promise<void> {
    await this.getCloudAgentNextClient().interruptSession(
      { Authorization: `Bearer ${this.state.authToken}` },
      { sessionId }
    );
  }

  /**
   * RPC method: Run the review.
   * Called via HTTP context or alarm to start queued work.
   */
  async runReview(): Promise<void> {
    await this.loadState();

    // Guard: only run if queued (prevents double execution)
    if (!this.state || this.state.status !== 'queued') {
      console.log('[CodeReviewOrchestrator] runReview skipped - not in queued state', {
        reviewId: this.state?.reviewId,
        status: this.state?.status,
      });
      return;
    }

    if (
      this.state.previousCloudAgentSessionId &&
      this.state.sessionInput.platform !== 'bitbucket'
    ) {
      await this.runWithCloudAgentNextFollowup();
    } else {
      await this.runWithCloudAgentNext();
    }
  }

  // ---------------------------------------------------------------------------
  // cloud-agent-next flow (feature-flagged)
  // Uses prepareSession + initiateFromKilocodeSessionV2 with callback-based completion.
  // ---------------------------------------------------------------------------

  /**
   * Orchestration via cloud-agent-next.
   * Calls prepareSession + initiateFromKilocodeSessionV2.
   * Terminal status is delivered reliably via cloud-agent-next's callback queue.
   */
  private async runWithCloudAgentNext(): Promise<void> {
    const runStartTime = Date.now();
    const client = this.getCloudAgentNextClient();

    try {
      const statusUpdateResult = await this.updateStatus('running');
      if (statusUpdateResult === 'db-terminal') return;

      console.log('[CodeReviewOrchestrator] Starting review via cloud-agent-next', {
        reviewId: this.state.reviewId,
        timestamp: new Date().toISOString(),
      });

      // Build common headers for prepareSession (internalApiProtectedProcedure)
      const internalHeaders: Record<string, string> = {
        Authorization: `Bearer ${this.state.authToken}`,
        'x-internal-api-key': this.env.INTERNAL_API_SECRET,
      };
      if (this.state.skipBalanceCheck) {
        internalHeaders['x-skip-balance-check'] = 'true';
      }

      // Step 1: Prepare session with callback target
      const callbackTarget = await callbackTargetForAttempt(
        this.env.API_URL,
        this.state.reviewId,
        this.state.attemptId,
        this.env.CALLBACK_TOKEN_SECRET
      );

      const sessionInput = this.state.sessionInput;
      const githubCloudReviewSkillAttached =
        sessionInput.platform === 'github' &&
        typeof sessionInput.githubRepo === 'string' &&
        sessionInput.githubRepo.trim().length > 0;
      const bitbucketCloudReviewSkillAttached = isBitbucketCloudReviewSessionInput(sessionInput);
      const skillCue = githubCloudReviewSkillAttached
        ? buildGitHubCloudReviewSkillCue(this.state.reviewId)
        : bitbucketCloudReviewSkillAttached
          ? buildBitbucketCloudReviewSkillCue(
              this.state.reviewId,
              sessionInput.bitbucketPullRequestId,
              sessionInput.bitbucketExpectedHeadSha
            )
          : undefined;
      const runtimeSkills = githubCloudReviewSkillAttached
        ? [GITHUB_CLOUD_REVIEW_SKILL]
        : bitbucketCloudReviewSkillAttached
          ? [BITBUCKET_CLOUD_REVIEW_SKILL]
          : undefined;
      const prepareInput: CloudAgentPrepareSessionInput = {
        ...sessionInput,
        prompt: skillCue ? `${skillCue}\n\n${sessionInput.prompt}` : sessionInput.prompt,
        runtimeSkills,
        createdOnPlatform: 'code-review' as const,
        callbackTarget,
      };

      console.log('[CodeReviewOrchestrator] Calling prepareSession', {
        reviewId: this.state.reviewId,
        callbackUrl: callbackTarget.url,
        createdOnPlatform: prepareInput.createdOnPlatform,
        skipBalanceCheck: this.state.skipBalanceCheck,
        githubCloudReviewSkill: {
          attached: githubCloudReviewSkillAttached,
          name: GITHUB_CLOUD_REVIEW_SKILL_NAME,
          version: GITHUB_CLOUD_REVIEW_SKILL_VERSION,
        },
        bitbucketCloudReviewSkill: {
          attached: bitbucketCloudReviewSkillAttached,
          name: BITBUCKET_CLOUD_REVIEW_SKILL_NAME,
          version: BITBUCKET_CLOUD_REVIEW_SKILL_VERSION,
        },
      });

      const { cloudAgentSessionId, kiloSessionId } = await client.prepareSession(
        internalHeaders,
        prepareInput
      );

      const repositorySize = this.state.repositorySize ?? null;

      console.log('[CodeReviewOrchestrator] Session prepared', {
        reviewId: this.state.reviewId,
        attemptId: this.state.attemptId,
        cloudAgentSessionId,
        kiloSessionId,
        repositorySize,
        repositorySizeKnown: repositorySize !== null,
      });

      // Store session IDs immediately (no stream parsing needed)
      await this.updateStatus('running', {
        sessionId: cloudAgentSessionId,
        cliSessionId: kiloSessionId,
      });

      // Step 2: Initiate execution
      // initiateFromKilocodeSessionV2 is a protectedProcedure (Bearer token only)
      const userHeaders: Record<string, string> = {
        Authorization: `Bearer ${this.state.authToken}`,
      };
      if (this.state.skipBalanceCheck) {
        userHeaders['x-skip-balance-check'] = 'true';
      }

      console.log('[CodeReviewOrchestrator] Calling initiateFromKilocodeSessionV2', {
        reviewId: this.state.reviewId,
        cloudAgentSessionId,
      });

      const initiateResult = await client.initiateFromPreparedSession(userHeaders, {
        cloudAgentSessionId,
      });

      console.log('[CodeReviewOrchestrator] Execution started', {
        reviewId: this.state.reviewId,
        cloudAgentSessionId,
        executionId: initiateResult.executionId,
        status: initiateResult.status,
      });

      // Done — cloud-agent-next callback will deliver terminal status
      console.log('[CodeReviewOrchestrator] Review dispatched to cloud-agent-next', {
        reviewId: this.state.reviewId,
        sessionId: cloudAgentSessionId,
        note: 'Callback will update final status',
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const retryClassification = classifyCloudAgentNextFreshSessionRetry(error);

      if (retryClassification.retryable) {
        if (
          await this.tryRetryFreshSessionAfterSandboxError(
            'cloud-agent-next-fresh',
            error,
            retryClassification
          )
        ) {
          return;
        }

        if (this.cancelled || isTerminalStatus(this.state.status)) {
          return;
        }

        await this.updateStatus('failed', {
          errorMessage,
          terminalReason: 'sandbox_error',
        });

        console.error('[CodeReviewOrchestrator] Review failed after fresh-session retry:', {
          reviewId: this.state.reviewId,
          error: errorMessage,
          retryOutcome: 'exhausted',
          ...retryClassification,
        });
        return;
      }

      this.logCloudAgentNextFreshSessionRetrySkipped(
        'cloud-agent-next-fresh',
        error,
        retryClassification
      );

      const terminalReason = this.getTerminalReason(error);

      await this.updateStatus('failed', { errorMessage, terminalReason });

      console.error('[CodeReviewOrchestrator] Review failed (cloud-agent-next):', {
        reviewId: this.state.reviewId,
        error: errorMessage,
        ...retryClassification,
      });
    } finally {
      const totalExecutionTimeMs = Date.now() - runStartTime;
      const minutes = Math.floor(totalExecutionTimeMs / 60000);
      const seconds = Math.floor((totalExecutionTimeMs % 60000) / 1000);

      console.log('[CodeReviewOrchestrator] Run completed (cloud-agent-next)', {
        reviewId: this.state.reviewId,
        sessionId: this.state.sessionId,
        status: this.state.status,
        totalExecutionTimeMs,
        totalExecutionTime: `${minutes}m ${seconds}s`,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // cloud-agent-next follow-up flow (session continuation)
  // Uses sendMessageV2 to reuse an existing session from a previous review.
  // Falls back to fresh session (prepareSession + initiate) on failure.
  // ---------------------------------------------------------------------------

  /**
   * Orchestration via cloud-agent-next with session continuation.
   * Calls sendMessageV2 on an existing session from a previous review.
   * On failure (404, 409, etc.), falls back to runWithCloudAgentNext() for a fresh session.
   */
  private async runWithCloudAgentNextFollowup(): Promise<void> {
    const previousSessionId = this.state.previousCloudAgentSessionId;
    if (!previousSessionId) {
      throw new Error('runWithCloudAgentNextFollowup called without previousCloudAgentSessionId');
    }
    const client = this.getCloudAgentNextClient();

    console.log('[CodeReviewOrchestrator] Attempting session continuation via sendMessageV2', {
      reviewId: this.state.reviewId,
      previousCloudAgentSessionId: previousSessionId,
    });

    try {
      const statusUpdateResult = await this.updateStatus('running');
      if (statusUpdateResult === 'db-terminal') return;

      const userHeaders: Record<string, string> = {
        Authorization: `Bearer ${this.state.authToken}`,
      };
      if (this.state.skipBalanceCheck) {
        userHeaders['x-skip-balance-check'] = 'true';
      }

      let health: CloudAgentSessionHealthOutput;
      try {
        health = await client.getSessionHealth(userHeaders, {
          cloudAgentSessionId: previousSessionId,
        });
      } catch (error) {
        if (error instanceof CloudAgentNextBillingError) {
          throw error;
        }

        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.warn('[CodeReviewOrchestrator] Session health preflight failed', {
          reviewId: this.state.reviewId,
          previousCloudAgentSessionId: previousSessionId,
          error: errorMessage,
        });
        await this.runFreshCloudAgentNextFallback(previousSessionId);
        return;
      }

      if (!canContinueCloudAgentNextSession(health)) {
        console.warn('[CodeReviewOrchestrator] Previous cloud-agent-next session is unhealthy', {
          reviewId: this.state.reviewId,
          previousCloudAgentSessionId: previousSessionId,
          sandboxStatus: health.sandboxStatus,
          executionHealth: health.executionHealth,
          activeExecutionId: health.activeExecutionId,
        });
        await this.runFreshCloudAgentNextFallback(previousSessionId);
        return;
      }

      // Build internal headers (internalApiProtectedProcedure — API key + Bearer token)
      const internalHeaders: Record<string, string> = {
        Authorization: `Bearer ${this.state.authToken}`,
        'x-internal-api-key': this.env.INTERNAL_API_SECRET,
      };
      if (this.state.skipBalanceCheck) {
        internalHeaders['x-skip-balance-check'] = 'true';
      }

      // Step 1: Update callback target via updateSession (internal-only endpoint).
      // callbackTarget must be set through an internal procedure, not the
      // user-facing sendMessageV2, to prevent SSRF via arbitrary callback URLs.
      const callbackTarget = await callbackTargetForAttempt(
        this.env.API_URL,
        this.state.reviewId,
        this.state.attemptId,
        this.env.CALLBACK_TOKEN_SECRET
      );

      await client.updateSession(internalHeaders, {
        cloudAgentSessionId: previousSessionId,
        callbackTarget,
      });

      // Step 2: Send follow-up message (user-facing, no callbackTarget)
      console.log('[CodeReviewOrchestrator] Calling sendMessageV2', {
        reviewId: this.state.reviewId,
        cloudAgentSessionId: previousSessionId,
        callbackUrl: callbackTarget.url,
      });

      const sendResult = await client.sendMessageV2(userHeaders, {
        cloudAgentSessionId: previousSessionId,
        prompt: this.state.sessionInput.prompt,
        mode: this.state.sessionInput.mode,
        model: this.state.sessionInput.model,
        variant: this.state.sessionInput.variant,
        githubToken: this.state.sessionInput.githubToken,
        gitToken: this.state.sessionInput.gitToken,
      });

      // Store session ID (reusing the previous one) and execution ID
      await this.updateStatus('running', {
        sessionId: previousSessionId,
      });

      console.log('[CodeReviewOrchestrator] Follow-up execution started via sendMessageV2', {
        reviewId: this.state.reviewId,
        cloudAgentSessionId: previousSessionId,
        executionId: sendResult.executionId,
        status: sendResult.status,
      });

      // Done — cloud-agent-next callback will deliver terminal status
    } catch (error) {
      if (error instanceof CloudAgentNextBillingError) {
        const errorMessage = error.message;
        await this.updateStatus('failed', {
          errorMessage,
          terminalReason: 'billing',
        });

        console.warn(
          '[CodeReviewOrchestrator] cloud-agent-next billing failure, skipping fresh session fallback',
          {
            reviewId: this.state.reviewId,
            previousCloudAgentSessionId: previousSessionId,
            error: errorMessage,
          }
        );
        return;
      }

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const retryClassification = classifyCloudAgentNextFreshSessionRetry(error);

      if (retryClassification.retryable) {
        if (
          await this.tryRetryFreshSessionAfterSandboxError(
            'cloud-agent-next-followup',
            error,
            retryClassification
          )
        ) {
          return;
        }

        if (this.cancelled || isTerminalStatus(this.state.status)) {
          return;
        }

        await this.updateStatus('failed', {
          errorMessage,
          terminalReason: 'sandbox_error',
        });

        console.warn('[CodeReviewOrchestrator] sendMessageV2 failure after fresh-session retry', {
          reviewId: this.state.reviewId,
          previousCloudAgentSessionId: previousSessionId,
          error: errorMessage,
          retryOutcome: 'exhausted',
          ...retryClassification,
        });
        return;
      }

      this.logCloudAgentNextFreshSessionRetrySkipped(
        'cloud-agent-next-followup',
        error,
        retryClassification
      );

      console.warn('[CodeReviewOrchestrator] sendMessageV2 failed, falling back to fresh session', {
        reviewId: this.state.reviewId,
        previousCloudAgentSessionId: previousSessionId,
        error: errorMessage,
        ...retryClassification,
      });

      // Reset status to running (it may have been set to running already, but ensure clean state)
      // Clear previousCloudAgentSessionId so the fresh session path doesn't try followup again
      await this.runFreshCloudAgentNextFallback(previousSessionId);
    }
  }
}
