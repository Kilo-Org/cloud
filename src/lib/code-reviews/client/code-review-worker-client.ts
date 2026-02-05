import 'server-only';

import type { CodeReviewPayload } from '../triggers/prepare-review-payload';
import { CODE_REVIEW_WORKER_AUTH_TOKEN } from '@/lib/config.server';

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
export interface DispatchReviewResponse {
  success: boolean;
  reviewId: string;
}

/**
 * Code review event structure
 * Matches the CodeReviewEvent type from Cloudflare Worker
 */
export interface ReviewEvent {
  timestamp: string;
  eventType: string;
  message?: string;
  content?: string;
  sessionId?: string;
}

export interface ReviewEventsResponse {
  reviewId: string;
  events: ReviewEvent[];
}

export interface CancelReviewResponse {
  success: boolean;
  reviewId: string;
}

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

    const data: DispatchReviewResponse = await response.json();
    return data;
  }

  /**
   * Get events for a code review (for streaming)
   */
  async getReviewEvents(reviewId: string): Promise<ReviewEvent[]> {
    const response = await fetchWithTimeout(`${this.baseUrl}/reviews/${reviewId}/events`, {
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
  async cancelReview(reviewId: string, reason?: string): Promise<CancelReviewResponse> {
    const response = await fetchWithTimeout(`${this.baseUrl}/reviews/${reviewId}/cancel`, {
      method: 'POST',
      headers: this.getHeaders({
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({ reason }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Worker returned ${response.status}: ${errorText}`);
    }

    return response.json() as Promise<CancelReviewResponse>;
  }
}

// Export a singleton instance
export const codeReviewWorkerClient = new CodeReviewWorkerClient();
