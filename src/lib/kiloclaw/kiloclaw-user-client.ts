import 'server-only';

import { KILOCLAW_API_URL } from '@/lib/config.server';
import { KiloClawApiError } from './kiloclaw-internal-client';
import type {
  UserConfigResponse,
  PlatformStatusResponse,
  RestartMachineResponse,
  ChatCredentials,
} from './types';

type RequestContext = { userId: string };

/**
 * KiloClaw worker client for user-facing routes.
 * Uses Bearer JWT auth (forwarding the user's token). Server-only.
 */
export class KiloClawUserClient {
  private authToken: string;
  private baseUrl: string;

  constructor(authToken: string) {
    if (!KILOCLAW_API_URL) {
      throw new Error('KILOCLAW_API_URL is not configured');
    }
    this.authToken = authToken;
    this.baseUrl = KILOCLAW_API_URL;
  }

  private async request<T>(path: string, options?: RequestInit, ctx?: RequestContext): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.authToken}`,
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(
        `KiloClaw API error (${res.status}) ${options?.method ?? 'GET'} ${path}:`,
        body,
        ...(ctx ? [`userId=${ctx.userId}`] : [])
      );
      throw new KiloClawApiError(res.status);
    }

    return res.json() as Promise<T>;
  }

  async getConfig(ctx?: RequestContext): Promise<UserConfigResponse> {
    return this.request('/api/kiloclaw/config', undefined, ctx);
  }

  async getStatus(ctx?: RequestContext): Promise<PlatformStatusResponse> {
    return this.request('/api/kiloclaw/status', undefined, ctx);
  }

  async getChatCredentials(ctx?: RequestContext): Promise<ChatCredentials> {
    return this.request('/api/kiloclaw/chat-credentials', undefined, ctx);
  }

  async restartMachine(
    options?: { imageTag?: string },
    ctx?: RequestContext
  ): Promise<RestartMachineResponse> {
    return this.request(
      '/api/admin/machine/restart',
      {
        method: 'POST',
        body: options?.imageTag ? JSON.stringify({ imageTag: options.imageTag }) : undefined,
      },
      ctx
    );
  }
}
