/**
 * TriageOrchestrator Durable Object
 *
 * Manages the lifecycle of a single triage ticket:
 * - Duplicate detection
 * - Issue classification
 * - Applying AI-selected labels
 * - Status updates back to Next.js
 */

import { DurableObject } from 'cloudflare:workers';
import type {
  Env,
  TriageTicket,
  TriageRequest,
  DuplicateResult,
  ClassificationResult,
} from './types';
import { parseClassification } from './parsers/classification-parser';
import { SSEStreamProcessor } from './services/sse-stream-processor';
import { CloudAgentClient } from './services/cloud-agent-client';
import { buildClassificationPrompt } from './services/prompt-builder';
import { fetchRepoLabels, DEFAULT_LABELS } from './services/github-labels-service';

export class TriageOrchestrator extends DurableObject<Env> {
  private state!: TriageTicket;
  private sseProcessor = new SSEStreamProcessor();

  /** Default classification timeout (5 minutes) - used if not configured */
  private static readonly DEFAULT_CLASSIFICATION_TIMEOUT_MS = 5 * 60 * 1000;

  /**
   * Get classification timeout from config or use default
   */
  private getClassificationTimeout(): number {
    const minutes = this.state.sessionInput.maxClassificationTimeMinutes;
    return minutes ? minutes * 60 * 1000 : TriageOrchestrator.DEFAULT_CLASSIFICATION_TIMEOUT_MS;
  }

  /**
   * Initialize the triage session
   */
  async start(params: TriageRequest): Promise<{ status: string }> {
    this.state = {
      ticketId: params.ticketId,
      authToken: params.authToken,
      sessionInput: params.sessionInput,
      owner: params.owner,
      status: 'pending',
      updatedAt: new Date().toISOString(),
    };

    await this.ctx.storage.put('state', this.state);

    return { status: 'pending' };
  }

  /**
   * Run the triage process
   * Called via waitUntil() from the HTTP handler
   */
  async runTriage(): Promise<void> {
    await this.loadState();

    if (this.state.status !== 'pending') {
      console.log('[TriageOrchestrator] Skipping - already processed', {
        ticketId: this.state.ticketId,
        status: this.state.status,
      });
      return;
    }

    await this.updateStatus('analyzing');

    // Set alarm as safety net for stuck tickets
    const alarmTimeout = this.getClassificationTimeout() + 120_000; // classification timeout + 2 min buffer
    await this.ctx.storage.setAlarm(Date.now() + alarmTimeout);

    try {
      // Step 1: Check for duplicates
      const duplicateResult = await this.checkDuplicates();
      if (duplicateResult.isDuplicate) {
        const labels = ['kilo-triaged', 'kilo-duplicate'];
        console.log('[auto-triage:labels] Calling applyLabels { labels[] }', {
          ticketId: this.state.ticketId,
          labels,
        });
        await this.applyLabels(labels);
        await this.closeDuplicate(duplicateResult);
        return;
      }

      // Step 2: Classify the issue
      const classification = await this.classifyIssue();

      // Step 3: Take action based on classification
      if (classification.classification === 'question') {
        const labels = ['kilo-triaged', ...classification.selectedLabels];
        console.log('[auto-triage:labels] Calling applyLabels { labels[] }', {
          ticketId: this.state.ticketId,
          labels,
        });
        await this.applyLabels(labels);
        await this.answerQuestion(classification);
      } else if (classification.classification === 'unclear') {
        const labels = ['kilo-triaged', ...classification.selectedLabels];
        console.log('[auto-triage:labels] Calling applyLabels { labels[] }', {
          ticketId: this.state.ticketId,
          labels,
        });
        await this.applyLabels(labels);
        await this.requestClarification(classification);
      } else if (classification.confidence >= this.state.sessionInput.autoFixThreshold) {
        // Apply labels and trigger Auto Fix workflow
        console.log('[auto-triage:labels] selectedLabels from AI classification', {
          ticketId: this.state.ticketId,
          selectedLabels: classification.selectedLabels,
        });
        const labels = [
          ...new Set(['kilo-triaged', 'kilo-auto-fix', ...classification.selectedLabels]),
        ];
        console.log('[auto-triage:labels] Calling applyLabels { labels[] }', {
          ticketId: this.state.ticketId,
          labels,
        });
        await this.applyLabels(labels);
        await this.updateStatus('actioned', {
          classification: classification.classification,
          confidence: classification.confidence,
          intentSummary: classification.intentSummary,
          relatedFiles: classification.relatedFiles,
        });
      } else {
        const labels = ['kilo-triaged', ...classification.selectedLabels];
        console.log('[auto-triage:labels] Calling applyLabels { labels[] }', {
          ticketId: this.state.ticketId,
          labels,
        });
        await this.applyLabels(labels);
        await this.requestClarification(classification);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const isTimeout = error instanceof Error && error.message.includes('timed out');
      const isClassificationTimeout =
        error instanceof Error && error.message.includes('Classification timed out');
      const isPRTimeout = error instanceof Error && error.message.includes('PR creation timed out');

      console.error('[TriageOrchestrator] Error:', {
        ticketId: this.state.ticketId,
        error: errorMessage,
        isTimeout,
        isClassificationTimeout,
        isPRTimeout,
      });

      try {
        await this.updateStatus('failed', {
          errorMessage: errorMessage,
        });
      } catch (statusError) {
        console.error('[TriageOrchestrator] Failed to update status to failed via API:', {
          ticketId: this.state.ticketId,
          statusError: statusError instanceof Error ? statusError.message : String(statusError),
        });
        this.state.status = 'failed';
        this.state.errorMessage = errorMessage;
        this.state.completedAt = new Date().toISOString();
        this.state.updatedAt = new Date().toISOString();
        await this.ctx.storage.put('state', this.state);
      }
    }
  }

  /**
   * Get events for this triage session
   */
  async getEvents(): Promise<{ events: unknown[] }> {
    await this.loadState();
    return { events: this.state.events || [] };
  }

  /**
   * Alarm handler - recovers tickets stuck in "analyzing" status
   * Fires if the DO is evicted/restarted or triage takes too long
   */
  async alarm(): Promise<void> {
    await this.loadState();

    if (this.state.status !== 'analyzing') {
      return;
    }

    console.error('[TriageOrchestrator] Alarm fired - ticket stuck in analyzing', {
      ticketId: this.state.ticketId,
      startedAt: this.state.startedAt,
    });

    try {
      await this.updateStatus('failed', {
        errorMessage: 'Triage timed out (alarm recovery)',
      });
    } catch (e) {
      console.error('[TriageOrchestrator] Alarm recovery: failed to update status via API', {
        ticketId: this.state.ticketId,
        error: e instanceof Error ? e.message : String(e),
      });
      this.state.status = 'failed';
      this.state.errorMessage = 'Triage timed out (alarm recovery, status update failed)';
      this.state.completedAt = new Date().toISOString();
      this.state.updatedAt = new Date().toISOString();
      await this.ctx.storage.put('state', this.state);
    }
  }

  /**
   * Load state from Durable Object storage
   */
  private async loadState(): Promise<void> {
    const stored = await this.ctx.storage.get<TriageTicket>('state');
    if (!stored) {
      throw new Error('State not found');
    }
    this.state = stored;
  }

  /**
   * Check for duplicate issues
   */
  private async checkDuplicates(): Promise<DuplicateResult> {
    // This will call the Next.js API to run duplicate detection
    const response = await fetch(`${this.env.API_URL}/api/internal/triage/check-duplicates`, {
      method: 'POST',
      headers: {
        'X-Internal-Secret': this.env.INTERNAL_API_SECRET,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ticketId: this.state.ticketId }),
    });

    if (!response.ok) {
      throw new Error(`Duplicate check failed: ${response.statusText}`);
    }

    return await response.json();
  }

  /**
   * Classify the issue
   * Now handles Cloud Agent session directly (like PR creation)
   */
  private async classifyIssue(): Promise<ClassificationResult> {
    console.log('[TriageOrchestrator] Classifying issue', {
      ticketId: this.state.ticketId,
    });

    // Get configuration from Next.js API
    const configResponse = await fetch(`${this.env.API_URL}/api/internal/triage/classify-config`, {
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
      throw new Error(
        `Failed to get classification config: ${configResponse.statusText} - ${errorText}`
      );
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

    if (!githubToken) {
      console.log(
        '[auto-triage:labels] No githubToken in classify-config response, will use default labels',
        {
          ticketId: this.state.ticketId,
        }
      );
    }

    // Fetch available labels from the repository (falls back to defaults on error or no token)
    const availableLabels = githubToken
      ? await fetchRepoLabels(this.state.sessionInput.repoFullName, githubToken)
      : DEFAULT_LABELS;

    console.log('[auto-triage:labels] Available labels for prompt', {
      ticketId: this.state.ticketId,
      count: availableLabels.length,
      availableLabels,
    });

    // Build classification prompt with available labels
    const prompt = buildClassificationPrompt(
      {
        repoFullName: this.state.sessionInput.repoFullName,
        issueNumber: this.state.sessionInput.issueNumber,
        issueTitle: this.state.sessionInput.issueTitle,
        issueBody: this.state.sessionInput.issueBody,
      },
      config,
      availableLabels
    );

    // Build session input
    const sessionInput = {
      githubRepo: this.state.sessionInput.repoFullName,
      kilocodeOrganizationId: this.state.owner.type === 'org' ? this.state.owner.id : undefined,
      prompt,
      mode: 'ask' as const, // Classification is a Q&A task
      model: config.model_slug,
      githubToken,
    };

    // Use CloudAgentClient to initiate session
    const cloudAgentClient = new CloudAgentClient(this.env.CLOUD_AGENT_URL, this.state.authToken);
    const response = await cloudAgentClient.initiateSession(sessionInput, this.state.ticketId);

    // Add timeout protection for classification
    const timeoutMs = this.getClassificationTimeout();
    const timeoutMinutes = Math.floor(timeoutMs / 60000);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(new Error(`Classification timed out - exceeded ${timeoutMinutes} minute limit`)),
        timeoutMs
      )
    );

    // Process SSE stream with timeout
    return await Promise.race([
      this.processClassificationStream(response, availableLabels),
      timeoutPromise,
    ]);
  }

  /**
   * Close issue as duplicate
   */
  private async closeDuplicate(result: DuplicateResult): Promise<void> {
    console.log('[TriageOrchestrator] Closing as duplicate', {
      ticketId: this.state.ticketId,
      duplicateOf: result.duplicateOfTicketId,
    });

    const duplicateTicket = result.similarTickets?.[0];
    if (duplicateTicket) {
      const issueUrl = `https://github.com/${duplicateTicket.repoFullName}/issues/${duplicateTicket.issueNumber}`;
      const commentBody = [
        `This issue appears to be a duplicate of ${issueUrl}.`,
        '',
        `> **${duplicateTicket.issueTitle}** (#${duplicateTicket.issueNumber})`,
        '',
        `Similarity score: ${Math.round(duplicateTicket.similarity * 100)}%`,
        '',
        '*This comment was generated by Kilo Auto-Triage.*',
      ].join('\n');

      await this.postComment(commentBody);
    }

    await this.updateStatus('actioned', {
      isDuplicate: true,
      duplicateOfTicketId: result.duplicateOfTicketId ?? undefined,
      similarityScore: result.similarityScore ?? undefined,
      actionTaken: 'closed_duplicate',
    });
  }

  /**
   * Answer a question
   */
  private async answerQuestion(classification: ClassificationResult): Promise<void> {
    console.log('[TriageOrchestrator] Answering question', {
      ticketId: this.state.ticketId,
    });

    // TODO: Implement question answering
    await this.updateStatus('actioned', {
      classification: classification.classification,
      confidence: classification.confidence,
      intentSummary: classification.intentSummary,
      actionTaken: 'comment_posted',
    });
  }

  /**
   * Request clarification
   */
  private async requestClarification(classification: ClassificationResult): Promise<void> {
    console.log('[TriageOrchestrator] Requesting clarification', {
      ticketId: this.state.ticketId,
    });

    // TODO: Implement clarification request
    await this.updateStatus('actioned', {
      classification: classification.classification,
      confidence: classification.confidence,
      intentSummary: classification.intentSummary,
      actionTaken: 'needs_clarification',
    });
  }

  /**
   * Post a comment on the GitHub issue (best-effort, does not throw on failure)
   */
  private async postComment(body: string): Promise<void> {
    const response = await fetch(`${this.env.API_URL}/api/internal/triage/post-comment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': this.env.INTERNAL_API_SECRET,
      },
      body: JSON.stringify({
        ticketId: this.state.ticketId,
        body,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Failed to post comment: ${response.status} ${errorText}`);
    }
  }

  /**
   * Apply action-tracking and content labels to the issue
   */
  private async applyLabels(labels: string[]): Promise<void> {
    try {
      console.log('[TriageOrchestrator] Applying labels', {
        ticketId: this.state.ticketId,
        labels,
      });

      // Call Next.js API to add labels to the issue
      const addLabelResponse = await fetch(`${this.env.API_URL}/api/internal/triage/add-label`, {
        method: 'POST',
        headers: {
          'X-Internal-Secret': this.env.INTERNAL_API_SECRET,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ticketId: this.state.ticketId,
          labels,
        }),
      });

      if (!addLabelResponse.ok) {
        const errorText = await addLabelResponse.text();
        console.error('[TriageOrchestrator] Failed to apply labels:', {
          ticketId: this.state.ticketId,
          status: addLabelResponse.status,
          error: errorText,
        });
      }
    } catch (error) {
      console.error('[TriageOrchestrator] Error applying labels:', {
        ticketId: this.state.ticketId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Update status in Durable Object and Next.js
   */
  private async updateStatus(status: string, updates: Partial<TriageTicket> = {}): Promise<void> {
    this.state.status = status as TriageTicket['status'];
    this.state.updatedAt = new Date().toISOString();

    if (status === 'analyzing' && !this.state.startedAt) {
      this.state.startedAt = new Date().toISOString();
    }

    if (status === 'actioned' || status === 'failed') {
      this.state.completedAt = new Date().toISOString();
    }

    // Apply updates
    Object.assign(this.state, updates);

    // Save to Durable Object storage
    await this.ctx.storage.put('state', this.state);

    // Update Next.js database
    const response = await fetch(
      `${this.env.API_URL}/api/internal/triage-status/${this.state.ticketId}`,
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
      const errorText = await response.text();
      throw new Error(`Status update API returned ${response.status}: ${errorText}`);
    }

    // Cancel alarm when reaching terminal state
    if (status === 'actioned' || status === 'failed' || status === 'skipped') {
      await this.ctx.storage.deleteAlarm();
    }
  }

  /**
   * Process Cloud Agent classification stream
   * Extracts classification result from stream events
   */
  private async processClassificationStream(
    response: Response,
    availableLabels: string[]
  ): Promise<ClassificationResult> {
    let fullText = '';
    let sayText = '';

    await this.sseProcessor.processStream(response, {
      onTextContent: (text: string) => {
        fullText += text;
      },
      onKilocodeEvent: payload => {
        // Capture LLM text responses: both streaming 'text' and final 'completion_result'
        if (
          payload.type === 'say' &&
          (payload.say === 'text' || payload.say === 'completion_result')
        ) {
          const text =
            typeof payload.content === 'string'
              ? payload.content
              : typeof payload.text === 'string'
                ? payload.text
                : '';
          if (text) {
            sayText += text;
          }
        }
      },
      onComplete: () => {
        console.log('[TriageOrchestrator] Classification stream completed', {
          ticketId: this.state.ticketId,
          sayTextLength: sayText.length,
          fullTextLength: fullText.length,
        });
      },
      onError: (error: Error) => {
        // Error events are informational warnings, not fatal errors
        // The stream continues processing after these events
        console.warn('[TriageOrchestrator] Classification warning event', {
          ticketId: this.state.ticketId,
          error: error.message,
        });
      },
    });

    console.log('[TriageOrchestrator] Classification stream ended', {
      ticketId: this.state.ticketId,
      sayTextLength: sayText.length,
      fullTextLength: fullText.length,
    });

    // Parse classification from accumulated text
    return this.parseClassificationFromText(sayText, fullText, availableLabels);
  }

  /**
   * Parse classification result from text.
   * Tries sayText (LLM "say" events only) first, falls back to fullText (all events).
   */
  private parseClassificationFromText(
    sayText: string,
    fullText: string,
    availableLabels: string[]
  ): ClassificationResult {
    console.log('[TriageOrchestrator] Parsing classification', {
      ticketId: this.state.ticketId,
      sayTextLength: sayText.length,
      fullTextLength: fullText.length,
    });

    // Try sayText first if available
    if (sayText.length > 0) {
      try {
        return parseClassification(sayText, availableLabels);
      } catch (e) {
        console.warn('[TriageOrchestrator] Failed to parse from sayText, trying fullText', {
          ticketId: this.state.ticketId,
          sayTextLength: sayText.length,
          fullTextLength: fullText.length,
        });
      }
    }

    // Fall back to fullText
    return parseClassification(fullText, availableLabels);
  }
}
