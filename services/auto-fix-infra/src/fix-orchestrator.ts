/**
 * AutoFixOrchestrator Durable Object
 *
 * Manages the lifecycle of a single auto-fix ticket:
 * - Session preparation/initiation in cloud-agent-next
 * - Status updates back to Next.js
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env, FixTicket, FixRequest, ClassificationResult } from './types';
import { buildPRPrompt, buildReviewCommentPrompt } from './services/prompt-builder';
import { CloudAgentNextClient } from './services/cloud-agent-next-client';

export class AutoFixOrchestrator extends DurableObject<Env> {
  private state!: FixTicket;

  /** Cleanup delay after completion (7 days) */
  private static readonly CLEANUP_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

  private getCloudAgentBaseUrl(): string {
    return this.env.CLOUD_AGENT_URL;
  }

  /**
   * Initialize the fix session
   */
  async start(params: FixRequest): Promise<{ status: string }> {
    this.state = {
      ticketId: params.ticketId,
      authToken: params.authToken,
      sessionInput: params.sessionInput,
      owner: params.owner,
      triggerSource: params.triggerSource || 'label',
      status: 'pending',
      updatedAt: new Date().toISOString(),
    };

    await this.ctx.storage.put('state', this.state);

    return { status: 'pending' };
  }

  /**
   * Run the fix process
   * Called via waitUntil() from the HTTP handler
   */
  async runFix(): Promise<void> {
    await this.loadState();

    if (this.state.status !== 'pending') {
      console.log('[AutoFixOrchestrator] Skipping - already processed', {
        ticketId: this.state.ticketId,
        status: this.state.status,
      });
      return;
    }

    await this.updateStatus('running');

    try {
      // Create PR using Cloud Agent
      await this.createPR();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      console.error('[AutoFixOrchestrator] Error:', {
        ticketId: this.state.ticketId,
        error: errorMessage,
      });

      if (this.state.triggerSource === 'review_comment') {
        // notifyReviewCommentFailure calls handleCommentReply which already
        // marks the ticket as failed — only fall through to updateStatus if
        // the notification itself failed.
        const notified = await this.notifyReviewCommentFailure(this.state.sessionId, errorMessage);
        if (notified) {
          return;
        }
      }

      try {
        await this.updateStatus('failed', {
          errorMessage: errorMessage,
        });
      } catch (statusError) {
        console.error('[AutoFixOrchestrator] Failed to update ticket to failed state', {
          ticketId: this.state.ticketId,
          error: statusError instanceof Error ? statusError.message : String(statusError),
        });
      }
    }
  }

  /**
   * Get events for this fix session
   */
  async getEvents(): Promise<{ events: unknown[] }> {
    await this.loadState();
    return { events: this.state.events || [] };
  }

  /**
   * Load state from Durable Object storage
   */
  private async loadState(): Promise<void> {
    const stored = await this.ctx.storage.get<FixTicket>('state');
    if (!stored) {
      throw new Error('State not found');
    }
    this.state = stored;
  }

  /**
   * Prepare and initiate an auto-fix execution in cloud-agent-next.
   * Terminal handling (including PR creation for issue tickets) happens in callback routes.
   */
  private async createPR(): Promise<void> {
    console.log('[AutoFixOrchestrator] Creating PR', {
      ticketId: this.state.ticketId,
      issueNumber: this.state.sessionInput.issueNumber,
    });

    // Get configuration from Next.js API
    const configResponse = await fetch(`${this.env.API_URL}/api/internal/auto-fix/config`, {
      method: 'POST',
      headers: {
        'X-Internal-Secret': this.env.INTERNAL_API_SECRET,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ticketId: this.state.ticketId,
      }),
    });

    if (!configResponse.ok) {
      const errorText = await configResponse.text();
      throw new Error(`Failed to get PR config: ${configResponse.statusText} - ${errorText}`);
    }

    const configData: {
      githubToken?: string;
      config: {
        model_slug: string;
        custom_instructions?: string | null;
      };
    } = await configResponse.json();
    const githubToken = configData.githubToken;
    const config = configData.config;

    // Build callback URL for Cloud Agent
    const callbackUrl = `${this.env.API_URL}/api/internal/auto-fix/pr-callback`;

    // Determine if this is a review comment trigger
    const isReviewCommentFix = this.state.triggerSource === 'review_comment';
    const reviewCommentUpstreamBranch = this.state.sessionInput.upstreamBranch?.trim();

    if (isReviewCommentFix && !reviewCommentUpstreamBranch) {
      throw new Error(
        'Review comment fixes require upstreamBranch (PR head branch). Refusing session/{id} fallback.'
      );
    }

    let prompt: string;

    if (isReviewCommentFix) {
      // Build scoped review comment prompt
      prompt = buildReviewCommentPrompt(
        {
          repoFullName: this.state.sessionInput.repoFullName,
          prNumber: this.state.sessionInput.issueNumber,
          prTitle: this.state.sessionInput.issueTitle,
          reviewCommentBody: this.state.sessionInput.reviewCommentBody || '',
          filePath: this.state.sessionInput.filePath || '',
          lineNumber: this.state.sessionInput.lineNumber,
          diffHunk: this.state.sessionInput.diffHunk || '',
        },
        {
          custom_instructions: config.custom_instructions,
        },
        this.state.ticketId
      );
    } else {
      // Build classification result from session input
      const classification: ClassificationResult = {
        classification: this.state.sessionInput.classification || 'bug',
        confidence: this.state.sessionInput.confidence || 0.9,
        intentSummary: this.state.sessionInput.intentSummary || 'Fix the reported issue',
        relatedFiles: this.state.sessionInput.relatedFiles,
      };

      // Build PR creation prompt using comprehensive template
      prompt = buildPRPrompt(
        {
          repoFullName: this.state.sessionInput.repoFullName,
          issueNumber: this.state.sessionInput.issueNumber,
          issueTitle: this.state.sessionInput.issueTitle,
          issueBody: this.state.sessionInput.issueBody,
        },
        classification,
        {
          custom_instructions: config.custom_instructions,
        },
        this.state.ticketId
      );
    }

    await this.createFixWithCloudAgentNext({
      prompt,
      model: config.model_slug,
      githubToken,
      callbackUrl,
      upstreamBranch: reviewCommentUpstreamBranch,
    });
  }

  private async createFixWithCloudAgentNext(params: {
    prompt: string;
    model: string;
    githubToken?: string;
    callbackUrl: string;
    upstreamBranch?: string;
  }): Promise<void> {
    const cloudAgentBaseUrl = this.getCloudAgentBaseUrl();
    const internalApiKey = this.env.INTERNAL_API_SECRET;

    const cloudAgentNextClient = new CloudAgentNextClient(
      cloudAgentBaseUrl,
      this.state.authToken,
      internalApiKey
    );

    const prepareInput = {
      githubRepo: this.state.sessionInput.repoFullName,
      kilocodeOrganizationId: this.state.owner.type === 'org' ? this.state.owner.id : undefined,
      prompt: params.prompt,
      mode: 'code' as const,
      model: params.model,
      githubToken: params.githubToken,
      autoCommit: true,
      createdOnPlatform: 'autofix',
      ...(params.upstreamBranch ? { upstreamBranch: params.upstreamBranch } : {}),
      callbackTarget: {
        url: params.callbackUrl,
        headers: {
          'X-Internal-Secret': this.env.INTERNAL_API_SECRET,
        },
      },
    };

    console.log('[AutoFixOrchestrator] Preparing auto-fix session in cloud-agent-next', {
      ticketId: this.state.ticketId,
      triggerSource: this.state.triggerSource,
      cloudAgentBaseUrl,
      callbackUrl: params.callbackUrl,
      upstreamBranch: params.upstreamBranch,
      internalKeyLength: internalApiKey.length,
    });

    const prepareResult = await cloudAgentNextClient.prepareSession(
      prepareInput,
      this.state.ticketId
    );

    // Only store sessionId here — the kilo CLI session ID from cloud-agent-next
    // is not a UUID and violates the cli_session_id FK to cli_sessions.
    await this.updateStatus('running', {
      sessionId: prepareResult.cloudAgentSessionId,
    });

    const initiateResult = await cloudAgentNextClient.initiateFromPreparedSession(
      prepareResult.cloudAgentSessionId,
      this.state.ticketId
    );

    console.log('[AutoFixOrchestrator] Auto-fix execution started in cloud-agent-next', {
      ticketId: this.state.ticketId,
      triggerSource: this.state.triggerSource,
      sessionId: prepareResult.cloudAgentSessionId,
      cliSessionId: prepareResult.kiloSessionId,
      executionId: initiateResult.executionId,
      status: initiateResult.status,
    });

    // Terminal status and PR creation are delivered via callback queue to
    // /api/internal/auto-fix/pr-callback.
  }

  /**
   * Best-effort failure notification for review-comment tickets when
   * preparation/initiation fails before the callback can run.
   */
  /** Returns true when the comment-reply endpoint successfully updated the ticket. */
  private async notifyReviewCommentFailure(
    sessionId: string | undefined,
    errorMessage: string
  ): Promise<boolean> {
    console.log('[AutoFixOrchestrator] Notifying review comment failure', {
      ticketId: this.state.ticketId,
      sessionId,
      hasError: true,
    });

    try {
      const response = await fetch(`${this.env.API_URL}/api/internal/auto-fix/comment-reply`, {
        method: 'POST',
        headers: {
          'X-Internal-Secret': this.env.INTERNAL_API_SECRET,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ticketId: this.state.ticketId,
          sessionId,
          outcome: 'failed',
          errorMessage,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.warn('[AutoFixOrchestrator] Failed to notify review comment failure', {
          ticketId: this.state.ticketId,
          sessionId,
          httpStatus: response.status,
          httpStatusText: response.statusText,
          errorText,
        });
        return false;
      }

      console.log('[AutoFixOrchestrator] Review comment failure notification succeeded', {
        ticketId: this.state.ticketId,
        sessionId,
      });
      return true;
    } catch (notifyError) {
      console.warn('[AutoFixOrchestrator] Error notifying review comment failure', {
        ticketId: this.state.ticketId,
        sessionId,
        error: notifyError instanceof Error ? notifyError.message : String(notifyError),
      });
      return false;
    }
  }

  /**
   * Update status in Durable Object and Next.js
   */
  private async updateStatus(status: string, updates: Partial<FixTicket> = {}): Promise<void> {
    this.state.status = status as FixTicket['status'];
    this.state.updatedAt = new Date().toISOString();

    if (status === 'running' && !this.state.startedAt) {
      this.state.startedAt = new Date().toISOString();
    }

    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      this.state.completedAt = new Date().toISOString();
    }

    // Apply updates
    Object.assign(this.state, updates);

    // Save to Durable Object storage
    await this.ctx.storage.put('state', this.state);

    // Update Next.js database
    const response = await fetch(
      `${this.env.API_URL}/api/internal/auto-fix-status/${this.state.ticketId}`,
      {
        method: 'POST',
        headers: {
          'X-Internal-Secret': this.env.INTERNAL_API_SECRET,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          status,
          ...updates,
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown');
      console.error('[AutoFixOrchestrator] Failed to update status in Next.js database', {
        ticketId: this.state.ticketId,
        status,
        httpStatus: response.status,
        errorText,
      });
      throw new Error(
        `Failed to update ticket status in database: ${response.status} ${response.statusText}`
      );
    }
  }
}
