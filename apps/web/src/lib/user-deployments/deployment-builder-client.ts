import 'server-only';

import {
  USER_DEPLOYMENTS_API_BASE_URL,
  USER_DEPLOYMENTS_API_AUTH_KEY,
} from '@kilocode/web-shared/lib/config.server';
import type { BuildStatus, CancelBuildResult } from '@/lib/user-deployments/types';
import { fetchWithTimeout } from '@/lib/user-deployments/fetch-utils';

// Types for API responses
export type BuilderEvent = {
  id: number;
  ts: string;
  message: string;
};

export type BuilderStatusResponse = {
  status: BuildStatus;
};

export type BuilderEventsResponse = {
  buildId: string;
  events: BuilderEvent[];
};

/**
 * API Client
 * Handles all communication with the deployment builder API
 */
class DeploymentBuilderClient {
  private readonly baseUrl: string;

  constructor() {
    this.baseUrl = USER_DEPLOYMENTS_API_BASE_URL;
  }
  /**
   * Get common headers for API requests
   */
  private getHeaders(additionalHeaders?: Record<string, string>): HeadersInit {
    return {
      Authorization: `Bearer ${USER_DEPLOYMENTS_API_AUTH_KEY}`,
      ...additionalHeaders,
    };
  }

  /**
   * Get the current status of a deployment
   */
  async getDeploymentStatus(deploymentId: string): Promise<BuildStatus> {
    const response = await fetchWithTimeout(`${this.baseUrl}/deploy/${deploymentId}/status`, {
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch deployment status: ${response.statusText}`);
    }

    const data: BuilderStatusResponse = await response.json();
    return data.status;
  }

  /**
   * Get events for a deployment
   */
  async getDeploymentEvents(deploymentId: string): Promise<BuilderEvent[]> {
    const response = await fetchWithTimeout(`${this.baseUrl}/deploy/${deploymentId}/events`, {
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch deployment events: ${response.statusText}`);
    }

    const data: BuilderEventsResponse = await response.json();
    return data.events;
  }

  /**
   * Cancel a running build
   */
  async cancelBuild(buildId: string): Promise<CancelBuildResult> {
    const response = await fetchWithTimeout(`${this.baseUrl}/deploy/${buildId}`, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to cancel build`);
    }

    const data: CancelBuildResult = await response.json();
    return data;
  }

  /**
   * Delete a worker deployment
   */
  async deleteWorker(slug: string): Promise<void> {
    const response = await fetchWithTimeout(`${this.baseUrl}/worker/${slug}`, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      if (response.status === 404) {
        // Worker already deleted, this is not an error
        return;
      }
      throw new Error(`Failed to delete worker: ${response.statusText}`);
    }
  }
}

// Export a singleton instance
export const apiClient = new DeploymentBuilderClient();
