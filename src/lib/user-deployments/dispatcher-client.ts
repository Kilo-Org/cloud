import 'server-only';

import { z } from 'zod';
import {
  USER_DEPLOYMENTS_DISPATCHER_URL,
  USER_DEPLOYMENTS_DISPATCHER_AUTH_KEY,
} from '@/lib/config.server';
import { fetchWithTimeout } from '@/lib/user-deployments/fetch-utils';

const successResponseSchema = z.object({ success: z.literal(true) });

const getPasswordStatusResponseSchema = z.discriminatedUnion('protected', [
  z.object({ protected: z.literal(true), passwordSetAt: z.number() }),
  z.object({ protected: z.literal(false) }),
]);

const setPasswordResponseSchema = z.object({
  success: z.literal(true),
  passwordSetAt: z.number(),
});

export type GetPasswordStatusResponse = z.infer<typeof getPasswordStatusResponseSchema>;
export type SetPasswordResponse = z.infer<typeof setPasswordResponseSchema>;

/**
 * Client for the deploy dispatcher worker API.
 * Handles password protection, slug-to-worker mappings, and banner management.
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

    return getPasswordStatusResponseSchema.parse(await response.json());
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

    return setPasswordResponseSchema.parse(await response.json());
  }

  async removePassword(workerSlug: string) {
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

    return successResponseSchema.parse(await response.json());
  }

  // ---- Slug mappings ----

  async setSlugMapping(workerName: string, slug: string) {
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

    return successResponseSchema.parse(await response.json());
  }

  async deleteSlugMapping(workerName: string) {
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

    return successResponseSchema.parse(await response.json());
  }

  // ---- Banner ----

  async enableBanner(workerName: string) {
    const response = await fetchWithTimeout(
      `${this.baseUrl}/api/app-builder-banner/${workerName}`,
      {
        method: 'PUT',
        headers: this.getHeaders(),
      },
      { maxRetries: 0 }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to enable banner: ${errorText}`);
    }

    return successResponseSchema.parse(await response.json());
  }

  async disableBanner(workerName: string) {
    const response = await fetchWithTimeout(
      `${this.baseUrl}/api/app-builder-banner/${workerName}`,
      {
        method: 'DELETE',
        headers: this.getHeaders(),
      },
      { maxRetries: 0 }
    );

    if (!response.ok) {
      throw new Error(`Failed to disable banner: ${response.statusText}`);
    }

    return successResponseSchema.parse(await response.json());
  }
}

export const dispatcherClient = new DispatcherClient();
