import 'server-only';

import type { CodeReviewPayload } from '../triggers/prepare-review-payload';
import { CODE_REVIEW_WORKER_AUTH_TOKEN } from '@/lib/config.server';
import * as z from 'zod';

// Fetch timeout in milliseconds
const FETCH_TIMEOUT_MS = 10000;
const CODE_REVIEW_WORKER_URL = process.env.CODE_REVIEW_WORKER_URL;

/**
 * Fetch with timeout support
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = FETCH_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeoutMs}ms`);
    }
    throw error;
  }
}

// Types for API responses
export type DispatchReviewResponse = {
  reviewId: string;
  attemptId?: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
};

/**
 * Code review event structure (used by SSE/cloud-agent flow)
 * Matches the CodeReviewEvent type from Cloudflare Worker
 */
export type ReviewEvent = {
  timestamp: string;
  eventType: string;
  message?: string;
  content?: string;
  sessionId?: string;
};

export type ReviewEventsResponse = {
  reviewId: string;
  events: ReviewEvent[];
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
 * Handles all communication with the Cloudflare Worker for code reviews
 */
class CodeReviewWorkerClient {
  private readonly baseUrl: string;
  private readonly authToken: string;

  constructor() {
    if (!CODE_REVIEW_WORKER_URL || !CODE_REVIEW_WORKER_AUTH_TOKEN) {
      throw new Error('CODE_REVIEW_WORKER_URL or CODE_REVIEW_WORKER_AUTH_TOKEN not configured');
    }

    this.baseUrl = CODE_REVIEW_WORKER_URL;
    this.authToken = CODE_REVIEW_WORKER_AUTH_TOKEN;
  }

  /**
   * Get common headers for API requests
   */
  private getHeaders(additionalHeaders?: Record<string, string>): HeadersInit {
    return {
      Authorization: `Bearer ${this.authToken}`,
      ...additionalHeaders,
    };
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
    const response = await fetchWithTimeout(`${this.baseUrl}/review`, {
      method: 'POST',
      headers: this.getHeaders({
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
   * Get events for a code review (used by SSE/cloud-agent flow for polling)
   */
  async getReviewEvents(reviewId: string, attemptId?: string): Promise<ReviewEvent[]> {
    const response = await fetchWithTimeout(this.buildReviewUrl(reviewId, 'events', attemptId), {
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch review events: ${response.statusText}`);
    }

    const data: ReviewEventsResponse = await response.json();
    return data.events;
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
    const response = await fetchWithTimeout(this.buildReviewUrl(reviewId, 'cancel', attemptId), {
      method: 'POST',
      headers: this.getHeaders({
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
    const response = await fetchWithTimeout(`${this.baseUrl}/reviews/${reviewId}/retry-fresh`, {
      method: 'POST',
      headers: this.getHeaders({
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
    const response = await fetchWithTimeout(this.buildReviewUrl(reviewId, 'status', attemptId), {
      headers: this.getHeaders(),
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
