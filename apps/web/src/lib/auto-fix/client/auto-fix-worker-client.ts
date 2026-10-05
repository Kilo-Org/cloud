import 'server-only';

import type { DispatchFixRequest } from '../core/schemas';
import { fetchWithTimeout } from '@/lib/fetch-with-timeout';

const AUTO_FIX_URL = process.env.AUTO_FIX_URL;
const AUTO_FIX_AUTH_TOKEN = process.env.AUTO_FIX_AUTH_TOKEN;

const FETCH_TIMEOUT_MS = 30_000;

export interface DispatchFixResponse {
  success: boolean;
  ticketId: string;
  status: string;
}

class AutoFixWorkerClient {
  private readonly baseUrl: string;
  private readonly authToken: string;

  constructor() {
    if (!AUTO_FIX_URL || !AUTO_FIX_AUTH_TOKEN) {
      throw new Error('AUTO_FIX_URL or AUTO_FIX_AUTH_TOKEN not configured');
    }

    this.baseUrl = AUTO_FIX_URL;
    this.authToken = AUTO_FIX_AUTH_TOKEN;
  }

  private getHeaders(additionalHeaders?: Record<string, string>): HeadersInit {
    return {
      Authorization: `Bearer ${this.authToken}`,
      ...additionalHeaders,
    };
  }

  /**
   * Creates an AutoFixOrchestrator Durable Object and starts the fix
   */
  async dispatchFix(payload: DispatchFixRequest): Promise<DispatchFixResponse> {
    const response = await fetchWithTimeout(
      `${this.baseUrl}/fix/dispatch`,
      {
        method: 'POST',
        headers: this.getHeaders({
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify(payload),
      },
      FETCH_TIMEOUT_MS
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Worker returned ${response.status}: ${errorText}`);
    }

    const data: DispatchFixResponse = await response.json();
    return data;
  }
}

export const autoFixWorkerClient = new AutoFixWorkerClient();
