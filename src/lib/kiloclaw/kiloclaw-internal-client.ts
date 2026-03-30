import 'server-only';

import { KILOCLAW_API_URL, KILOCLAW_INTERNAL_API_SECRET } from '@/lib/config.server';
import type {
  ImageVersionEntry,
  ProvisionInput,
  PlatformStatusResponse,
  PlatformDebugStatusResponse,
  KiloCodeConfigPatchInput,
  KiloCodeConfigResponse,
  ChannelsPatchInput,
  ChannelsPatchResponse,
  SecretsPatchInput,
  SecretsPatchResponse,
  PairingListResponse,
  PairingApproveResponse,
  DevicePairingListResponse,
  DevicePairingApproveResponse,
  VolumeSnapshotsResponse,
  DoctorResponse,
  KiloCliRunStartResponse,
  KiloCliRunStatusResponse,
  GatewayProcessStatusResponse,
  GatewayProcessActionResponse,
  ConfigRestoreResponse,
  GatewayReadyResponse,
  ControllerVersionResponse,
  OpenclawConfigResponse,
  GoogleCredentialsInput,
  GoogleCredentialsResponse,
  GmailNotificationsResponse,
  CandidateVolumesResponse,
  ReassociateVolumeResponse,
  RestoreVolumeSnapshotResponse,
  RegionsResponse,
  UpdateRegionsResponse,
} from './types';

/** Keep in sync with: kiloclaw/controller/src/routes/files.ts, kiloclaw/src/.../gateway.ts (Zod) */
export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
}

/**
 * Error thrown when the KiloClaw API returns a non-OK response.
 * Preserves the HTTP status code and response body for structured
 * error handling upstream.
 */
export class KiloClawApiError extends Error {
  readonly statusCode: number;
  readonly responseBody: string;

  constructor(statusCode: number, responseBody = '') {
    super(`KiloClaw API error (${statusCode})`);
    this.name = 'KiloClawApiError';
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

type RequestContext = { userId: string };

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

  private async request<T>(path: string, options?: RequestInit, ctx?: RequestContext): Promise<T> {
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
        body,
        ...(ctx ? [`userId=${ctx.userId}`] : [])
      );
      throw new KiloClawApiError(res.status, body);
    }

    return res.json() as Promise<T>;
  }

  async listVersions(): Promise<ImageVersionEntry[]> {
    return this.request('/api/platform/versions');
  }

  async getLatestVersion(): Promise<ImageVersionEntry | null> {
    try {
      return await this.request('/api/platform/versions/latest');
    } catch (err) {
      // Only return null for 404 (no latest version set)
      // Re-throw other errors (network, auth, server errors) so callers can handle them
      if (err instanceof KiloClawApiError && err.statusCode === 404) {
        return null;
      }
      throw err;
    }
  }

  async provision(
    userId: string,
    config: ProvisionInput,
    opts?: { instanceId?: string; orgId?: string }
  ): Promise<{ sandboxId: string }> {
    return this.request(
      '/api/platform/provision',
      {
        method: 'POST',
        body: JSON.stringify({ userId, ...config, ...opts }),
      },
      { userId }
    );
  }

  async start(
    userId: string,
    instanceId?: string,
    options?: { skipCooldown?: boolean }
  ): Promise<{ ok: true }> {
    const params = instanceId ? `?instanceId=${encodeURIComponent(instanceId)}` : '';
    return this.request(
      `/api/platform/start${params}`,
      {
        method: 'POST',
        body: JSON.stringify({ userId, ...options }),
      },
      { userId }
    );
  }

  async stop(userId: string, instanceId?: string): Promise<{ ok: true }> {
    const params = instanceId ? `?instanceId=${encodeURIComponent(instanceId)}` : '';
    return this.request(
      `/api/platform/stop${params}`,
      {
        method: 'POST',
        body: JSON.stringify({ userId }),
      },
      { userId }
    );
  }

  async destroy(userId: string, instanceId?: string): Promise<{ ok: true }> {
    const params = instanceId ? `?instanceId=${encodeURIComponent(instanceId)}` : '';
    return this.request(
      `/api/platform/destroy${params}`,
      {
        method: 'POST',
        body: JSON.stringify({ userId }),
      },
      { userId }
    );
  }

  async getStatus(userId: string, instanceId?: string): Promise<PlatformStatusResponse> {
    const params = new URLSearchParams({ userId });
    if (instanceId) params.set('instanceId', instanceId);
    return this.request(`/api/platform/status?${params.toString()}`, undefined, {
      userId,
    });
  }

  async getStreamChatCredentials(
    userId: string,
    instanceId?: string
  ): Promise<{
    apiKey: string;
    userId: string;
    userToken: string;
    channelId: string;
  } | null> {
    const params = new URLSearchParams({ userId });
    if (instanceId) params.set('instanceId', instanceId);
    return this.request(`/api/platform/stream-chat-credentials?${params.toString()}`, undefined, {
      userId,
    });
  }

  async getDebugStatus(userId: string, instanceId?: string): Promise<PlatformDebugStatusResponse> {
    const params = new URLSearchParams({ userId });
    if (instanceId) params.set('instanceId', instanceId);
    return this.request(`/api/platform/debug-status?${params.toString()}`, undefined, { userId });
  }

  async patchKiloCodeConfig(
    userId: string,
    patch: KiloCodeConfigPatchInput
  ): Promise<KiloCodeConfigResponse> {
    return this.request(
      '/api/platform/kilocode-config',
      {
        method: 'PATCH',
        body: JSON.stringify({ userId, ...patch }),
      },
      { userId }
    );
  }

  async patchChannels(userId: string, input: ChannelsPatchInput): Promise<ChannelsPatchResponse> {
    return this.request(
      '/api/platform/channels',
      {
        method: 'PATCH',
        body: JSON.stringify({ userId, ...input }),
      },
      { userId }
    );
  }

  async patchExecPreset(
    userId: string,
    patch: { security?: string; ask?: string }
  ): Promise<{ execSecurity: string | null; execAsk: string | null }> {
    return this.request(
      '/api/platform/exec-preset',
      {
        method: 'PATCH',
        body: JSON.stringify({ userId, ...patch }),
      },
      { userId }
    );
  }

  async patchSecrets(userId: string, input: SecretsPatchInput): Promise<SecretsPatchResponse> {
    return this.request(
      '/api/platform/secrets',
      {
        method: 'PATCH',
        body: JSON.stringify({ userId, ...input }),
      },
      { userId }
    );
  }

  async listVolumeSnapshots(userId: string): Promise<VolumeSnapshotsResponse> {
    return this.request(
      `/api/platform/volume-snapshots?userId=${encodeURIComponent(userId)}`,
      undefined,
      { userId }
    );
  }

  async listPairingRequests(userId: string, refresh = false): Promise<PairingListResponse> {
    const params = new URLSearchParams({ userId });
    if (refresh) params.set('refresh', 'true');
    return this.request(`/api/platform/pairing?${params.toString()}`, undefined, { userId });
  }

  async approvePairingRequest(
    userId: string,
    channel: string,
    code: string
  ): Promise<PairingApproveResponse> {
    return this.request(
      '/api/platform/pairing/approve',
      {
        method: 'POST',
        body: JSON.stringify({ userId, channel, code }),
      },
      { userId }
    );
  }

  async listDevicePairingRequests(
    userId: string,
    refresh = false
  ): Promise<DevicePairingListResponse> {
    const params = new URLSearchParams({ userId });
    if (refresh) params.set('refresh', 'true');
    return this.request(`/api/platform/device-pairing?${params.toString()}`, undefined, { userId });
  }

  async approveDevicePairingRequest(
    userId: string,
    requestId: string
  ): Promise<DevicePairingApproveResponse> {
    return this.request(
      '/api/platform/device-pairing/approve',
      {
        method: 'POST',
        body: JSON.stringify({ userId, requestId }),
      },
      { userId }
    );
  }

  async runDoctor(userId: string): Promise<DoctorResponse> {
    return this.request(
      '/api/platform/doctor',
      {
        method: 'POST',
        body: JSON.stringify({ userId }),
      },
      { userId }
    );
  }

  async startKiloCliRun(userId: string, prompt: string): Promise<KiloCliRunStartResponse> {
    return this.request(
      '/api/platform/kilo-cli-run/start',
      {
        method: 'POST',
        body: JSON.stringify({ userId, prompt }),
      },
      { userId }
    );
  }

  async getKiloCliRunStatus(userId: string): Promise<KiloCliRunStatusResponse> {
    return this.request(
      `/api/platform/kilo-cli-run/status?userId=${encodeURIComponent(userId)}`,
      undefined,
      { userId }
    );
  }

  async cancelKiloCliRun(userId: string): Promise<{ ok: boolean }> {
    return this.request(
      '/api/platform/kilo-cli-run/cancel',
      {
        method: 'POST',
        body: JSON.stringify({ userId }),
      },
      { userId }
    );
  }

  async getGatewayStatus(userId: string): Promise<GatewayProcessStatusResponse> {
    return this.request(
      `/api/platform/gateway/status?userId=${encodeURIComponent(userId)}`,
      undefined,
      { userId }
    );
  }

  async getGatewayReady(userId: string): Promise<GatewayReadyResponse> {
    return this.request(
      `/api/platform/gateway/ready?userId=${encodeURIComponent(userId)}`,
      undefined,
      { userId }
    );
  }

  async getControllerVersion(userId: string): Promise<ControllerVersionResponse> {
    return this.request(
      `/api/platform/controller-version?userId=${encodeURIComponent(userId)}`,
      undefined,
      { userId }
    );
  }

  async startGateway(userId: string): Promise<GatewayProcessActionResponse> {
    return this.request(
      '/api/platform/gateway/start',
      {
        method: 'POST',
        body: JSON.stringify({ userId }),
      },
      { userId }
    );
  }

  async stopGateway(userId: string): Promise<GatewayProcessActionResponse> {
    return this.request(
      '/api/platform/gateway/stop',
      {
        method: 'POST',
        body: JSON.stringify({ userId }),
      },
      { userId }
    );
  }

  async restartGatewayProcess(userId: string): Promise<GatewayProcessActionResponse> {
    return this.request(
      '/api/platform/gateway/restart',
      {
        method: 'POST',
        body: JSON.stringify({ userId }),
      },
      { userId }
    );
  }

  async restoreConfig(userId: string, version = 'base'): Promise<ConfigRestoreResponse> {
    return this.request(
      '/api/platform/config/restore',
      {
        method: 'POST',
        body: JSON.stringify({ userId, version }),
      },
      { userId }
    );
  }

  async getOpenclawConfig(userId: string): Promise<OpenclawConfigResponse> {
    return this.request(
      `/api/platform/openclaw-config?userId=${encodeURIComponent(userId)}`,
      undefined,
      { userId }
    );
  }

  async replaceOpenclawConfig(
    userId: string,
    config: Record<string, unknown>,
    etag?: string
  ): Promise<{ ok: true }> {
    return this.request(
      '/api/platform/openclaw-config',
      {
        method: 'POST',
        body: JSON.stringify({ userId, config, ...(etag !== undefined && { etag }) }),
      },
      { userId }
    );
  }

  async patchOpenclawConfig(
    userId: string,
    patch: Record<string, unknown>
  ): Promise<{ ok: boolean }> {
    return this.request(
      '/api/platform/openclaw-config',
      {
        method: 'PATCH',
        body: JSON.stringify({ userId, patch }),
      },
      { userId }
    );
  }

  async getFileTree(userId: string): Promise<{ tree: FileNode[] }> {
    const params = new URLSearchParams({ userId });
    return this.request(`/api/platform/files/tree?${params.toString()}`);
  }

  async readFile(userId: string, filePath: string): Promise<{ content: string; etag: string }> {
    const params = new URLSearchParams({ userId, path: filePath });
    return this.request(`/api/platform/files/read?${params.toString()}`);
  }

  async writeFile(
    userId: string,
    filePath: string,
    content: string,
    etag?: string
  ): Promise<{ etag: string }> {
    return this.request('/api/platform/files/write', {
      method: 'POST',
      body: JSON.stringify({ userId, path: filePath, content, etag }),
    });
  }

  async updateGoogleCredentials(
    userId: string,
    input: GoogleCredentialsInput
  ): Promise<GoogleCredentialsResponse> {
    return this.request(
      '/api/platform/google-credentials',
      {
        method: 'POST',
        body: JSON.stringify({ userId, ...input }),
      },
      { userId }
    );
  }

  async clearGoogleCredentials(userId: string): Promise<GoogleCredentialsResponse> {
    return this.request(
      `/api/platform/google-credentials?userId=${encodeURIComponent(userId)}`,
      {
        method: 'DELETE',
      },
      { userId }
    );
  }

  async enableGmailNotifications(userId: string): Promise<GmailNotificationsResponse> {
    return this.request(
      '/api/platform/gmail-notifications',
      {
        method: 'POST',
        body: JSON.stringify({ userId }),
      },
      { userId }
    );
  }

  async disableGmailNotifications(userId: string): Promise<GmailNotificationsResponse> {
    return this.request(
      `/api/platform/gmail-notifications?userId=${encodeURIComponent(userId)}`,
      {
        method: 'DELETE',
      },
      { userId }
    );
  }

  async forceRetryRecovery(userId: string): Promise<{ ok: true }> {
    return this.request(
      '/api/platform/force-retry-recovery',
      {
        method: 'POST',
        body: JSON.stringify({ userId }),
      },
      { userId }
    );
  }

  async listCandidateVolumes(userId: string): Promise<CandidateVolumesResponse> {
    return this.request(
      `/api/platform/candidate-volumes?userId=${encodeURIComponent(userId)}`,
      undefined,
      { userId }
    );
  }

  async reassociateVolume(
    userId: string,
    newVolumeId: string,
    reason: string
  ): Promise<ReassociateVolumeResponse> {
    return this.request(
      '/api/platform/reassociate-volume',
      {
        method: 'POST',
        body: JSON.stringify({ userId, newVolumeId, reason }),
      },
      { userId }
    );
  }

  async restoreVolumeFromSnapshot(
    userId: string,
    snapshotId: string
  ): Promise<RestoreVolumeSnapshotResponse> {
    return this.request(
      '/api/platform/restore-volume-snapshot',
      {
        method: 'POST',
        body: JSON.stringify({ userId, snapshotId }),
      },
      { userId }
    );
  }

  async destroyFlyMachine(
    userId: string,
    appName: string,
    machineId: string
  ): Promise<{ ok: true }> {
    return this.request(
      '/api/platform/destroy-fly-machine',
      {
        method: 'POST',
        body: JSON.stringify({ userId, appName, machineId }),
      },
      { userId }
    );
  }

  async getRegions(): Promise<RegionsResponse> {
    return this.request('/api/platform/regions');
  }

  async updateRegions(regions: string[]): Promise<UpdateRegionsResponse> {
    return this.request('/api/platform/regions', {
      method: 'PUT',
      body: JSON.stringify({ regions }),
    });
  }
}
