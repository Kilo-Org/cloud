import 'server-only';

import {
  USER_DEPLOYMENTS_DISPATCHER_URL,
  USER_DEPLOYMENTS_DISPATCHER_AUTH_KEY,
} from '@/lib/config.server';
import { fetchWithTimeout } from '@/lib/user-deployments/fetch-utils';

// Password protection types
export type GetPasswordStatusResponse =
  | { protected: true; passwordSetAt: number }
  | { protected: false };

export type SetPasswordResponse = {
  success: true;
  passwordSetAt: number;
};

export type DeletePasswordResponse = {
  success: true;
};

// Slug mapping types
export type SetSlugMappingResponse = {
  success: true;
};

export type DeleteSlugMappingResponse = {
  success: true;
};

/**
 * Client for the deploy dispatcher worker API.
 * Handles password protection and slug-to-worker mappings.
 */
class DispatcherClient {
  private readonly baseUrl: string;

  constructor() {
    this.baseUrl = USER_DEPLOYMENTS_DISPATCHER_URL;
  }

  private getHeaders(additionalHeaders?: Record<string, string>): HeadersInit {
    return {
      Authorization: `Bearer ${USER_DEPLOYMENTS_DISPATCHER_AUTH_KEY}`,
      ...additionalHeaders,
    };
  }

  // ---- Password protection ----

  async getPasswordStatus(workerSlug: string): Promise<GetPasswordStatusResponse> {
    const response = await fetchWithTimeout(
      `${this.baseUrl}/api/password/${workerSlug}`,
      { headers: this.getHeaders() },
      { maxRetries: 0 }
    );

    if (!response.ok) {
      throw new Error(`Failed to get password status: ${response.statusText}`);
    }

    return (await response.json()) as GetPasswordStatusResponse;
  }

  async setPassword(workerSlug: string, password: string): Promise<SetPasswordResponse> {
    const response = await fetchWithTimeout(
      `${this.baseUrl}/api/password/${workerSlug}`,
      {
        method: 'PUT',
        headers: this.getHeaders({
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ password }),
      },
      { maxRetries: 0 }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to set password: ${errorText}`);
    }

    return (await response.json()) as SetPasswordResponse;
  }

  async removePassword(workerSlug: string): Promise<DeletePasswordResponse> {
    const response = await fetchWithTimeout(
      `${this.baseUrl}/api/password/${workerSlug}`,
      {
        method: 'DELETE',
        headers: this.getHeaders(),
      },
      { maxRetries: 0 }
    );

    if (!response.ok) {
      throw new Error(`Failed to remove password: ${response.statusText}`);
    }

    return (await response.json()) as DeletePasswordResponse;
  }

  // ---- Slug mappings ----

  async setSlugMapping(workerName: string, slug: string): Promise<SetSlugMappingResponse> {
    const response = await fetchWithTimeout(
      `${this.baseUrl}/api/slug-mapping/${workerName}`,
      {
        method: 'PUT',
        headers: this.getHeaders({
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ slug }),
      },
      { maxRetries: 0 }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to set slug mapping: ${errorText}`);
    }

    return (await response.json()) as SetSlugMappingResponse;
  }

  async deleteSlugMapping(workerName: string): Promise<DeleteSlugMappingResponse> {
    const response = await fetchWithTimeout(
      `${this.baseUrl}/api/slug-mapping/${workerName}`,
      {
        method: 'DELETE',
        headers: this.getHeaders(),
      },
      { maxRetries: 0 }
    );

    if (!response.ok) {
      throw new Error(`Failed to delete slug mapping: ${response.statusText}`);
    }

    return (await response.json()) as DeleteSlugMappingResponse;
  }
}

export const dispatcherClient = new DispatcherClient();
