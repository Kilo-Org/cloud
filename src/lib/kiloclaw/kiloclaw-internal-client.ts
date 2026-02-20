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
  VolumeSnapshotsResponse,
  DoctorResponse,
} from './types';

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
      throw new Error(`KiloClaw API error (${res.status}): ${body}`);
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

  async runDoctor(userId: string): Promise<DoctorResponse> {
    return this.request('/api/platform/doctor', {
      method: 'POST',
      body: JSON.stringify({ userId }),
    });
  }
}
