import 'server-only';

import {
  USER_DEPLOYMENTS_DISPATCHER_URL,
  USER_DEPLOYMENTS_DISPATCHER_AUTH_KEY,
} from '@/lib/config.server';
import { fetchWithTimeout } from '@/lib/user-deployments/fetch-utils';

// Types for slug mapping API
export type GetSlugMappingResponse = { exists: true; workerName: string } | { exists: false };

export type SetSlugMappingResponse = {
  success: true;
};

export type DeleteSlugMappingResponse = {
  success: true;
};

/**
 * Slug Mappings API Client
 * Handles communication with the dispatcher worker for slug-to-worker mappings
 */
class SlugMappingsClient {
  private readonly baseUrl: string;

  constructor() {
    this.baseUrl = USER_DEPLOYMENTS_DISPATCHER_URL;
  }

  /**
   * Get common headers for API requests
   */
  private getHeaders(additionalHeaders?: Record<string, string>): HeadersInit {
    return {
      Authorization: `Bearer ${USER_DEPLOYMENTS_DISPATCHER_AUTH_KEY}`,
      ...additionalHeaders,
    };
  }

  /**
   * Get the slug mapping for a given slug
   */
  async getSlugMapping(slug: string): Promise<GetSlugMappingResponse> {
    const response = await fetchWithTimeout(
      `${this.baseUrl}/api/slug-mapping/${slug}`,
      { headers: this.getHeaders() },
      { maxRetries: 0 }
    );

    if (!response.ok) {
      throw new Error(`Failed to get slug mapping: ${response.statusText}`);
    }

    return (await response.json()) as GetSlugMappingResponse;
  }

  /**
   * Set a slug mapping (maps public slug to internal worker name)
   */
  async setSlugMapping(slug: string, workerName: string): Promise<SetSlugMappingResponse> {
    const response = await fetchWithTimeout(
      `${this.baseUrl}/api/slug-mapping/${slug}`,
      {
        method: 'PUT',
        headers: this.getHeaders({
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ workerName }),
      },
      { maxRetries: 0 }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to set slug mapping: ${errorText}`);
    }

    return (await response.json()) as SetSlugMappingResponse;
  }

  /**
   * Delete a slug mapping
   */
  async deleteSlugMapping(slug: string): Promise<DeleteSlugMappingResponse> {
    const response = await fetchWithTimeout(
      `${this.baseUrl}/api/slug-mapping/${slug}`,
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

// Export a singleton instance
export const slugMappingsClient = new SlugMappingsClient();
