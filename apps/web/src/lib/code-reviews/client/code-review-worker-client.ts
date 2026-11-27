import 'server-only';

import type { CodeReviewPayload } from '../triggers/prepare-review-payload';
import {
  CODE_REVIEW_WORKER_AUTH_TOKEN,
  CODE_REVIEW_WORKER_SENDER_AUTH,
} from '@kilocode/web-shared/lib/config.server';
import { fetchWithTimeout } from '@/lib/fetch-with-timeout';
import {
  resolveServiceSenderAuth,
  serviceSenderHeaders,
  type ServiceSenderAuth,
} from '@/lib/service-sender-auth';
import * as z from 'zod';

// Fetch timeout in milliseconds
const FETCH_TIMEOUT_MS = 10000;
const CODE_REVIEW_WORKER_URL = process.env.CODE_REVIEW_WORKER_URL;

/**
 * The STS audience and scopes of the Code Review Worker's routes (E4, p4's scope handoff): one
 * scope per action, granted to the `web` workload only. They join `STS_SCOPE_REGISTRY` in
 * `@kilocode/sts-contracts` with the registry-and-grants change; until then STS refuses them as
 * `unknown_scope`.
 */
const CODE_REVIEW_AUDIENCE = 'code-review';
export const CODE_REVIEW_WORKER_SCOPES = {
  dispatch: { audience: CODE_REVIEW_AUDIENCE, scope: 'code-review:review.dispatch' },
  statusRead: { audience: CODE_REVIEW_AUDIENCE, scope: 'code-review:review.status-read' },
  cancel: { audience: CODE_REVIEW_AUDIENCE, scope: 'code-review:review.cancel' },
  retryFresh: { audience: CODE_REVIEW_AUDIENCE, scope: 'code-review:review.retry-fresh' },
} as const;

type CodeReviewWorkerAction = keyof typeof CODE_REVIEW_WORKER_SCOPES;

// Types for API responses
export type DispatchReviewResponse = {
  reviewId: string;
  attemptId?: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
};

export type CancelReviewResponse = {
  success: boolean;
  reviewId: string;
};

export type RetryReviewFreshResponse = {
  success: boolean;
  reviewId: string;
};

const DispatchReviewResponseSchema = z.object({
  reviewId: z.string(),
  attemptId: z.string().optional(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
});

const ReviewStatusResponseSchema = z.object({
  reviewId: z.string(),
  attemptId: z.string().optional(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
  sessionId: z.string().optional(),
  cliSessionId: z.string().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  model: z.string().optional(),
  totalTokensIn: z.number().optional(),
  totalTokensOut: z.number().optional(),
  totalCost: z.number().optional(),
  errorMessage: z.string().optional(),
  terminalReason: z.string().optional(),
});

export type ReviewStatusResponse = z.infer<typeof ReviewStatusResponseSchema>;

/**
 * Code Review Worker API Client
 * Handles all communication with the Cloudflare Worker for code reviews.
 *
 * `CODE_REVIEW_WORKER_SENDER_AUTH` (`service-sender-auth.ts`) picks the credential: `legacy` sends
 * `CODE_REVIEW_WORKER_AUTH_TOKEN` as the bearer, as before; `sts` (the Vercel production default)
 * sends only a `code-review` STS service token scoped to the route's action.
 */
class CodeReviewWorkerClient {
  private readonly baseUrl: string;
  private readonly sender: ServiceSenderAuth;

  constructor() {
    if (!CODE_REVIEW_WORKER_URL) {
      throw new Error('CODE_REVIEW_WORKER_URL or CODE_REVIEW_WORKER_AUTH_TOKEN not configured');
    }
    this.sender = resolveServiceSenderAuth({
      auth: CODE_REVIEW_WORKER_SENDER_AUTH,
      url: CODE_REVIEW_WORKER_URL,
      runtime: process.env,
    });
    if (this.sender.kind === 'legacy' && !CODE_REVIEW_WORKER_AUTH_TOKEN) {
      throw new Error('CODE_REVIEW_WORKER_URL or CODE_REVIEW_WORKER_AUTH_TOKEN not configured');
    }

    this.baseUrl = CODE_REVIEW_WORKER_URL;
  }

  /**
   * The headers of one request: its credential for `action` plus `additionalHeaders`. Throws
   * rather than send without a credential.
   */
  private async getHeaders(
    action: CodeReviewWorkerAction,
    additionalHeaders?: Record<string, string>
  ): Promise<Record<string, string>> {
    const credential = await serviceSenderHeaders({
      sender: this.sender,
      variable: 'CODE_REVIEW_WORKER_SENDER_AUTH',
      label: 'code review worker client',
      request: CODE_REVIEW_WORKER_SCOPES[action],
      legacyHeaders: async () => ({ Authorization: `Bearer ${CODE_REVIEW_WORKER_AUTH_TOKEN}` }),
    });
    return { ...credential, ...additionalHeaders };
  }

  /**
   * A request to the Worker. An STS token is for this origin only, so a redirect is an error rather
   * than a hop that would carry it elsewhere; the legacy credential keeps the default behaviour.
   */
  private fetchWorker(
    url: string,
    init: RequestInit & { headers: Record<string, string> }
  ): Promise<Response> {
    return fetchWithTimeout(
      url,
      this.sender.kind === 'sts' ? { ...init, redirect: 'error' } : init,
      FETCH_TIMEOUT_MS
    );
  }

  private buildReviewUrl(reviewId: string, suffix: string, attemptId?: string): string {
    const url = new URL(`${this.baseUrl}/reviews/${reviewId}/${suffix}`);
    if (attemptId) {
      url.searchParams.set('attemptId', attemptId);
    }
    return url.toString();
  }

  /**
   * Dispatch a code review to the worker
   * Creates a CodeReviewOrchestrator Durable Object and starts the review
   */
  async dispatchReview(payload: CodeReviewPayload): Promise<DispatchReviewResponse> {
    const response = await this.fetchWorker(`${this.baseUrl}/review`, {
      method: 'POST',
      headers: await this.getHeaders('dispatch', {
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Worker returned ${response.status}: ${errorText}`);
    }

    const data = DispatchReviewResponseSchema.parse(await response.json());
    if (data.status !== 'queued' && data.status !== 'running') {
      throw new Error(
        `Dispatch returned terminal status '${data.status}' for review ${data.reviewId}`
      );
    }
    return data;
  }

  /**
   * Cancel a running or queued code review
   * Signals the orchestrator to stop processing and marks the review as cancelled
   */
  async cancelReview(
    reviewId: string,
    reason?: string,
    attemptId?: string
  ): Promise<CancelReviewResponse> {
    const response = await this.fetchWorker(this.buildReviewUrl(reviewId, 'cancel', attemptId), {
      method: 'POST',
      headers: await this.getHeaders('cancel', {
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({ reason, attemptId }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Worker returned ${response.status}: ${errorText}`);
    }

    return response.json() as Promise<CancelReviewResponse>;
  }

  async retryReviewFresh(
    reviewId: string,
    input: {
      sessionId?: string;
      reason: string;
      failedAttemptId?: string;
      retryAttemptId?: string;
    }
  ): Promise<RetryReviewFreshResponse> {
    const response = await this.fetchWorker(`${this.baseUrl}/reviews/${reviewId}/retry-fresh`, {
      method: 'POST',
      headers: await this.getHeaders('retryFresh', {
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Worker returned ${response.status}: ${errorText}`);
    }

    return response.json() as Promise<RetryReviewFreshResponse>;
  }

  async getReviewStatus(
    reviewId: string,
    attemptId?: string
  ): Promise<ReviewStatusResponse | null> {
    const response = await this.fetchWorker(this.buildReviewUrl(reviewId, 'status', attemptId), {
      headers: await this.getHeaders('statusRead'),
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch review status: ${response.status} ${errorText}`);
    }

    return ReviewStatusResponseSchema.parse(await response.json());
  }
}

// Export a singleton instance
export const codeReviewWorkerClient = new CodeReviewWorkerClient();
