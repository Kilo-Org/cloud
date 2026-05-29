/**
 * CodeReviewOrchestrator - Durable Object for managing code review lifecycle.
 *
 * Supports two execution modes based on the useCloudAgentNext flag:
 * - Default (cloud-agent): SSE streaming via initiateSessionAsync
 * - cloud-agent-next: prepareSession + initiateFromKilocodeSessionV2, callback-based completion
 */

import { DurableObject } from 'cloudflare:workers';
import {
  createCloudAgentNextFetchClient,
  CloudAgentNextBillingError,
  CloudAgentNextError,
  deriveCallbackToken,
  type CloudAgentNextFetchClient,
  type CloudAgentSessionHealthOutput,
  type CloudAgentTerminalReason,
} from '@kilocode/worker-utils';
import type {
  Env,
  CodeReview,
  CodeReviewStatus,
  CodeReviewStatusResponse,
  CodeReviewStatusResult,
  CodeReviewEvent,
  SessionInput,
} from './types';
import { InternalStatusResponseSchema } from './types';
import { doNameForAttempt } from './do-name';

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

/** Shape of an SSE event parsed from the cloud agent stream */
type SseEventPayload = {
  say?: string;
  ask?: string;
  content?: string;
  text?: string;
  event?: string;
  partial?: boolean;
  sessionId?: string;
  metadata?: Record<string, unknown>;
};

type SseEvent = {
  streamEventType?: string;
  sessionId?: string;
  message?: string;
  payload?: SseEventPayload;
};

// Subset of denied patterns for observability; keep in sync with: cloud-agent/src/workspace.ts, cloud-agent-next/src/session-service.ts
const RISKY_COMMAND_PATTERNS = [
  'git add',
  'git commit',
  'git push',
  'git merge',
  'git rebase',
  'git checkout',
  'git switch',
  'gh pr merge',
  'gh pr review',
  'pytest',
  'vitest',
];

const SELECTED_MODEL_UNAVAILABLE_MESSAGE =
  'selected model is not available for this cloud agent session';
const REQUESTED_MODEL_NOT_ALLOWED_FOR_TEAM_MESSAGE =
  'the requested model is not allowed for your team';

function findRiskyPattern(command: string): string | null {
  const normalized = command.toLowerCase();
  const match = RISKY_COMMAND_PATTERNS.find(pattern => normalized.includes(pattern));
  return match ?? null;
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
  | 'sandbox_api_or_storage_failure'
  | 'wrapper_wait_for_port_timeout'
  | 'wrapper_kilo_server_start_timeout'
  | 'configured_session_lookup_failure'
  | 'repo_clone_or_checkout_failure'
  | 'other_5xx';

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
      failureCategory === 'wrapper_wait_for_port_timeout' ||
      failureCategory === 'wrapper_kilo_server_start_timeout',
    cloudAgentNextProcedure: error?.procedure,
    cloudAgentNextStatus: error?.status,
  };
}

function classifyCloudAgentNextFreshSessionRetry(
  error: unknown
): CloudAgentNextFreshRetryClassification {
  if (error instanceof CloudAgentNextBillingError) {
    return cloudAgentNextFreshRetryClassification(error, false, 'billing', 'billing_protected');
  }

  if (!(error instanceof CloudAgentNextError)) {
    return cloudAgentNextFreshRetryClassification(
      undefined,
      false,
      'not_cloud_agent_next_error',
      'not_cloud_agent_next_error'
    );
  }

  if (error.status < 500 || error.status >= 600) {
    return cloudAgentNextFreshRetryClassification(error, false, 'non_5xx', 'non_5xx');
  }

  if (/\b(cancelled|canceled)\b/i.test(error.body)) {
    return cloudAgentNextFreshRetryClassification(error, false, 'cancelled', 'cancelled_protected');
  }

  const body = error.body.toLowerCase();
  if (
    body.includes('configured session') &&
    body.includes('not found: session get returned no data')
  ) {
    return cloudAgentNextFreshRetryClassification(
      error,
      false,
      'configured_session_lookup_failure',
      'configured_session_lookup_not_retryable'
    );
  }

  if (
    body.includes('git clone timed out') ||
    body.includes('failed to checkout pull ref') ||
    body.includes('git-lfs filter-process') ||
    body.includes('object does not exist on the server')
  ) {
    return cloudAgentNextFreshRetryClassification(
      error,
      false,
      'repo_clone_or_checkout_failure',
      'repo_clone_or_checkout_not_retryable'
    );
  }

  const parsedBody = parseJsonBody(error.body);
  if (hasRetryableSandboxMarker(parsedBody)) {
    return cloudAgentNextFreshRetryClassification(
      error,
      true,
      'sandbox_api_or_storage_failure',
      'sandbox_retryable_marker'
    );
  }

  if (body.includes('failed to start kilo server: timeout waiting for server to start')) {
    return cloudAgentNextFreshRetryClassification(
      error,
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
      error,
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
    /http\s+error!\s+status:\s*500\b/i.test(error.body) ||
    /\bstatus:\s*500\b/i.test(error.body) ||
    /\bhttp\s*500\b/i.test(error.body) ||
    /\b500\b/.test(error.body);

  if (hasSandboxSignal && hasInternalServerSignal) {
    return cloudAgentNextFreshRetryClassification(
      error,
      true,
      'sandbox_api_or_storage_failure',
      'sandbox_5xx_body_signal'
    );
  }

  if (
    body.includes('internal error in durable object storage') ||
    body.includes('durable object storage operation exceeded timeout')
  ) {
    return cloudAgentNextFreshRetryClassification(
      error,
      false,
      'sandbox_api_or_storage_failure',
      'storage_failure_not_retryable_by_code_review_classifier'
    );
  }

  return cloudAgentNextFreshRetryClassification(error, false, 'other_5xx', 'unclassified_5xx');
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

  /** Maximum time to wait for SSE stream (20 minutes) */
  private static readonly STREAM_TIMEOUT_MS = 20 * 60 * 1000;

  /** Cleanup delay after review completion (7 days) */
  private static readonly CLEANUP_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

  /** Fallback alarm for queued reviews accepted by the Worker but not run via waitUntil. */
  private static readonly RUN_REVIEW_FALLBACK_DELAY_MS = 30_000;

  /** Batch size for event persistence (save every N events to reduce CPU usage) */
  private static readonly EVENT_BATCH_SIZE = 10;

  /** Counter for batching event persistence */
  private unsavedEventCount = 0;

  /** Flag to signal stream processing to stop when cancelled */
  private cancelled = false;

  /** Accumulated usage data from LLM API calls */
  private totalTokensIn = 0;
  private totalTokensOut = 0;
  private totalCost = 0;
  private model: string | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  private getCloudAgentNextClient(): CloudAgentNextFetchClient {
    this.cloudAgentNextClient ??= createCloudAgentNextFetchClient(this.env.CLOUD_AGENT_NEXT_URL);
    return this.cloudAgentNextClient;
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
    await this.saveState();

    console.warn(
      '[CodeReviewOrchestrator] Retrying with a fresh session after retryable cloud-agent-next failure',
      {
        reviewId: this.state.reviewId,
        source,
        error: errorMessage,
        previousCloudAgentSessionId,
        previousSessionId,
        previousCliSessionId,
        previousSandboxId,
        sandboxRetryAttempted: true,
        retryOutcome: 'attempted',
        ...classification,
      }
    );

    await this.runFreshCloudAgentNextFallback(
      previousCloudAgentSessionId ?? previousSessionId ?? 'unknown'
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
        console.log('[CodeReviewOrchestrator] Fallback alarm starting queued review', {
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
        agentVersion: storedState.agentVersion,
      });

      // Restore usage accumulators from persisted state so they survive DO eviction
      if (storedState.model != null) this.model = storedState.model;
      if (storedState.totalTokensIn != null) this.totalTokensIn = storedState.totalTokensIn;
      if (storedState.totalTokensOut != null) this.totalTokensOut = storedState.totalTokensOut;
      if (storedState.totalCost != null) this.totalCost = storedState.totalCost;
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

        // Clear events immediately - no longer needed after completion
        this.state.events = [];

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
    this.state.events = [];
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

    if (
      message.includes(SELECTED_MODEL_UNAVAILABLE_MESSAGE) ||
      message.includes(REQUESTED_MODEL_NOT_ALLOWED_FOR_TEAM_MESSAGE)
    ) {
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
   * Report accumulated LLM usage data to Next.js backend.
   * Called after SSE stream processing completes, before cloud agent callback.
   */
  private async reportUsage(): Promise<void> {
    if (!this.model && this.totalTokensIn === 0 && this.totalTokensOut === 0) {
      return; // No usage data to report
    }

    try {
      const url = `${this.env.API_URL}/api/internal/code-review-usage/${this.state.reviewId}`;
      const payload = {
        model: this.model,
        totalTokensIn: this.totalTokensIn,
        totalTokensOut: this.totalTokensOut,
        totalCost: this.totalCost,
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Secret': this.env.INTERNAL_API_SECRET,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[CodeReviewOrchestrator] Failed to report usage:', {
          reviewId: this.state.reviewId,
          status: response.status,
          error: errorText,
        });
      } else {
        console.log('[CodeReviewOrchestrator] Usage reported', {
          reviewId: this.state.reviewId,
          model: this.model,
          totalTokensIn: this.totalTokensIn,
          totalTokensOut: this.totalTokensOut,
          totalCost: this.totalCost,
        });
      }
    } catch (error) {
      // Non-blocking — usage reporting failure should not affect review completion
      console.error('[CodeReviewOrchestrator] Error reporting usage:', {
        reviewId: this.state.reviewId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
    agentVersion?: string;
    previousCloudAgentSessionId?: string;
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
      agentVersion: params.agentVersion,
      previousCloudAgentSessionId: params.previousCloudAgentSessionId,
    };
    await this.saveState();
    await this.ctx.storage.setAlarm(
      Date.now() + CodeReviewOrchestrator.RUN_REVIEW_FALLBACK_DELAY_MS
    );

    console.log('[CodeReviewOrchestrator] Review created and queued', {
      reviewId: params.reviewId,
      owner: params.owner,
      agentVersion: params.agentVersion,
    });

    console.log('[CodeReviewOrchestrator] Scheduled queued review fallback alarm', {
      reviewId: params.reviewId,
      fallbackInMs: CodeReviewOrchestrator.RUN_REVIEW_FALLBACK_DELAY_MS,
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

    if (this.state.agentVersion !== 'v2') {
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
      agentVersion: this.state.agentVersion,
      previousCloudAgentSessionId: undefined,
    });

    console.warn(
      '[CodeReviewOrchestrator] Retrying review with fresh session after infra failure',
      {
        reviewId: this.state.reviewId,
        failedAttemptId: this.state.attemptId,
        retryAttemptId: params.retryAttemptId,
        reason: params.reason,
        status: started.status,
      }
    );

    return started.status === 'queued' || started.status === 'running';
  }

  /**
   * RPC method: Cancel a running review.
   * Sets the cancellation flag to stop stream processing and interrupts the cloud agent session.
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

    // Set cancellation flag to stop stream processing
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

  /**
   * Interrupt the cloud agent session to stop it from running and posting comments.
   * Routes to the correct backend based on agentVersion.
   */
  private async interruptCloudAgentSession(sessionId: string): Promise<void> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.state.authToken}`,
    };

    if (this.state.agentVersion === 'v2') {
      await this.getCloudAgentNextClient().interruptSession(headers, {
        sessionId,
      });
    } else {
      // Legacy cloud-agent path — raw fetch (SSE-based service, not covered by shared client)
      const response = await fetch(`${this.env.CLOUD_AGENT_URL}/trpc/interruptSession`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Cloud agent returned ${response.status}: ${errorText}`);
      }
    }
  }

  /**
   * RPC method: Get events for this review (used by SSE/cloud-agent flow only).
   */
  async getEvents(): Promise<{ events: CodeReviewEvent[] }> {
    await this.loadState();

    if (!this.state) {
      return { events: [] };
    }

    return {
      events: this.state.events || [],
    };
  }

  /**
   * RPC method: Run the review.
   * Called via HTTP context (not alarm) to avoid 15-minute wall time limit.
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

    // Branch based on agent version
    const agentVersion = this.state.agentVersion;
    console.log('[CodeReviewOrchestrator] runReview routing decision', {
      reviewId: this.state.reviewId,
      agentVersion,
      agentVersionType: typeof agentVersion,
      willUseV2: agentVersion === 'v2',
    });

    if (agentVersion === 'v2') {
      if (this.state.previousCloudAgentSessionId) {
        await this.runWithCloudAgentNextFollowup();
      } else {
        await this.runWithCloudAgentNext();
      }
    } else {
      await this.runWithCloudAgent();
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

      const prepareInput = {
        ...this.state.sessionInput,
        createdOnPlatform: 'code-review' as const,
        callbackTarget,
      };

      console.log('[CodeReviewOrchestrator] Calling prepareSession', {
        reviewId: this.state.reviewId,
        callbackUrl: callbackTarget.url,
        createdOnPlatform: prepareInput.createdOnPlatform,
        skipBalanceCheck: this.state.skipBalanceCheck,
      });

      const { cloudAgentSessionId, kiloSessionId } = await client.prepareSession(
        internalHeaders,
        prepareInput
      );

      console.log('[CodeReviewOrchestrator] Session prepared', {
        reviewId: this.state.reviewId,
        cloudAgentSessionId,
        kiloSessionId,
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

  // ---------------------------------------------------------------------------
  // cloud-agent flow (default / legacy)
  // Uses SSE streaming via initiateSessionAsync.
  // ---------------------------------------------------------------------------

  /**
   * Orchestration via cloud-agent (SSE).
   * Calls cloud agent async streaming endpoint with callback for reliable completion notification.
   * The callback ensures status is updated even if this DO dies or the SSE connection drops.
   */
  private async runWithCloudAgent(): Promise<void> {
    const runStartTime = Date.now();

    try {
      const statusUpdateResult = await this.updateStatus('running');
      if (statusUpdateResult === 'db-terminal') return;

      console.log('[CodeReviewOrchestrator] Starting review with async streaming', {
        reviewId: this.state.reviewId,
        timestamp: new Date().toISOString(),
      });

      // Build session input with callback for reliable completion notification
      // The callback URL includes reviewId in the path so cloud agent stays generic
      const callbackTarget = await callbackTargetForAttempt(
        this.env.API_URL,
        this.state.reviewId,
        this.state.attemptId,
        this.env.CALLBACK_TOKEN_SECRET
      );
      const sessionInputWithCallback = {
        ...this.state.sessionInput,
        createdOnPlatform: 'code-review',
        callbackUrl: callbackTarget.url,
        callbackHeaders: callbackTarget.headers,
      };

      // Build tRPC SSE endpoint with query parameter
      // tRPC subscriptions use GET with ?input=<encoded-json>
      // Use new initiateSessionAsync endpoint which invokes callback on completion/error
      const inputJson = JSON.stringify(sessionInputWithCallback);
      const encodedInput = encodeURIComponent(inputJson);
      const cloudAgentUrl = `${this.env.CLOUD_AGENT_URL}/trpc/initiateSessionAsync?input=${encodedInput}`;

      console.log('[CodeReviewOrchestrator] Initiating fetch to cloud agent', {
        reviewId: this.state.reviewId,
        url: cloudAgentUrl.split('?')[0], // Log URL without query params
        callbackUrl: sessionInputWithCallback.callbackUrl,
        skipBalanceCheck: this.state.skipBalanceCheck,
        timestamp: new Date().toISOString(),
      });

      // Build headers, conditionally adding balance check bypass
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.state.authToken}`,
        Accept: 'text/event-stream',
      };
      if (this.state.skipBalanceCheck) {
        headers['x-skip-balance-check'] = 'true';
      }

      const response = await fetch(cloudAgentUrl, {
        method: 'GET',
        headers,
      });

      console.log('[CodeReviewOrchestrator] Fetch response received', {
        reviewId: this.state.reviewId,
        httpStatus: response.status,
        contentType: response.headers.get('content-type'),
        timestamp: new Date().toISOString(),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Cloud agent returned ${response.status}: ${errorText}`);
      }

      console.log('[CodeReviewOrchestrator] Connected to async SSE stream', {
        reviewId: this.state.reviewId,
      });

      // Process SSE stream with timeout to prevent indefinite hanging
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('SSE stream timeout - review exceeded maximum time limit')),
          CodeReviewOrchestrator.STREAM_TIMEOUT_MS
        )
      );

      await Promise.race([this.processEventStream(response), timeoutPromise]);

      // NOTE: We do NOT update status to 'completed' here anymore.
      // The cloud agent callback will handle that reliably.
      // This ensures completion is recorded even if this DO dies before we reach here.

      console.log('[CodeReviewOrchestrator] SSE stream processing finished', {
        reviewId: this.state.reviewId,
        sessionId: this.state.sessionId,
        note: 'Callback will update final status',
      });
    } catch (error) {
      // Handle local errors (connection failures, fetch errors, timeouts)
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Only mark as failed for errors that indicate cloud agent never started
      // or connection was never established. For other errors (like timeout),
      // the cloud agent callback may still fire if the session is running.
      const isConnectionError =
        errorMessage.includes('Cloud agent returned') ||
        errorMessage.includes('fetch') ||
        errorMessage.includes('network');

      if (isConnectionError) {
        await this.updateStatus('failed', { errorMessage });

        console.error('[CodeReviewOrchestrator] Review failed (connection error):', {
          reviewId: this.state.reviewId,
          error: errorMessage,
        });
      } else {
        // For other errors (timeout, stream processing), log but don't mark failed
        // The callback from cloud agent will provide the authoritative status
        console.warn(
          '[CodeReviewOrchestrator] Stream processing error (callback will provide status):',
          {
            reviewId: this.state.reviewId,
            error: errorMessage,
          }
        );
      }
    } finally {
      // Always log execution summary
      const totalExecutionTimeMs = Date.now() - runStartTime;
      const minutes = Math.floor(totalExecutionTimeMs / 60000);
      const seconds = Math.floor((totalExecutionTimeMs % 60000) / 1000);

      console.log('[CodeReviewOrchestrator] Run completed', {
        reviewId: this.state.reviewId,
        sessionId: this.state.sessionId,
        status: this.state.status,
        totalExecutionTimeMs,
        totalExecutionTime: `${minutes}m ${seconds}s`,
        model: this.model,
        totalTokensIn: this.totalTokensIn,
        totalTokensOut: this.totalTokensOut,
        totalCost: this.totalCost,
        timestamp: new Date().toISOString(),
      });

      // Report accumulated usage to Next.js backend
      // This runs before the cloud agent callback fires 'completed',
      // so usage data is persisted before the comment update is triggered.
      await this.reportUsage();
    }
  }

  /**
   * Process Server-Sent Events stream from cloud agent.
   * Parses SSE events and extracts sessionId from the first event.
   * Used only in the cloud-agent (SSE) flow.
   */
  private async processEventStream(response: Response): Promise<void> {
    if (!response.body) {
      throw new Error('No response body from cloud agent');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Tracking for logging
    let totalEventsReceived = 0;
    let eventsStored = 0;
    let eventsSkipped = 0;
    let lastProgressLogTime = Date.now();
    const PROGRESS_LOG_INTERVAL_MS = 30_000; // Log progress every 30 seconds
    const eventTypeCounts: Record<string, number> = {};

    console.log('[CodeReviewOrchestrator] Starting SSE stream processing', {
      reviewId: this.state.reviewId,
      sessionId: this.state.sessionId,
    });

    try {
      while (true) {
        // Check if cancelled before reading next chunk
        if (this.cancelled) {
          console.log('[CodeReviewOrchestrator] Stream processing cancelled', {
            reviewId: this.state.reviewId,
            totalEventsReceived,
          });
          break;
        }

        const { done, value } = (await reader.read()) as ReadableStreamReadResult<Uint8Array>;

        if (done) {
          console.log('[CodeReviewOrchestrator] SSE stream ended', {
            reviewId: this.state.reviewId,
            sessionId: this.state.sessionId,
            totalEventsReceived,
            eventsStored,
            eventsSkipped,
            eventTypeCounts,
          });
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        // Process complete lines
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          // SSE format: "data: <json>"
          if (line.startsWith('data: ')) {
            const data = line.slice(6); // Remove 'data: ' prefix

            // Skip ping/keepalive messages
            if (data === '' || data === ':ping') {
              continue;
            }

            try {
              const event = JSON.parse(data) as SseEvent;
              totalEventsReceived++;

              // Track event type counts
              const eventType = event.streamEventType || 'unknown';
              eventTypeCounts[eventType] = (eventTypeCounts[eventType] || 0) + 1;
              const isFirstEvent = totalEventsReceived === 1;
              const isStatusEvent = eventType === 'status';
              const isTerminalEvent = eventType === 'complete' || eventType === 'error';
              const isApiRequest = event.payload?.say === 'api_req_started';
              const isSessionCreated =
                eventType === 'kilocode' && event.payload?.event === 'session_created';

              if (
                isFirstEvent ||
                isStatusEvent ||
                isTerminalEvent ||
                isApiRequest ||
                isSessionCreated
              ) {
                const logData: Record<string, unknown> = {
                  reviewId: this.state.reviewId,
                  sessionId: this.state.sessionId || event.sessionId,
                  eventNumber: totalEventsReceived,
                  eventType,
                  message: (
                    event.payload?.content ||
                    event.payload?.say ||
                    event.message ||
                    ''
                  ).slice(0, 100),
                };

                // Add API request details for LLM calls
                if (isApiRequest && event.payload?.metadata) {
                  logData.model = event.payload.metadata.model;
                  logData.tokensIn = event.payload.metadata.tokensIn;
                  logData.tokensOut = event.payload.metadata.tokensOut;
                  logData.cost = event.payload.metadata.cost;

                  // Capture model from the first LLM call (intentionally ignoring subsequent
                  // calls that may use different models — the primary review model is what matters)
                  if (!this.model && typeof event.payload.metadata.model === 'string') {
                    this.model = event.payload.metadata.model;
                  }
                  if (typeof event.payload.metadata.tokensIn === 'number') {
                    this.totalTokensIn += event.payload.metadata.tokensIn;
                  }
                  if (typeof event.payload.metadata.tokensOut === 'number') {
                    this.totalTokensOut += event.payload.metadata.tokensOut;
                  }
                  if (typeof event.payload.metadata.cost === 'number') {
                    this.totalCost += event.payload.metadata.cost;
                  }

                  // Sync usage data to persistent state so it survives DO eviction
                  this.state.model = this.model;
                  this.state.totalTokensIn = this.totalTokensIn;
                  this.state.totalTokensOut = this.totalTokensOut;
                  this.state.totalCost = this.totalCost;
                }

                // Add CLI session ID for session_created events
                if (isSessionCreated && event.payload?.sessionId) {
                  logData.cliSessionId = event.payload.sessionId;
                }

                console.log('[CodeReviewOrchestrator] Event received', logData);
              }

              // Periodic progress logging (every 30 seconds)
              const now = Date.now();
              if (now - lastProgressLogTime >= PROGRESS_LOG_INTERVAL_MS) {
                console.log('[CodeReviewOrchestrator] Stream progress', {
                  reviewId: this.state.reviewId,
                  sessionId: this.state.sessionId,
                  totalEventsReceived,
                  eventsStored,
                  eventsSkipped,
                  eventTypeCounts,
                  bufferSize: buffer.length,
                });
                lastProgressLogTime = now;
              }

              // Store event in state for later retrieval (skip partial events for cleaner output)
              const isPartial = event.payload?.partial === true;
              const shouldStore = !isPartial;

              if (!shouldStore) {
                eventsSkipped++;
              }

              if (shouldStore) {
                if (!this.state.events) {
                  this.state.events = [];
                }

                // Extract meaningful message and content based on event type
                let message = '';
                let content: string | undefined;
                const payload = event.payload || {};
                eventsStored++;

                if (payload.ask === 'command' && typeof payload.text === 'string') {
                  const riskyPattern = findRiskyPattern(payload.text);
                  const logFn = riskyPattern ? console.warn : console.log;
                  logFn('[CodeReviewOrchestrator] Command request observed', {
                    reviewId: this.state.reviewId,
                    sessionId: this.state.sessionId,
                    eventNumber: totalEventsReceived,
                    riskyPattern,
                    command: payload.text.slice(0, 300),
                  });
                }

                // Prioritize showing content if present
                if (payload.content) {
                  message = payload.content;
                } else if (payload.say === 'api_req_started') {
                  const rawProvider = payload.metadata?.inferenceProvider;
                  const provider = typeof rawProvider === 'string' ? rawProvider : 'API';
                  const tokensIn = Number(payload.metadata?.tokensIn ?? 0);
                  const tokensOut = Number(payload.metadata?.tokensOut ?? 0);
                  const cost = Number(payload.metadata?.cost ?? 0);
                  message = `${provider} request: ${tokensIn.toLocaleString()} tokens in, ${tokensOut.toLocaleString()} tokens out`;
                  if (cost > 0) {
                    content = `Cost: $${cost.toFixed(4)}`;
                  }
                } else if (payload.say === 'mcp_server_request_started') {
                  message = 'Tool request started';
                } else if (payload.say === 'mcp_server_response') {
                  message = 'Tool response received';
                  // Store metadata as content if present
                  if (payload.metadata && typeof payload.metadata === 'object') {
                    try {
                      content = JSON.stringify(payload.metadata, null, 2);
                    } catch (_e) {
                      // Ignore stringify errors
                    }
                  }
                } else if (payload.ask === 'use_mcp_server' && payload.metadata) {
                  const rawServerName = payload.metadata.serverName;
                  const serverName = typeof rawServerName === 'string' ? rawServerName : '';
                  const rawToolName = payload.metadata.toolName;
                  const toolName = typeof rawToolName === 'string' ? rawToolName : '';
                  const args = payload.metadata.arguments;
                  message = `Using ${serverName}/${toolName}`;

                  // Log submit_review calls to detect approval issues
                  if (toolName === 'submit_review' || toolName === 'pull_request_review_write') {
                    console.log('[CodeReviewOrchestrator] GitHub review submission detected', {
                      reviewId: this.state.reviewId,
                      sessionId: this.state.sessionId,
                      toolName,
                      arguments: args,
                    });
                  }

                  if (typeof args === 'string') {
                    content = args;
                  } else if (args != null) {
                    content = JSON.stringify(args);
                  }
                } else {
                  message = payload.say || event.message || '';
                }

                if (message) {
                  this.state.events.push({
                    timestamp: new Date().toISOString(),
                    eventType: event.streamEventType || 'unknown',
                    message,
                    content,
                    sessionId: event.sessionId,
                  });

                  this.unsavedEventCount++;

                  // Only save every N events to reduce CPU usage from repeated serialization
                  if (this.unsavedEventCount >= CodeReviewOrchestrator.EVENT_BATCH_SIZE) {
                    try {
                      await this.saveState();
                      console.log('[CodeReviewOrchestrator] Saved event batch', {
                        reviewId: this.state.reviewId,
                        sessionId: this.state.sessionId,
                        batchSize: this.unsavedEventCount,
                        totalEventsStored: this.state.events.length,
                      });
                      this.unsavedEventCount = 0;
                    } catch (saveError) {
                      console.error('[CodeReviewOrchestrator] Failed to save event batch:', {
                        reviewId: this.state.reviewId,
                        sessionId: this.state.sessionId,
                        eventsCount: this.state.events.length,
                        error: saveError,
                      });
                      // Continue processing - events are for display only
                    }
                  }
                }
              }

              // Extract cloud agent sessionId from first event
              if (!this.state.sessionId && event.sessionId) {
                const sessionId = event.sessionId;
                console.log('[CodeReviewOrchestrator] Captured sessionId from SSE event', {
                  reviewId: this.state.reviewId,
                  sessionId,
                  eventNumber: totalEventsReceived,
                });
                try {
                  await this.updateStatus('running', { sessionId });
                } catch (updateError) {
                  console.error(
                    '[CodeReviewOrchestrator] Failed to update status with sessionId:',
                    {
                      reviewId: this.state.reviewId,
                      sessionId,
                      error: updateError,
                    }
                  );
                  // Continue processing even if status update fails
                }
              }

              // Extract CLI session ID from session_created event
              // The CLI session ID is in payload.sessionId when payload.event === 'session_created'
              if (!this.state.cliSessionId && eventType === 'kilocode') {
                const payload = event.payload as Record<string, unknown> | undefined;

                if (payload?.event === 'session_created' && typeof payload.sessionId === 'string') {
                  const cliSessionId = payload.sessionId;
                  console.log(
                    '[CodeReviewOrchestrator] Captured CLI session ID from session_created event',
                    {
                      reviewId: this.state.reviewId,
                      cliSessionId,
                      eventNumber: totalEventsReceived,
                    }
                  );
                  try {
                    await this.updateStatus('running', { cliSessionId });
                  } catch (updateError) {
                    console.error(
                      '[CodeReviewOrchestrator] Failed to update status with cliSessionId:',
                      {
                        reviewId: this.state.reviewId,
                        cliSessionId,
                        error: updateError,
                      }
                    );
                    // Continue processing even if status update fails
                  }
                }
              }

              // Handle completion event
              if (event.streamEventType === 'complete') {
                // Flush any remaining unsaved events
                if (this.unsavedEventCount > 0) {
                  try {
                    await this.saveState();
                    this.unsavedEventCount = 0;
                  } catch (saveError) {
                    console.error('[CodeReviewOrchestrator] Failed to save final event batch:', {
                      reviewId: this.state.reviewId,
                      eventsCount: this.state.events?.length,
                      error: saveError,
                    });
                  }
                }
                console.log('[CodeReviewOrchestrator] Stream completion event received', {
                  reviewId: this.state.reviewId,
                  sessionId: this.state.sessionId,
                  totalEventsReceived,
                  eventsStored,
                });
                break;
              }
            } catch (parseError) {
              // Enhanced logging to identify actual cause of parse failures
              const errorInfo = {
                reviewId: this.state.reviewId,
                sessionId: this.state.sessionId,
                eventNumber: totalEventsReceived + 1,
                // Data info
                dataLength: data.length,
                dataFirst100: data.slice(0, 100),
                dataLast50: data.slice(-50),
                // Error details
                errorType: parseError?.constructor?.name || 'unknown',
                errorMessage: parseError instanceof Error ? parseError.message : String(parseError),
                errorName: parseError instanceof Error ? parseError.name : undefined,
              };

              console.error('[CodeReviewOrchestrator] SSE parse error:', errorInfo);
              // Skip this event and continue with the next one
            }
          }
        }
      }
    } finally {
      reader.releaseLock();

      // Final summary log
      console.log('[CodeReviewOrchestrator] Stream processing complete', {
        reviewId: this.state.reviewId,
        sessionId: this.state.sessionId,
        totalEventsReceived,
        eventsStored,
        eventsSkipped,
        eventTypeCounts,
        finalBufferSize: buffer.length,
        unsavedEventCount: this.unsavedEventCount,
      });
    }
  }
}
