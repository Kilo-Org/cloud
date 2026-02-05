import 'server-only';

import type { DispatchTriageRequest } from '../core/schemas';
import { AUTO_TRIAGE_CONSTANTS } from '../core/constants';

const AUTO_TRIAGE_URL = process.env.AUTO_TRIAGE_URL;
const AUTO_TRIAGE_AUTH_TOKEN = process.env.AUTO_TRIAGE_AUTH_TOKEN;

/**
 * Fetch with timeout support
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = AUTO_TRIAGE_CONSTANTS.WORKER_FETCH_TIMEOUT
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
export interface DispatchTriageResponse {
  success: boolean;
  ticketId: string;
  status: string;
}

/**
 * Auto Triage Worker API Client
 * Handles all communication with the Cloudflare Worker for auto triage
 */
class TriageWorkerClient {
  private readonly baseUrl: string;
  private readonly authToken: string;

  constructor() {
    if (!AUTO_TRIAGE_URL || !AUTO_TRIAGE_AUTH_TOKEN) {
      throw new Error('AUTO_TRIAGE_URL or AUTO_TRIAGE_AUTH_TOKEN not configured');
    }

    this.baseUrl = AUTO_TRIAGE_URL;
    this.authToken = AUTO_TRIAGE_AUTH_TOKEN;
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
   * Dispatch a triage ticket to the worker
   * Creates a TriageOrchestrator Durable Object and starts the triage
   */
  async dispatchTriage(payload: DispatchTriageRequest): Promise<DispatchTriageResponse> {
    const response = await fetchWithTimeout(`${this.baseUrl}/triage`, {
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

    const data: DispatchTriageResponse = await response.json();
    return data;
  }
}

// Export a singleton instance
export const triageWorkerClient = new TriageWorkerClient();
