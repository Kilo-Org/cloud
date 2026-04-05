import 'server-only';

import { KILOCLAW_API_URL, KILOCLAW_INTERNAL_API_SECRET } from '@/lib/config.server';
import type {
  ImageVersionEntry,
  ProvisionInput,
  PlatformStatusResponse,
  PlatformDebugStatusResponse,
  RegistryEntriesResponse,
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
  CleanupRecoveryPreviousVolumeResponse,
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

  async sendChatMessage(
    userId: string,
    message: string,
    instanceId?: string
  ): Promise<{ success: boolean; channelId: string }> {
    return this.request(
      '/api/platform/send-chat-message',
      {
        method: 'POST',
        body: JSON.stringify({ userId, message, instanceId }),
      },
      { userId }
    );
  }

  async getDebugStatus(userId: string, instanceId?: string): Promise<PlatformDebugStatusResponse> {
    const params = new URLSearchParams({ userId });
    if (instanceId) params.set('instanceId', instanceId);
    return this.request(`/api/platform/debug-status?${params.toString()}`, undefined, { userId });
  }

  async getRegistryEntries(userId: string, orgId?: string): Promise<RegistryEntriesResponse> {
    const params = new URLSearchParams({ userId });
    if (orgId) params.set('orgId', orgId);
    return this.request(`/api/platform/registry-entries?${params.toString()}`, undefined, {
      userId,
    });
  }

  async patchKiloCodeConfig(
    userId: string,
    patch: KiloCodeConfigPatchInput,
    instanceId?: string
  ): Promise<KiloCodeConfigResponse> {
    const params = instanceId ? `?instanceId=${encodeURIComponent(instanceId)}` : '';
    return this.request(
      `/api/platform/kilocode-config${params}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ userId, ...patch }),
      },
      { userId }
    );
  }

  async patchChannels(
    userId: string,
    input: ChannelsPatchInput,
    instanceId?: string
  ): Promise<ChannelsPatchResponse> {
    const params = instanceId ? `?instanceId=${encodeURIComponent(instanceId)}` : '';
    return this.request(
      `/api/platform/channels${params}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ userId, ...input }),
      },
      { userId }
    );
  }

  async patchExecPreset(
    userId: string,
    patch: { security?: string; ask?: string },
    instanceId?: string
  ): Promise<{ execSecurity: string | null; execAsk: string | null }> {
    const params = instanceId ? `?instanceId=${encodeURIComponent(instanceId)}` : '';
    return this.request(
      `/api/platform/exec-preset${params}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ userId, ...patch }),
      },
      { userId }
    );
  }

  async patchSecrets(
    userId: string,
    input: SecretsPatchInput,
    instanceId?: string
  ): Promise<SecretsPatchResponse> {
    const params = instanceId ? `?instanceId=${encodeURIComponent(instanceId)}` : '';
    return this.request(
      `/api/platform/secrets${params}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ userId, ...input }),
      },
      { userId }
    );
  }

  async listVolumeSnapshots(userId: string, instanceId?: string): Promise<VolumeSnapshotsResponse> {
    const params = new URLSearchParams({ userId });
    if (instanceId) params.set('instanceId', instanceId);
    return this.request(`/api/platform/volume-snapshots?${params.toString()}`, undefined, {
      userId,
    });
  }

  async listPairingRequests(
    userId: string,
    refresh = false,
    instanceId?: string
  ): Promise<PairingListResponse> {
    const params = new URLSearchParams({ userId });
    if (refresh) params.set('refresh', 'true');
    if (instanceId) params.set('instanceId', instanceId);
    return this.request(`/api/platform/pairing?${params.toString()}`, undefined, { userId });
  }

  async approvePairingRequest(
    userId: string,
    channel: string,
    code: string,
    instanceId?: string
  ): Promise<PairingApproveResponse> {
    const params = instanceId ? `?instanceId=${encodeURIComponent(instanceId)}` : '';
    return this.request(
      `/api/platform/pairing/approve${params}`,
      {
        method: 'POST',
        body: JSON.stringify({ userId, channel, code }),
      },
      { userId }
    );
  }

  async listDevicePairingRequests(
    userId: string,
    refresh = false,
    instanceId?: string
  ): Promise<DevicePairingListResponse> {
    const params = new URLSearchParams({ userId });
    if (refresh) params.set('refresh', 'true');
    if (instanceId) params.set('instanceId', instanceId);
    return this.request(`/api/platform/device-pairing?${params.toString()}`, undefined, { userId });
  }

  async approveDevicePairingRequest(
    userId: string,
    requestId: string,
    instanceId?: string
  ): Promise<DevicePairingApproveResponse> {
    const params = instanceId ? `?instanceId=${encodeURIComponent(instanceId)}` : '';
    return this.request(
      `/api/platform/device-pairing/approve${params}`,
      {
        method: 'POST',
        body: JSON.stringify({ userId, requestId }),
      },
      { userId }
    );
  }

  async runDoctor(userId: string, instanceId?: string): Promise<DoctorResponse> {
    const params = instanceId ? `?instanceId=${encodeURIComponent(instanceId)}` : '';
    return this.request(
      `/api/platform/doctor${params}`,
      {
        method: 'POST',
        body: JSON.stringify({ userId }),
      },
      { userId }
    );
  }

  async startKiloCliRun(
    userId: string,
    prompt: string,
    instanceId?: string
  ): Promise<KiloCliRunStartResponse> {
    const params = instanceId ? `?instanceId=${encodeURIComponent(instanceId)}` : '';
    return this.request(
      `/api/platform/kilo-cli-run/start${params}`,
      {
        method: 'POST',
        body: JSON.stringify({ userId, prompt }),
      },
      { userId }
    );
  }

  async getKiloCliRunStatus(
    userId: string,
    instanceId?: string
  ): Promise<KiloCliRunStatusResponse> {
    const params = new URLSearchParams({ userId });
    if (instanceId) params.set('instanceId', instanceId);
    return this.request(`/api/platform/kilo-cli-run/status?${params.toString()}`, undefined, {
      userId,
    });
  }

  async cancelKiloCliRun(userId: string, instanceId?: string): Promise<{ ok: boolean }> {
    const params = instanceId ? `?instanceId=${encodeURIComponent(instanceId)}` : '';
    return this.request(
      `/api/platform/kilo-cli-run/cancel${params}`,
      {
        method: 'POST',
        body: JSON.stringify({ userId }),
      },
      { userId }
    );
  }

  async getGatewayStatus(
    userId: string,
    instanceId?: string
  ): Promise<GatewayProcessStatusResponse> {
    const params = new URLSearchParams({ userId });
    if (instanceId) params.set('instanceId', instanceId);
    return this.request(`/api/platform/gateway/status?${params.toString()}`, undefined, { userId });
  }

  async getGatewayReady(userId: string, instanceId?: string): Promise<GatewayReadyResponse> {
    const params = new URLSearchParams({ userId });
    if (instanceId) params.set('instanceId', instanceId);
    return this.request(`/api/platform/gateway/ready?${params.toString()}`, undefined, { userId });
  }

  async getControllerVersion(
    userId: string,
    instanceId?: string
  ): Promise<ControllerVersionResponse> {
    const params = new URLSearchParams({ userId });
    if (instanceId) params.set('instanceId', instanceId);
    return this.request(`/api/platform/controller-version?${params.toString()}`, undefined, {
      userId,
    });
  }

  async startGateway(userId: string, instanceId?: string): Promise<GatewayProcessActionResponse> {
    const params = instanceId ? `?instanceId=${encodeURIComponent(instanceId)}` : '';
    return this.request(
      `/api/platform/gateway/start${params}`,
      {
        method: 'POST',
        body: JSON.stringify({ userId }),
      },
      { userId }
    );
  }

  async stopGateway(userId: string, instanceId?: string): Promise<GatewayProcessActionResponse> {
    const params = instanceId ? `?instanceId=${encodeURIComponent(instanceId)}` : '';
    return this.request(
      `/api/platform/gateway/stop${params}`,
      {
        method: 'POST',
        body: JSON.stringify({ userId }),
      },
      { userId }
    );
  }

  async restartGatewayProcess(
    userId: string,
    instanceId?: string
  ): Promise<GatewayProcessActionResponse> {
    const params = instanceId ? `?instanceId=${encodeURIComponent(instanceId)}` : '';
    return this.request(
      `/api/platform/gateway/restart${params}`,
      {
        method: 'POST',
        body: JSON.stringify({ userId }),
      },
      { userId }
    );
  }

  async restoreConfig(
    userId: string,
    version = 'base',
    instanceId?: string
  ): Promise<ConfigRestoreResponse> {
    const params = instanceId ? `?instanceId=${encodeURIComponent(instanceId)}` : '';
    return this.request(
      `/api/platform/config/restore${params}`,
      {
        method: 'POST',
        body: JSON.stringify({ userId, version }),
      },
      { userId }
    );
  }

  async getOpenclawConfig(userId: string, instanceId?: string): Promise<OpenclawConfigResponse> {
    const params = new URLSearchParams({ userId });
    if (instanceId) params.set('instanceId', instanceId);
    return this.request(`/api/platform/openclaw-config?${params.toString()}`, undefined, {
      userId,
    });
  }

  async replaceOpenclawConfig(
    userId: string,
    config: Record<string, unknown>,
    etag?: string,
    instanceId?: string
  ): Promise<{ ok: true }> {
    const params = instanceId ? `?instanceId=${encodeURIComponent(instanceId)}` : '';
    return this.request(
      `/api/platform/openclaw-config${params}`,
      {
        method: 'POST',
        body: JSON.stringify({ userId, config, ...(etag !== undefined && { etag }) }),
      },
      { userId }
    );
  }

  async patchOpenclawConfig(
    userId: string,
    patch: Record<string, unknown>,
    instanceId?: string
  ): Promise<{ ok: boolean }> {
    const params = instanceId ? `?instanceId=${encodeURIComponent(instanceId)}` : '';
    return this.request(
      `/api/platform/openclaw-config${params}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ userId, patch }),
      },
      { userId }
    );
  }

  async getFileTree(userId: string, instanceId?: string): Promise<{ tree: FileNode[] }> {
    const params = new URLSearchParams({ userId });
    if (instanceId) params.set('instanceId', instanceId);
    return this.request(`/api/platform/files/tree?${params.toString()}`);
  }

  async readFile(
    userId: string,
    filePath: string,
    instanceId?: string
  ): Promise<{ content: string; etag: string }> {
    const params = new URLSearchParams({ userId, path: filePath });
    if (instanceId) params.set('instanceId', instanceId);
    return this.request(`/api/platform/files/read?${params.toString()}`);
  }

  async writeFile(
    userId: string,
    filePath: string,
    content: string,
    etag?: string,
    instanceId?: string
  ): Promise<{ etag: string }> {
    const params = instanceId ? `?instanceId=${encodeURIComponent(instanceId)}` : '';
    return this.request(`/api/platform/files/write${params}`, {
      method: 'POST',
      body: JSON.stringify({ userId, path: filePath, content, etag }),
    });
  }

  async updateGoogleCredentials(
    userId: string,
    input: GoogleCredentialsInput,
    instanceId?: string
  ): Promise<GoogleCredentialsResponse> {
    const params = instanceId ? `?instanceId=${encodeURIComponent(instanceId)}` : '';
    return this.request(
      `/api/platform/google-credentials${params}`,
      {
        method: 'POST',
        body: JSON.stringify({ userId, ...input }),
      },
      { userId }
    );
  }

  async clearGoogleCredentials(
    userId: string,
    instanceId?: string
  ): Promise<GoogleCredentialsResponse> {
    const params = new URLSearchParams({ userId });
    if (instanceId) params.set('instanceId', instanceId);
    return this.request(
      `/api/platform/google-credentials?${params.toString()}`,
      {
        method: 'DELETE',
      },
      { userId }
    );
  }

  async enableGmailNotifications(
    userId: string,
    instanceId?: string
  ): Promise<GmailNotificationsResponse> {
    const params = instanceId ? `?instanceId=${encodeURIComponent(instanceId)}` : '';
    return this.request(
      `/api/platform/gmail-notifications${params}`,
      {
        method: 'POST',
        body: JSON.stringify({ userId }),
      },
      { userId }
    );
  }

  async disableGmailNotifications(
    userId: string,
    instanceId?: string
  ): Promise<GmailNotificationsResponse> {
    const params = new URLSearchParams({ userId });
    if (instanceId) params.set('instanceId', instanceId);
    return this.request(
      `/api/platform/gmail-notifications?${params.toString()}`,
      {
        method: 'DELETE',
      },
      { userId }
    );
  }

  async forceRetryRecovery(userId: string, instanceId?: string): Promise<{ ok: true }> {
    const params = instanceId ? `?instanceId=${encodeURIComponent(instanceId)}` : '';
    return this.request(
      `/api/platform/force-retry-recovery${params}`,
      {
        method: 'POST',
        body: JSON.stringify({ userId }),
      },
      { userId }
    );
  }

  async cleanupRecoveryPreviousVolume(
    userId: string,
    instanceId?: string
  ): Promise<CleanupRecoveryPreviousVolumeResponse> {
    const params = instanceId ? `?instanceId=${encodeURIComponent(instanceId)}` : '';
    return this.request(
      `/api/platform/cleanup-recovery-previous-volume${params}`,
      {
        method: 'POST',
        body: JSON.stringify({ userId }),
      },
      { userId }
    );
  }

  async listCandidateVolumes(
    userId: string,
    instanceId?: string
  ): Promise<CandidateVolumesResponse> {
    const params = new URLSearchParams({ userId });
    if (instanceId) params.set('instanceId', instanceId);
    return this.request(`/api/platform/candidate-volumes?${params.toString()}`, undefined, {
      userId,
    });
  }

  async reassociateVolume(
    userId: string,
    newVolumeId: string,
    reason: string,
    instanceId?: string
  ): Promise<ReassociateVolumeResponse> {
    const params = instanceId ? `?instanceId=${encodeURIComponent(instanceId)}` : '';
    return this.request(
      `/api/platform/reassociate-volume${params}`,
      {
        method: 'POST',
        body: JSON.stringify({ userId, newVolumeId, reason }),
      },
      { userId }
    );
  }

  async restoreVolumeFromSnapshot(
    userId: string,
    snapshotId: string,
    instanceId?: string
  ): Promise<RestoreVolumeSnapshotResponse> {
    const params = instanceId ? `?instanceId=${encodeURIComponent(instanceId)}` : '';
    return this.request(
      `/api/platform/restore-volume-snapshot${params}`,
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
    machineId: string,
    instanceId?: string
  ): Promise<{ ok: true }> {
    const params = instanceId ? `?instanceId=${encodeURIComponent(instanceId)}` : '';
    return this.request(
      `/api/platform/destroy-fly-machine${params}`,
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
