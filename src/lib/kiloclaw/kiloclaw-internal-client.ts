import 'server-only';

import { KILOCLAW_API_URL, KILOCLAW_INTERNAL_API_SECRET } from '@/lib/config.server';
import type {
  ProvisionInput,
  PlatformStatusResponse,
  KiloCodeConfigPatchInput,
  KiloCodeConfigResponse,
  ChannelsPatchInput,
  ChannelsPatchResponse,
  PairingListResponse,
  PairingApproveResponse,
  DevicePairingListResponse,
  DevicePairingApproveResponse,
  VolumeSnapshotsResponse,
  DoctorResponse,
  GatewayProcessStatusResponse,
  GatewayProcessActionResponse,
  ConfigRestoreResponse,
  ControllerVersionResponse,
} from './types';

/**
 * Error thrown when the KiloClaw API returns a non-OK response.
 * Preserves the HTTP status code for structured error handling
 * without leaking the raw response body.
 */
export class KiloClawApiError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number) {
    super(`KiloClaw API error (${statusCode})`);
    this.name = 'KiloClawApiError';
    this.statusCode = statusCode;
  }
}

/**
 * KiloClaw worker client for platform (internal) routes.
 * Uses x-internal-api-key auth. Server-only.
 */
export class KiloClawInternalClient {
  private baseUrl: string;
  private apiSecret: string;

  constructor() {
    if (!KILOCLAW_API_URL) {
      throw new Error('KILOCLAW_API_URL is not configured');
    }
    if (!KILOCLAW_INTERNAL_API_SECRET) {
      throw new Error('KILOCLAW_INTERNAL_API_SECRET is not configured');
    }
    this.baseUrl = KILOCLAW_API_URL;
    this.apiSecret = KILOCLAW_INTERNAL_API_SECRET;
  }

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        'x-internal-api-key': this.apiSecret,
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(
        `KiloClaw API error (${res.status}) ${options?.method ?? 'GET'} ${path}:`,
        body
      );
      throw new KiloClawApiError(res.status);
    }

    return res.json() as Promise<T>;
  }

  async provision(userId: string, config: ProvisionInput): Promise<{ sandboxId: string }> {
    return this.request('/api/platform/provision', {
      method: 'POST',
      body: JSON.stringify({ userId, ...config }),
    });
  }

  async start(userId: string): Promise<{ ok: true }> {
    return this.request('/api/platform/start', {
      method: 'POST',
      body: JSON.stringify({ userId }),
    });
  }

  async stop(userId: string): Promise<{ ok: true }> {
    return this.request('/api/platform/stop', {
      method: 'POST',
      body: JSON.stringify({ userId }),
    });
  }

  async destroy(userId: string): Promise<{ ok: true }> {
    return this.request('/api/platform/destroy', {
      method: 'POST',
      body: JSON.stringify({ userId }),
    });
  }

  async getStatus(userId: string): Promise<PlatformStatusResponse> {
    return this.request(`/api/platform/status?userId=${encodeURIComponent(userId)}`);
  }

  async getGatewayToken(userId: string): Promise<{ gatewayToken: string }> {
    return this.request(`/api/platform/gateway-token?userId=${encodeURIComponent(userId)}`);
  }

  async patchKiloCodeConfig(
    userId: string,
    patch: KiloCodeConfigPatchInput
  ): Promise<KiloCodeConfigResponse> {
    return this.request('/api/platform/kilocode-config', {
      method: 'PATCH',
      body: JSON.stringify({ userId, ...patch }),
    });
  }

  async patchChannels(userId: string, input: ChannelsPatchInput): Promise<ChannelsPatchResponse> {
    return this.request('/api/platform/channels', {
      method: 'PATCH',
      body: JSON.stringify({ userId, ...input }),
    });
  }

  async listVolumeSnapshots(userId: string): Promise<VolumeSnapshotsResponse> {
    return this.request(`/api/platform/volume-snapshots?userId=${encodeURIComponent(userId)}`);
  }

  async listPairingRequests(userId: string, refresh = false): Promise<PairingListResponse> {
    const params = new URLSearchParams({ userId });
    if (refresh) params.set('refresh', 'true');
    return this.request(`/api/platform/pairing?${params.toString()}`);
  }

  async approvePairingRequest(
    userId: string,
    channel: string,
    code: string
  ): Promise<PairingApproveResponse> {
    return this.request('/api/platform/pairing/approve', {
      method: 'POST',
      body: JSON.stringify({ userId, channel, code }),
    });
  }

  async listDevicePairingRequests(
    userId: string,
    refresh = false
  ): Promise<DevicePairingListResponse> {
    const params = new URLSearchParams({ userId });
    if (refresh) params.set('refresh', 'true');
    return this.request(`/api/platform/device-pairing?${params.toString()}`);
  }

  async approveDevicePairingRequest(
    userId: string,
    requestId: string
  ): Promise<DevicePairingApproveResponse> {
    return this.request('/api/platform/device-pairing/approve', {
      method: 'POST',
      body: JSON.stringify({ userId, requestId }),
    });
  }

  async runDoctor(userId: string): Promise<DoctorResponse> {
    return this.request('/api/platform/doctor', {
      method: 'POST',
      body: JSON.stringify({ userId }),
    });
  }

  async getGatewayStatus(userId: string): Promise<GatewayProcessStatusResponse> {
    return this.request(`/api/platform/gateway/status?userId=${encodeURIComponent(userId)}`);
  }

  async getControllerVersion(userId: string): Promise<ControllerVersionResponse> {
    return this.request(`/api/platform/controller-version?userId=${encodeURIComponent(userId)}`);
  }

  async startGateway(userId: string): Promise<GatewayProcessActionResponse> {
    return this.request('/api/platform/gateway/start', {
      method: 'POST',
      body: JSON.stringify({ userId }),
    });
  }

  async stopGateway(userId: string): Promise<GatewayProcessActionResponse> {
    return this.request('/api/platform/gateway/stop', {
      method: 'POST',
      body: JSON.stringify({ userId }),
    });
  }

  async restartGatewayProcess(userId: string): Promise<GatewayProcessActionResponse> {
    return this.request('/api/platform/gateway/restart', {
      method: 'POST',
      body: JSON.stringify({ userId }),
    });
  }

  async restoreConfig(userId: string, version = 'base'): Promise<ConfigRestoreResponse> {
    return this.request('/api/platform/config/restore', {
      method: 'POST',
      body: JSON.stringify({ userId, version }),
    });
  }
}
