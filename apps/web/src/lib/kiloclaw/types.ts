import type { EncryptedEnvelope } from '@/lib/encryption';
import type { SecretFieldKey } from '@kilocode/kiloclaw-secret-catalog';

/** Mirrors the worker's ImageVersionEntry schema (KV stored version metadata) */
export type ImageVersionEntry = {
  openclawVersion: string;
  variant: string;
  imageTag: string;
  imageDigest: string | null;
  publishedAt: string;
};

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
  userTimezone?: string | null;
  userLocation?: string | null;
  pinnedImageTag?: string;
};

export type KiloCodeConfigPatchInput = {
  kilocodeApiKey?: string | null;
  kilocodeApiKeyExpiresAt?: string | null;
  kilocodeDefaultModel?: string | null;
  vectorMemoryEnabled?: boolean;
  vectorMemoryModel?: string | null;
  dreamingEnabled?: boolean;
};

export type KiloCodeConfigResponse = {
  kilocodeApiKey: string | null;
  kilocodeApiKeyExpiresAt: string | null;
  kilocodeDefaultModel: string | null;
  vectorMemoryEnabled: boolean;
  vectorMemoryModel: string | null;
  dreamingEnabled: boolean;
};

export type WebSearchConfigPatchInput = {
  exaMode?: 'kilo-proxy' | 'disabled' | null;
};

export type WebSearchConfigPatchResponse = {
  exaMode: 'kilo-proxy' | 'disabled' | null;
};

export type BotIdentityPatchInput = {
  botName?: string | null;
  botNature?: string | null;
  botVibe?: string | null;
  botEmoji?: string | null;
};

export type BotIdentityPatchResponse = {
  botName: string | null;
  botNature: string | null;
  botVibe: string | null;
  botEmoji: string | null;
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

/** Input to PATCH /api/platform/secrets */
export type SecretsPatchInput = {
  secrets: Record<string, EncryptedEnvelope | null>;
  meta?: Record<string, { configPath?: string }>;
};

/** Response from PATCH /api/platform/secrets */
export type SecretsPatchResponse = {
  /** Catalog field keys that have a value set after the patch */
  configured: SecretFieldKey[];
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

/** A pending device pairing request (e.g. Control UI or node) */
export type DevicePairingRequest = {
  requestId: string;
  deviceId: string;
  role?: string;
  platform?: string;
  clientId?: string;
  ts?: number;
};

/** Response from GET /api/platform/device-pairing */
export type DevicePairingListResponse = {
  requests: DevicePairingRequest[];
};

/** Response from POST /api/platform/device-pairing/approve */
export type DevicePairingApproveResponse = {
  success: boolean;
  message: string;
};

/** Fly Machine guest spec (CPU/memory configuration) */
export type MachineSize = {
  cpus: number;
  memory_mb: number;
  cpu_kind?: 'shared' | 'performance';
};

// Keep in sync with services/kiloclaw/src/schemas/instance-config.ts ProviderIdSchema.
export type KiloClawProviderId = 'fly' | 'docker-local' | 'northflank';

export type ProviderRolloutConfig = {
  northflank: {
    personalTrafficPercent: number;
    organizationTrafficPercent: number;
    enabledOrganizationIds: string[];
  };
};

export type ProviderRolloutAvailability = {
  northflank: boolean;
};

/** Response from POST /api/platform/restore-volume-snapshot */
export type RestoreVolumeSnapshotResponse = {
  acknowledged: boolean;
  previousVolumeId: string;
};

/** Response from GET /api/platform/status and GET /api/kiloclaw/status */
export type PlatformStatusResponse = {
  userId: string | null;
  sandboxId: string | null;
  provider: KiloClawProviderId | null;
  runtimeId: string | null;
  storageId: string | null;
  region: string | null;
  status:
    | 'provisioned'
    | 'starting'
    | 'restarting'
    | 'recovering'
    | 'running'
    | 'stopped'
    | 'destroying'
    | 'restoring'
    | null;
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
  machineSize: MachineSize | null;
  openclawVersion: string | null;
  imageVariant: string | null;
  trackedImageTag: string | null;
  trackedImageDigest: string | null;
  googleConnected: boolean;
  googleOAuthConnected: boolean;
  googleOAuthStatus: 'active' | 'action_required' | 'disconnected';
  googleOAuthAccountEmail: string | null;
  googleOAuthCapabilities: string[];
  googleWorkspaceToolsEnabled?: boolean;
  googleWorkspaceConfigSyncPending?: boolean;
  googleWorkspaceConfigSyncError?: string | null;
  googleWorkspaceConfigReady?: boolean;
  googleWorkspaceConfigSyncedAt?: number | null;
  gmailNotificationsEnabled: boolean;
  execSecurity: string | null;
  execAsk: string | null;
  botName: string | null;
  botNature: string | null;
  botVibe: string | null;
  botEmoji: string | null;
};

/** A single registry DO's entries + migration status. */
export type RegistryResult = {
  registryKey: string;
  entries: Array<{
    instanceId: string;
    doKey: string;
    assignedUserId: string;
    createdAt: string;
    destroyedAt: string | null;
  }>;
  migrated: boolean;
};

/** Response from GET /api/platform/registry-entries (admin only). */
export type RegistryEntriesResponse = {
  registries: RegistryResult[];
};

/** Response from GET /api/platform/debug-status (internal/admin only). */
export type PlatformDebugStatusResponse = PlatformStatusResponse & {
  orgId: string | null;
  pendingDestroyMachineId: string | null;
  pendingDestroyVolumeId: string | null;
  pendingPostgresMarkOnFinalize: boolean;
  lastMetadataRecoveryAt: number | null;
  lastLiveCheckAt: number | null;
  alarmScheduledAt: number | null;
  lastDestroyErrorOp: 'machine' | 'volume' | 'recover' | null;
  lastDestroyErrorStatus: number | null;
  lastDestroyErrorMessage: string | null;
  lastDestroyErrorAt: number | null;
  lastStartErrorMessage: string | null;
  lastStartErrorAt: number | null;
  lastRestartErrorMessage: string | null;
  lastRestartErrorAt: number | null;
  recoveryStartedAt: number | null;
  pendingRecoveryVolumeId: string | null;
  recoveryPreviousVolumeId: string | null;
  recoveryPreviousVolumeCleanupAfter: number | null;
  lastRecoveryErrorMessage: string | null;
  lastRecoveryErrorAt: number | null;
  previousVolumeId: string | null;
  restoreStartedAt: string | null;
  pendingRestoreVolumeId: string | null;
  instanceReadyEmailSent: boolean;
  // Env key diagnostics from the App DO
  envKeyAppDOKey: string | null;
  envKeyAppDOFlyAppName: string | null;
  envKeyAppDOKeySet: boolean | null;
};

export type CleanupRecoveryPreviousVolumeResponse = {
  ok: true;
  deletedVolumeId: string | null;
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
  /** Per catalog entry ID → whether all fields for that entry are configured. */
  configuredSecrets: Record<string, boolean>;
  /** Search mode selected for Kilo-integrated Exa. */
  kiloExaSearchMode: 'kilo-proxy' | 'disabled' | null;
  /** Env var names of user-defined custom (non-catalog) secrets. */
  customSecretKeys: string[];
  /** Metadata for custom secrets (config paths, etc.). */
  customSecretMeta: Record<string, { configPath?: string }>;
  /** Whether vector memory search is enabled on this instance. */
  vectorMemoryEnabled: boolean;
  /** Embedding model ID for vector memory (e.g. "mistralai/mistral-embed-2312"). */
  vectorMemoryModel: string | null;
  /** Whether background dreaming (memory consolidation) is enabled. */
  dreamingEnabled: boolean;
};

/** Response from POST /api/platform/doctor */
export type DoctorResponse = {
  success: boolean;
  output: string;
};

export type OpenclawWorkspaceImportFailure = {
  path: string;
  operation: 'write' | 'delete';
  error: string;
  code?: string;
};

export type OpenclawWorkspaceImportResponse = {
  ok: boolean;
  attemptedWriteCount: number;
  writtenCount: number;
  attemptedDeleteCount: number;
  deletedCount: number;
  failedCount: number;
  totalUtf8Bytes: number;
  failures: OpenclawWorkspaceImportFailure[];
};

/** Response from POST /api/platform/kilo-cli-run/start */
export type KiloCliRunStartResponse = {
  ok: boolean;
  startedAt: string;
};

/** Response from GET /api/platform/kilo-cli-run/status */
export type KiloCliRunStatusResponse = {
  hasRun: boolean;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | null;
  output: string | null;
  exitCode: number | null;
  startedAt: string | null;
  completedAt: string | null;
  prompt: string | null;
};

/** Response from POST /api/admin/machine/restart */
export type RestartMachineResponse = {
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

/** Response from POST /api/platform/config/restore */
export type ConfigRestoreResponse = {
  ok: boolean;
  signaled: boolean;
};

/** Response from GET /api/platform/gateway/ready (opaque — shape depends on OpenClaw version) */
export type GatewayReadyResponse = Record<string, unknown>;

/** Response from GET /api/platform/controller-version. Null fields = old controller. */
export type ControllerVersionResponse = {
  version: string | null;
  commit: string | null;
  openclawVersion?: string | null;
  openclawCommit?: string | null;
};

/** Response from GET /api/platform/openclaw-config */
export type OpenclawConfigResponse = {
  config: Record<string, unknown>;
  etag: string;
};

export type MorningBriefingSourceReadiness = {
  configured: boolean;
  summary: string;
};

export type MorningBriefingDeliveryResult = {
  channel: 'telegram' | 'discord' | 'slack';
  status: 'sent' | 'skipped' | 'failed';
  target?: string;
  accountId?: string;
  reason?: 'missing_target' | 'ambiguous_target' | 'send_failed' | 'config_unavailable';
  error?: string;
};

export type MorningBriefingStatusLite = Pick<
  MorningBriefingStatusResponse,
  | 'enabled'
  | 'desiredEnabled'
  | 'observedEnabled'
  | 'reconcileState'
  | 'lastReconcileAction'
  | 'code'
  | 'cron'
  | 'timezone'
  | 'lastGeneratedDate'
  | 'sourceReadiness'
  | 'lastDelivery'
>;

export type MorningBriefingStatusResponse = {
  ok: boolean;
  enabled?: boolean;
  cron?: string;
  timezone?: string;
  cronJobId?: string | null;
  lastGeneratedDate?: string | null;
  lastGeneratedAt?: string | null;
  reconcileState?: 'idle' | 'in_progress' | 'succeeded' | 'failed';
  lastReconcileAction?: 'enable' | 'disable' | null;
  desiredEnabled?: boolean;
  observedEnabled?: boolean | null;
  lastReconcileAt?: string | null;
  lastReconcileError?: string | null;
  sourceReadiness?: {
    github: MorningBriefingSourceReadiness;
    linear: MorningBriefingSourceReadiness;
    web: MorningBriefingSourceReadiness;
  };
  lastDelivery?: MorningBriefingDeliveryResult[];
  code?: string;
  retryAfterSec?: number;
  error?: string;
};

export type MorningBriefingActionResponse = {
  ok: boolean;
  enabled?: boolean;
  cron?: string;
  timezone?: string;
  cronJobId?: string | null;
  date?: string;
  filePath?: string;
  failures?: string[];
  delivery?: MorningBriefingDeliveryResult[];
  code?: string;
  retryAfterSec?: number;
  error?: string;
};

export type MorningBriefingReadResponse = {
  ok: boolean;
  dateKey?: string;
  filePath?: string;
  exists?: boolean;
  markdown?: string | null;
  error?: string;
};

/** Input to POST /api/platform/google-credentials */
export type GoogleCredentialsInput = {
  googleCredentials: {
    gogConfigTarball: EncryptedEnvelope;
    email?: string;
  };
};

/** Response from POST/DELETE /api/platform/google-credentials */
export type GoogleCredentialsResponse = {
  googleConnected: boolean;
};

/** Input to POST /api/platform/google-oauth-connection */
export type GoogleOAuthConnectionInput = {
  googleOAuthConnection: {
    accountEmail: string | null;
    accountSubject: string | null;
    capabilities: string[];
    scopes: string[];
    status: 'active' | 'action_required' | 'disconnected';
    lastError?: string | null;
  };
};

/** Response from POST/DELETE /api/platform/google-oauth-connection */
export type GoogleOAuthConnectionResponse = {
  googleOAuthConnected: boolean;
  googleOAuthStatus: 'active' | 'action_required' | 'disconnected';
};

/** Response from POST/DELETE /api/platform/gmail-notifications */
export type GmailNotificationsResponse = {
  gmailNotificationsEnabled: boolean;
};

/** A candidate volume for admin volume reassociation. */
export type CandidateVolume = {
  id: string;
  name: string;
  state: 'created' | 'attached' | 'detached';
  size_gb: number;
  region: string;
  attached_machine_id: string | null;
  created_at: string;
  isCurrent: boolean;
};

/** Response from GET /api/platform/candidate-volumes */
export type CandidateVolumesResponse = {
  currentVolumeId: string | null;
  volumes: CandidateVolume[];
};

/** Response from POST /api/platform/reassociate-volume */
export type ReassociateVolumeResponse = {
  previousVolumeId: string | null;
  newVolumeId: string;
  newRegion: string;
};

/** Response from POST /api/platform/resize-machine */
export type ResizeMachineResponse = {
  previousSize: { cpus: number; memory_mb: number; cpu_kind?: string } | null;
  newSize: { cpus: number; memory_mb: number; cpu_kind?: string };
};

/** Response from GET /api/platform/regions */
export type RegionsResponse = {
  regions: string[];
  source: 'kv' | 'env' | 'default';
  raw: string;
};

/** Response from PUT /api/platform/regions */
export type UpdateRegionsResponse = {
  ok: true;
  regions: string[];
  raw: string;
};

/** Response from GET /api/platform/providers/rollout */
export type ProviderRolloutResponse = {
  rollout: ProviderRolloutConfig;
  availability: ProviderRolloutAvailability;
  source: 'kv' | 'default';
};

/** Response from PUT /api/platform/providers/rollout */
export type UpdateProviderRolloutResponse = {
  ok: true;
  rollout: ProviderRolloutConfig;
  availability: ProviderRolloutAvailability;
};

/** Stream Chat credentials for a user's KiloClaw channel */
export type ChatCredentials = {
  apiKey: string;
  userId: string;
  userToken: string;
  channelId: string;
} | null;

/** Combined status returned by tRPC getStatus */
export type KiloClawDashboardStatus = PlatformStatusResponse & {
  /** Worker base URL for constructing the "Open" link. Falls back to claw.kilo.ai. */
  workerUrl: string;
  name: string | null;
  /** Postgres row ID. Used to construct /i/{instanceId} proxy paths for instance-keyed instances. */
  instanceId: string | null;
  /** Copyable inbound email address for routing messages into this instance. */
  inboundEmailAddress: string | null;
  inboundEmailEnabled: boolean;
};
