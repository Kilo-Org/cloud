/**
 * CodeReviewOrchestrator - Durable Object for managing code review lifecycle.
 * Handles calling cloud agent, maintaining SSE subscription, and updating status in DB.
 */

import { DurableObject } from 'cloudflare:workers';
import type {
  Env,
  CodeReview,
  CodeReviewStatus,
  CodeReviewStatusResponse,
  CodeReviewEvent,
  SessionInput,
} from './types';

/**
 * CodeReviewOrchestrator manages the complete lifecycle of a code review.
 * Persists review state in storage and maintains connection to cloud agent.
 */
export class CodeReviewOrchestrator extends DurableObject<Env> {
  /** In-memory cache of current review state */
  private state!: CodeReview;

  /** Maximum time to wait for SSE stream (20 minutes) */
  private static readonly STREAM_TIMEOUT_MS = 20 * 60 * 1000;

  /** Cleanup delay after review completion (7 days) */
  private static readonly CLEANUP_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

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

  /**
   * Alarm handler for scheduled cleanup tasks.
   * Only used for cleanup after review completion (7 days later).
   * Review execution is handled via runReview() in HTTP context to avoid 15-min wall time limit.
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

      // Restore usage accumulators from persisted state so they survive DO eviction
      if (storedState.model) this.model = storedState.model;
      if (storedState.totalTokensIn) this.totalTokensIn = storedState.totalTokensIn;
      if (storedState.totalTokensOut) this.totalTokensOut = storedState.totalTokensOut;
      if (storedState.totalCost) this.totalCost = storedState.totalCost;
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
    }
  ): Promise<void> {
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

    // Early return only if nothing has changed
    if (!statusChanged && !sessionIdChanged && !cliSessionIdChanged && !errorMessageChanged) {
      return;
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

    this.state.updatedAt = new Date().toISOString();
    await this.saveState();

    // Update Next.js DB via internal API
    try {
      await this.updateDBStatus(status, options);
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
    }
  ): Promise<void> {
    // Use path-based endpoint (same as callback endpoint for consistency)
    const url = `${this.env.API_URL}/api/internal/code-review-status/${this.state.reviewId}`;

    // Payload without reviewId (it's in the URL path)
    const payload = {
      status,
      sessionId: options?.sessionId,
      cliSessionId: options?.cliSessionId,
      errorMessage: options?.errorMessage,
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
      throw new Error(`Failed to update DB status: ${response.status} ${errorText}`);
    }
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
    authToken: string;
    sessionInput: SessionInput;
    owner: {
      type: 'user' | 'org';
      id: string;
      userId: string;
    };
    skipBalanceCheck?: boolean;
  }): Promise<{ status: CodeReviewStatus }> {
    this.state = {
      reviewId: params.reviewId,
      authToken: params.authToken,
      sessionInput: params.sessionInput,
      owner: params.owner,
      status: 'queued',
      updatedAt: new Date().toISOString(),
      skipBalanceCheck: params.skipBalanceCheck,
    };
    await this.saveState();

    console.log('[CodeReviewOrchestrator] Review created and queued', {
      reviewId: params.reviewId,
      owner: params.owner,
    });

    // Note: Review execution is triggered via runReview() from the worker
    // Alarms are only used for cleanup after completion.

    return { status: this.state.status };
  }

  /**
   * RPC method: Return current state.
   */
  async status(): Promise<CodeReviewStatusResponse> {
    if (!this.state) {
      await this.loadState();
    }

    if (!this.state) {
      throw new Error('Review not found');
    }

    return {
      reviewId: this.state.reviewId,
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
    };
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
   * Calls the cloud agent's interruptSession tRPC mutation.
   */
  private async interruptCloudAgentSession(sessionId: string): Promise<void> {
    // Build tRPC mutation endpoint
    // tRPC mutations use POST with JSON body
    const cloudAgentUrl = `${this.env.CLOUD_AGENT_URL}/trpc/interruptSession`;

    const response = await fetch(cloudAgentUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.state.authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sessionId }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Cloud agent returned ${response.status}: ${errorText}`);
    }
  }

  /**
   * RPC method: Get events for this review.
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

    await this.run();
  }

  /**
   * Main orchestration method.
   * Calls cloud agent async streaming endpoint with callback for reliable completion notification.
   * The callback ensures status is updated even if this DO dies or the SSE connection drops.
   */
  private async run(): Promise<void> {
    const runStartTime = Date.now();

    try {
      await this.updateStatus('running');

      console.log('[CodeReviewOrchestrator] Starting review with async streaming', {
        reviewId: this.state.reviewId,
        timestamp: new Date().toISOString(),
      });

      // Build session input with callback for reliable completion notification
      // The callback URL includes reviewId in the path so cloud agent stays generic
      const sessionInputWithCallback = {
        ...this.state.sessionInput,
        createdOnPlatform: 'code-review',
        callbackUrl: `${this.env.API_URL}/api/internal/code-review-status/${this.state.reviewId}`,
        callbackHeaders: {
          'X-Internal-Secret': this.env.INTERNAL_API_SECRET,
        },
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

        const { done, value } = await reader.read();

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
              const event = JSON.parse(data);
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

                // Prioritize showing content if present
                if (payload.content) {
                  message = payload.content;
                } else if (payload.say === 'api_req_started') {
                  const provider = payload.metadata?.inferenceProvider || 'API';
                  const tokensIn = payload.metadata?.tokensIn || 0;
                  const tokensOut = payload.metadata?.tokensOut || 0;
                  const cost = payload.metadata?.cost || 0;
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
                  const { serverName, toolName, arguments: args } = payload.metadata;
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

                  if (args) {
                    content = args;
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
