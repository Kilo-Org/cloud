import type { EncryptedEnvelope } from '@/lib/encryption';

/** Input to POST /api/platform/provision */
export type ProvisionInput = {
  envVars?: Record<string, string>;
  encryptedSecrets?: Record<string, EncryptedEnvelope>;
  channels?: {
    telegramBotToken?: EncryptedEnvelope;
    discordBotToken?: EncryptedEnvelope;
    slackBotToken?: EncryptedEnvelope;
    slackAppToken?: EncryptedEnvelope;
  };
  kilocodeApiKey?: string;
  kilocodeApiKeyExpiresAt?: string;
  kilocodeDefaultModel?: string;
  kilocodeModels?: KiloCodeModelEntry[];
};

export type KiloCodeModelEntry = {
  id: string;
  name: string;
};

export type KiloCodeConfigPatchInput = {
  kilocodeApiKey?: string | null;
  kilocodeApiKeyExpiresAt?: string | null;
  kilocodeDefaultModel?: string | null;
  kilocodeModels?: KiloCodeModelEntry[] | null;
};

export type KiloCodeConfigResponse = {
  kilocodeApiKey: string | null;
  kilocodeApiKeyExpiresAt: string | null;
  kilocodeDefaultModel: string | null;
  kilocodeModels: KiloCodeModelEntry[] | null;
};

/** Input to PATCH /api/platform/channels */
export type ChannelsPatchInput = {
  channels: {
    telegramBotToken?: EncryptedEnvelope | null;
    discordBotToken?: EncryptedEnvelope | null;
    slackBotToken?: EncryptedEnvelope | null;
    slackAppToken?: EncryptedEnvelope | null;
  };
};

/** Response from PATCH /api/platform/channels */
export type ChannelsPatchResponse = {
  telegram: boolean;
  discord: boolean;
  slackBot: boolean;
  slackApp: boolean;
};

/** A pending channel pairing request (e.g. from Telegram DM) */
export type PairingRequest = {
  code: string;
  id: string;
  channel: string;
  meta?: unknown;
  createdAt?: string;
};

/** Response from GET /api/platform/pairing */
export type PairingListResponse = {
  requests: PairingRequest[];
};

/** Response from POST /api/platform/pairing/approve */
export type PairingApproveResponse = {
  success: boolean;
  message: string;
};

/** Response from GET /api/platform/status and GET /api/kiloclaw/status */
export type PlatformStatusResponse = {
  userId: string | null;
  sandboxId: string | null;
  status: 'provisioned' | 'running' | 'stopped' | 'destroying' | null;
  provisionedAt: number | null;
  lastStartedAt: number | null;
  lastStoppedAt: number | null;
  envVarCount: number;
  secretCount: number;
  channelCount: number;
  flyAppName: string | null;
  flyMachineId: string | null;
  flyVolumeId: string | null;
  flyRegion: string | null;
};

/** A Fly volume snapshot. */
export type VolumeSnapshot = {
  id: string;
  created_at: string;
  digest: string;
  retention_days: number;
  size: number;
  status: string;
  volume_size: number;
};

/** Response from GET /api/platform/volume-snapshots */
export type VolumeSnapshotsResponse = {
  snapshots: VolumeSnapshot[];
};

/** Response from GET /api/kiloclaw/config */
export type UserConfigResponse = {
  envVarKeys: string[];
  secretCount: number;
  kilocodeDefaultModel: string | null;
  hasKiloCodeApiKey: boolean;
  kilocodeApiKeyExpiresAt?: string | null;
  channels: {
    telegram: boolean;
    discord: boolean;
    slackBot: boolean;
    slackApp: boolean;
  };
};

/** Response from POST /api/platform/doctor */
export type DoctorResponse = {
  success: boolean;
  output: string;
};

/** Response from POST /api/admin/gateway/restart */
export type RestartGatewayResponse = {
  success: boolean;
  message?: string;
  error?: string;
};

/** Response from GET /api/platform/gateway/status */
export type GatewayProcessStatusResponse = {
  state: 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed' | 'shutting_down';
  pid: number | null;
  uptime: number;
  restarts: number;
  lastExit: {
    code: number | null;
    signal: string | null;
    at: string;
  } | null;
};

/** Response from POST /api/platform/gateway/{start|stop|restart} */
export type GatewayProcessActionResponse = {
  ok: boolean;
};

/** Combined status + gateway token returned by tRPC getStatus */
export type KiloClawDashboardStatus = PlatformStatusResponse & {
  gatewayToken: string | null;
  /** Worker base URL for constructing the "Open" link. Falls back to claw.kilo.ai. */
  workerUrl: string;
};
