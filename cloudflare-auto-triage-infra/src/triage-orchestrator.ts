/**
 * TriageOrchestrator Durable Object
 *
 * Manages the lifecycle of a single triage ticket:
 * - Duplicate detection
 * - Issue classification
 * - Tagging with kilo-auto-fix label
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

    try {
      // Step 1: Check for duplicates
      const duplicateResult = await this.checkDuplicates();
      if (duplicateResult.isDuplicate) {
        await this.closeDuplicate(duplicateResult);
        return;
      }

      // Step 2: Classify the issue
      const classification = await this.classifyIssue();

      // Step 3: Take action based on classification
      if (classification.classification === 'question') {
        await this.answerQuestion(classification);
        await this.updateStatus('actioned');
      } else if (classification.classification === 'unclear') {
        await this.requestClarification(classification);
        await this.updateStatus('actioned');
      } else if (classification.confidence >= this.state.sessionInput.autoFixThreshold) {
        // Add kilo-auto-fix label to trigger Auto Fix workflow
        await this.addAutoFixLabel(classification);
        await this.updateStatus('actioned', {
          classification: classification.classification,
          confidence: classification.confidence,
          intentSummary: classification.intentSummary,
          relatedFiles: classification.relatedFiles,
        });
      } else {
        await this.requestClarification(classification);
        await this.updateStatus('actioned');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Distinguish between timeout and other errors
      const isTimeout = errorMessage.includes('timeout');
      const isClassificationTimeout = errorMessage.includes('Classification timeout');
      const isPRTimeout = errorMessage.includes('PR creation timeout');

      console.error('[TriageOrchestrator] Error:', {
        ticketId: this.state.ticketId,
        error: errorMessage,
        isTimeout,
        isClassificationTimeout,
        isPRTimeout,
      });

      await this.updateStatus('failed', {
        errorMessage: errorMessage,
      });
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

    // Build classification prompt
    const prompt = buildClassificationPrompt(
      {
        repoFullName: this.state.sessionInput.repoFullName,
        issueNumber: this.state.sessionInput.issueNumber,
        issueTitle: this.state.sessionInput.issueTitle,
        issueBody: this.state.sessionInput.issueBody,
      },
      config
    );

    // Build session input
    const sessionInput = {
      githubRepo: this.state.sessionInput.repoFullName,
      kilocodeOrganizationId: this.state.owner.type === 'org' ? this.state.owner.id : undefined,
      prompt,
      mode: 'ask' as const, // Classification is a Q&A task
      model: config.model_slug,
      githubToken,
      createdOnPlatform: 'auto-triage',
    };

    // Use CloudAgentClient to initiate session
    const cloudAgentClient = new CloudAgentClient(this.env.CLOUD_AGENT_URL, this.state.authToken);
    const response = await cloudAgentClient.initiateSession(sessionInput, this.state.ticketId);

    // Add timeout protection for classification
    const timeoutMs = this.getClassificationTimeout();
    const timeoutMinutes = Math.floor(timeoutMs / 60000);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Classification timeout - exceeded ${timeoutMinutes} minute limit`)),
        timeoutMs
      )
    );

    // Process SSE stream with timeout
    return await Promise.race([this.processClassificationStream(response), timeoutPromise]);
  }

  /**
   * Close issue as duplicate
   */
  private async closeDuplicate(result: DuplicateResult): Promise<void> {
    console.log('[TriageOrchestrator] Closing as duplicate', {
      ticketId: this.state.ticketId,
      duplicateOf: result.duplicateOfTicketId,
    });

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
   * Add kilo-auto-fix label to trigger Auto Fix workflow
   */
  private async addAutoFixLabel(classification: ClassificationResult): Promise<void> {
    console.log('[TriageOrchestrator] Adding kilo-auto-fix label', {
      ticketId: this.state.ticketId,
      classification: classification.classification,
      confidence: classification.confidence,
    });

    // Call Next.js API to add 'kilo-auto-fix' label to issue
    await fetch(`${this.env.API_URL}/api/internal/triage/add-label`, {
      method: 'POST',
      headers: {
        'X-Internal-Secret': this.env.INTERNAL_API_SECRET,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ticketId: this.state.ticketId,
        label: 'kilo-auto-fix',
        classification: classification.classification,
        confidence: classification.confidence,
        intentSummary: classification.intentSummary,
        relatedFiles: classification.relatedFiles,
      }),
    });

    console.log('[TriageOrchestrator] kilo-auto-fix label added', {
      ticketId: this.state.ticketId,
    });
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
    await fetch(`${this.env.API_URL}/api/internal/triage-status/${this.state.ticketId}`, {
      method: 'POST',
      headers: {
        'X-Internal-Secret': this.env.INTERNAL_API_SECRET,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        status,
        ...updates,
      }),
    });
  }

  /**
   * Process Cloud Agent classification stream
   * Extracts classification result from stream events
   */
  private async processClassificationStream(response: Response): Promise<ClassificationResult> {
    let fullText = '';

    await this.sseProcessor.processStream(response, {
      onTextContent: (text: string) => {
        fullText += text;
      },
      onComplete: () => {
        console.log('[TriageOrchestrator] Classification stream completed', {
          ticketId: this.state.ticketId,
          textLength: fullText.length,
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
      textLength: fullText.length,
    });

    // Parse classification from accumulated text
    return this.parseClassificationFromText(fullText);
  }

  /**
   * Parse classification result from text
   */
  private parseClassificationFromText(fullText: string): ClassificationResult {
    return parseClassification(fullText);
  }
}
