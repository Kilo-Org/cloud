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

/** Response from POST /api/admin/gateway/restart */
export type RestartGatewayResponse = {
  success: boolean;
  message?: string;
  error?: string;
};

/** Combined status + gateway token returned by tRPC getStatus */
export type KiloClawDashboardStatus = PlatformStatusResponse & {
  gatewayToken: string | null;
  /** Worker base URL for constructing the "Open" link. Falls back to claw.kilo.ai. */
  workerUrl: string;
};
