import 'server-only';

import { KILOCLAW_API_URL } from '@/lib/config.server';
import { KiloClawApiError } from './kiloclaw-internal-client';
import type { UserConfigResponse, PlatformStatusResponse, RestartMachineResponse } from './types';

type RequestContext = { userId: string; instanceId?: string };

type SerializedKiloClawErrorBody = {
  success?: false;
  error?: string;
  code?: string;
};

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function serializeSafeKiloClawErrorResponseBody(responseBody: string): string {
  try {
    const parsed: unknown = JSON.parse(responseBody);
    if (typeof parsed !== 'object' || parsed === null) return '';

    const error = readNonEmptyString('error' in parsed ? parsed.error : undefined);
    const code = readNonEmptyString('code' in parsed ? parsed.code : undefined);

    if (!error && !code) return '';

    const serialized: SerializedKiloClawErrorBody = {};
    if ('success' in parsed && parsed.success === false) serialized.success = false;
    if (error) serialized.error = error;
    if (code) serialized.code = code;

    return JSON.stringify(serialized);
  } catch {
    return '';
  }
}

/**
 * KiloClaw worker client for user-facing routes.
 * Uses Bearer JWT auth (forwarding the user's token). Server-only.
 *
 * When `instanceId` is provided in RequestContext, it is appended as a
 * query parameter so the worker resolves the correct DO (instance-keyed
 * vs legacy userId-keyed).
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
    const url = ctx?.instanceId
      ? `${this.baseUrl}${path}?instanceId=${encodeURIComponent(ctx.instanceId)}`
      : `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.authToken}`,
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });

    if (!res.ok) {
      const responseBody = serializeSafeKiloClawErrorResponseBody(await res.text());
      console.error(
        `KiloClaw API error (${res.status}) ${options?.method ?? 'GET'} ${path}:`,
        responseBody,
        ...(ctx ? [`userId=${ctx.userId}`] : [])
      );
      throw new KiloClawApiError(res.status, responseBody);
    }

    return res.json() as Promise<T>;
  }

  async getConfig(ctx?: RequestContext): Promise<UserConfigResponse> {
    return this.request('/api/kiloclaw/config', undefined, ctx);
  }

  async getStatus(ctx?: RequestContext): Promise<PlatformStatusResponse> {
    return this.request('/api/kiloclaw/status', undefined, ctx);
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
