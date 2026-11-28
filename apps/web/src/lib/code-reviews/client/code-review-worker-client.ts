import 'server-only';

import type { CodeReviewPayload } from '../triggers/prepare-review-payload';
import {
  CODE_REVIEW_WORKER_AUTH_TOKEN,
  CODE_REVIEW_WORKER_SENDER_AUTH,
} from '@kilocode/web-shared/lib/config.server';
import {
  resolveServiceSenderAuth,
  serviceSenderHeaders,
  type ServiceSenderAuth,
} from '@/lib/service-sender-auth';
import * as z from 'zod';

// One deadline per call, in milliseconds: the credential read (a cold STS mint included) and the
// request share it.
const FETCH_TIMEOUT_MS = 10000;
const CODE_REVIEW_WORKER_URL = process.env.CODE_REVIEW_WORKER_URL;

/** An STS token is for the Worker's origin only: a redirect fails rather than carry it on. */
const STS_REQUEST: RequestInit = { redirect: 'error' };

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
 * `CODE_REVIEW_WORKER_AUTH_TOKEN` as the bearer, as before (also when unset); explicit `sts`
 * sends only a `code-review` STS service token scoped to the route's action.
 */
class CodeReviewWorkerClient {
  private readonly baseUrl: string;
  private readonly sender: ServiceSenderAuth;

  constructor() {
    if (!CODE_REVIEW_WORKER_URL) {
      throw new Error('CODE_REVIEW_WORKER_URL not configured');
    }
    this.sender = resolveServiceSenderAuth({
      auth: CODE_REVIEW_WORKER_SENDER_AUTH,
      url: CODE_REVIEW_WORKER_URL,
      runtime: process.env,
    });
    if (this.sender.kind === 'legacy' && !CODE_REVIEW_WORKER_AUTH_TOKEN) {
      throw new Error('CODE_REVIEW_WORKER_AUTH_TOKEN not configured');
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
   * One call to the Worker under one `FETCH_TIMEOUT_MS` deadline that starts before the credential
   * read, so a cold STS mint and the request share it rather than add up. Past the deadline the
   * call fails with the same timeout error as before and the request, if sent, is aborted. An STS
   * token is for this origin only, so a redirect is an error rather than a hop that would carry it
   * elsewhere; the legacy credential keeps the default behaviour.
   */
  private async fetchWorker(
    url: string,
    action: CodeReviewWorkerAction,
    init: { method?: 'POST'; body?: string } = {}
  ): Promise<Response> {
    const controller = new AbortController();
    const deadline = Promise.withResolvers<never>();
    const timer = setTimeout(() => {
      deadline.reject(new Error(`Request timeout after ${FETCH_TIMEOUT_MS}ms`));
      controller.abort();
    }, FETCH_TIMEOUT_MS);
    try {
      const headers = await Promise.race([
        this.getHeaders(
          action,
          init.body === undefined ? undefined : { 'Content-Type': 'application/json' }
        ),
        deadline.promise,
      ]);
      return await Promise.race([
        fetch(url, {
          ...init,
          headers,
          signal: controller.signal,
          ...(this.sender.kind === 'sts' ? STS_REQUEST : {}),
        }),
        deadline.promise,
      ]);
    } finally {
      clearTimeout(timer);
    }
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
    const response = await this.fetchWorker(`${this.baseUrl}/review`, 'dispatch', {
      method: 'POST',
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
    const response = await this.fetchWorker(
      this.buildReviewUrl(reviewId, 'cancel', attemptId),
      'cancel',
      { method: 'POST', body: JSON.stringify({ reason, attemptId }) }
    );

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
    const response = await this.fetchWorker(
      `${this.baseUrl}/reviews/${reviewId}/retry-fresh`,
      'retryFresh',
      { method: 'POST', body: JSON.stringify(input) }
    );

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
    const response = await this.fetchWorker(
      this.buildReviewUrl(reviewId, 'status', attemptId),
      'statusRead'
    );

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
