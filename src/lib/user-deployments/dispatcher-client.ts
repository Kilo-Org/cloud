import 'server-only';

import { z } from 'zod';
import {
  USER_DEPLOYMENTS_DISPATCHER_URL,
  USER_DEPLOYMENTS_DISPATCHER_AUTH_KEY,
} from '@/lib/config.server';
import { fetchWithTimeout } from '@/lib/user-deployments/fetch-utils';

// Password protection schemas
const getPasswordStatusResponseSchema = z.discriminatedUnion('protected', [
  z.object({ protected: z.literal(true), passwordSetAt: z.number() }),
  z.object({ protected: z.literal(false) }),
]);

const setPasswordResponseSchema = z.object({
  success: z.literal(true),
  passwordSetAt: z.number(),
});

const deletePasswordResponseSchema = z.object({
  success: z.literal(true),
});

// Slug mapping schemas
const setSlugMappingResponseSchema = z.object({
  success: z.literal(true),
});

const deleteSlugMappingResponseSchema = z.object({
  success: z.literal(true),
});

// Banner schemas
const getBannerStatusResponseSchema = z.object({
  enabled: z.boolean(),
});

const setBannerResponseSchema = z.object({
  success: z.literal(true),
});

const deleteBannerResponseSchema = z.object({
  success: z.literal(true),
});

// Exported types inferred from schemas
export type GetPasswordStatusResponse = z.infer<typeof getPasswordStatusResponseSchema>;
export type SetPasswordResponse = z.infer<typeof setPasswordResponseSchema>;
export type DeletePasswordResponse = z.infer<typeof deletePasswordResponseSchema>;
export type SetSlugMappingResponse = z.infer<typeof setSlugMappingResponseSchema>;
export type DeleteSlugMappingResponse = z.infer<typeof deleteSlugMappingResponseSchema>;
export type GetBannerStatusResponse = z.infer<typeof getBannerStatusResponseSchema>;
export type SetBannerResponse = z.infer<typeof setBannerResponseSchema>;
export type DeleteBannerResponse = z.infer<typeof deleteBannerResponseSchema>;

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

    return deletePasswordResponseSchema.parse(await response.json());
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

    return setSlugMappingResponseSchema.parse(await response.json());
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

    return deleteSlugMappingResponseSchema.parse(await response.json());
  }

  // ---- Banner ----

  async getBannerStatus(workerName: string): Promise<GetBannerStatusResponse> {
    const response = await fetchWithTimeout(
      `${this.baseUrl}/api/app-builder-banner/${workerName}`,
      { headers: this.getHeaders() },
      { maxRetries: 0 }
    );

    if (!response.ok) {
      throw new Error(`Failed to get banner status: ${response.statusText}`);
    }

    return getBannerStatusResponseSchema.parse(await response.json());
  }

  async setBanner(workerName: string, enabled: boolean): Promise<SetBannerResponse> {
    const response = await fetchWithTimeout(
      `${this.baseUrl}/api/app-builder-banner/${workerName}`,
      {
        method: 'PUT',
        headers: this.getHeaders({
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ enabled }),
      },
      { maxRetries: 0 }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to set banner: ${errorText}`);
    }

    return setBannerResponseSchema.parse(await response.json());
  }

  async removeBanner(workerName: string): Promise<DeleteBannerResponse> {
    const response = await fetchWithTimeout(
      `${this.baseUrl}/api/app-builder-banner/${workerName}`,
      {
        method: 'DELETE',
        headers: this.getHeaders(),
      },
      { maxRetries: 0 }
    );

    if (!response.ok) {
      throw new Error(`Failed to remove banner: ${response.statusText}`);
    }

    return deleteBannerResponseSchema.parse(await response.json());
  }
}

export const dispatcherClient = new DispatcherClient();
