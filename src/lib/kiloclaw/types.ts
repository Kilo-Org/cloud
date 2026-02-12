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
};

/** Response from GET /api/platform/status and GET /api/kiloclaw/status */
export type PlatformStatusResponse = {
  userId: string | null;
  sandboxId: string | null;
  status: 'provisioned' | 'running' | 'stopped' | null;
  lastSyncAt: number | null;
  syncInProgress: boolean;
  provisionedAt: number | null;
  lastStartedAt: number | null;
  lastStoppedAt: number | null;
  envVarCount: number;
  secretCount: number;
  channelCount: number;
};

/** Response from GET /api/kiloclaw/config */
export type UserConfigResponse = {
  envVarKeys: string[];
  secretCount: number;
  channels: {
    telegram: boolean;
    discord: boolean;
    slackBot: boolean;
    slackApp: boolean;
  };
};

/** Response from POST /api/admin/gateway/restart */
export type RestartGatewayResponse = {
  success: boolean;
  message?: string;
  previousProcessId?: string;
  error?: string;
};

/** Response from POST /api/admin/storage/sync */
export type SyncResponse = {
  success: boolean;
  message?: string;
  lastSync?: string;
  error?: string;
  details?: string;
};

/** Response from GET /api/admin/storage */
export type StorageInfoResponse = {
  configured: boolean;
  lastSync: string | null;
  syncInProgress: boolean;
  message: string;
};

/** Combined status + gateway token returned by tRPC getStatus */
export type KiloClawDashboardStatus = PlatformStatusResponse & {
  gatewayToken: string | null;
  /** Worker base URL for constructing the "Open" link. Falls back to claw.kilo.ai. */
  workerUrl: string;
};
