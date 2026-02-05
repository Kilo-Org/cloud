import 'server-only';

import type { DispatchFixRequest } from '../core/schemas';

const AUTO_FIX_URL = process.env.AUTO_FIX_URL;
const AUTO_FIX_AUTH_TOKEN = process.env.AUTO_FIX_AUTH_TOKEN;

/**
 * Fetch with timeout support
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = 30000 // 30 second default timeout
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
export interface DispatchFixResponse {
  success: boolean;
  ticketId: string;
  status: string;
}

/**
 * Auto Fix Worker API Client
 * Handles all communication with the Cloudflare Worker for auto fix
 */
class AutoFixWorkerClient {
  private _baseUrl: string | null = null;
  private _authToken: string | null = null;

  private get baseUrl(): string {
    if (!this._baseUrl) {
      if (!AUTO_FIX_URL) {
        throw new Error('AUTO_FIX_URL not configured');
      }
      this._baseUrl = AUTO_FIX_URL;
    }
    return this._baseUrl;
  }

  private get authToken(): string {
    if (!this._authToken) {
      if (!AUTO_FIX_AUTH_TOKEN) {
        throw new Error('AUTO_FIX_AUTH_TOKEN not configured');
      }
      this._authToken = AUTO_FIX_AUTH_TOKEN;
    }
    return this._authToken;
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
   * Dispatch a fix ticket to the worker
   * Creates an AutoFixOrchestrator Durable Object and starts the fix
   */
  async dispatchFix(payload: DispatchFixRequest): Promise<DispatchFixResponse> {
    const response = await fetchWithTimeout(`${this.baseUrl}/fix/dispatch`, {
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

    const data: DispatchFixResponse = await response.json();
    return data;
  }
}

// Export a singleton instance
export const autoFixWorkerClient = new AutoFixWorkerClient();
