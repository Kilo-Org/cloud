import { z } from 'zod';
import { KiloclawDestroyReasonSchema, KiloclawStartReasonSchema } from '@kilocode/worker-utils';
import {
  ALL_SECRET_FIELD_KEYS,
  isValidCustomSecretKey,
  isValidConfigPath,
} from '@kilocode/kiloclaw-secret-catalog';
import { IMAGE_TAG_RE, IMAGE_TAG_MAX_LENGTH } from '../lib/image-tag-validation';

export const EncryptedEnvelopeSchema = z.object({
  // AES-256-GCM ciphertext: 16-byte IV + ciphertext + 16-byte tag, base64-encoded.
  // 64 KiB headroom for larger payloads like gog config tarballs.
  encryptedData: z.string().max(65536),
  // RSA-2048 OAEP ciphertext of the 32-byte DEK, base64-encoded (~344 chars).
  encryptedDEK: z.string().max(1024),
  algorithm: z.literal('rsa-aes-256-gcm'),
  version: z.literal(1),
});

export const MachineSizeSchema = z.object({
  cpus: z.number().int().min(1).max(8),
  memory_mb: z.number().int().min(256).max(16384),
  cpu_kind: z.enum(['shared', 'performance']).optional(),
});

export type MachineSize = z.infer<typeof MachineSizeSchema>;

/**
 * Valid env var name: must be a valid shell identifier and must not use
 * the reserved KILOCLAW_ prefix (used for encryption, feature flags,
 * and other internal system vars).
 */
const envVarNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Must be a valid shell identifier')
  .refine(s => !s.startsWith('KILOCLAW_'), 'Uses reserved prefix (KILOCLAW_*)');

export const GoogleCredentialsSchema = z.object({
  gogConfigTarball: EncryptedEnvelopeSchema, // base64 tar.gz of ~/.config/gogcli/
  email: z.string().optional(), // for display ("Connected as user@...")
  gmailPushOidcEmail: z.string().optional(), // SA email for OIDC push validation
});

export type GoogleCredentials = z.infer<typeof GoogleCredentialsSchema>;

export const GoogleOAuthConnectionSchema = z.object({
  accountEmail: z.string().nullable().default(null),
  accountSubject: z.string().nullable().default(null),
  capabilities: z.array(z.string()).default([]),
  scopes: z.array(z.string()).default([]),
  status: z.enum(['active', 'action_required', 'disconnected']).default('active'),
  lastError: z.string().nullable().default(null),
  connectedAt: z.number().nullable().default(null),
  updatedAt: z.number().nullable().default(null),
});

export type GoogleOAuthConnection = z.infer<typeof GoogleOAuthConnectionSchema>;

/** Metadata for a custom secret (e.g. config path for openclaw.json patching). */
export const CustomSecretMetaSchema = z.object({
  configPath: z
    .string()
    .refine(isValidConfigPath, {
      message:
        'Not a supported credential path. See https://docs.openclaw.ai/reference/secretref-credential-surface',
    })
    .optional(),
});

export type CustomSecretMeta = z.infer<typeof CustomSecretMetaSchema>;

// Keep in sync with apps/web/src/lib/kiloclaw/types.ts KiloClawProviderId.
export const ProviderIdSchema = z.enum(['fly', 'docker-local', 'northflank']);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const FlyProviderStateSchema = z.object({
  provider: z.literal('fly'),
  appName: z.string().nullable().default(null),
  machineId: z.string().nullable().default(null),
  volumeId: z.string().nullable().default(null),
  region: z.string().nullable().default(null),
});

export const DockerLocalProviderStateSchema = z.object({
  provider: z.literal('docker-local'),
  containerName: z.string().nullable().default(null),
  volumeName: z.string().nullable().default(null),
  hostPort: z.number().int().nullable().default(null),
});

export const ProviderStateSchema = z.discriminatedUnion('provider', [
  FlyProviderStateSchema,
  DockerLocalProviderStateSchema,
]);
export type FlyProviderState = z.infer<typeof FlyProviderStateSchema>;
export type DockerLocalProviderState = z.infer<typeof DockerLocalProviderStateSchema>;
export type ProviderState = z.infer<typeof ProviderStateSchema>;

export const KiloExaSearchModeSchema = z.enum(['kilo-proxy', 'disabled']);
export type KiloExaSearchMode = z.infer<typeof KiloExaSearchModeSchema>;

function isValidUserTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

const UserTimezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(isValidUserTimezone, 'Must be a valid IANA timezone');

const UserLocationSchema = z.string().trim().min(1).max(200);

export const InstanceConfigSchema = z.object({
  envVars: z.record(envVarNameSchema, z.string()).optional(),
  encryptedSecrets: z.record(envVarNameSchema, EncryptedEnvelopeSchema).optional(),
  kilocodeApiKey: z.string().nullable().optional(),
  kilocodeApiKeyExpiresAt: z.string().nullable().optional(),
  kilocodeDefaultModel: z.string().nullable().optional(),
  userTimezone: UserTimezoneSchema.nullable().optional(),
  userLocation: UserLocationSchema.nullable().optional(),
  webSearch: z
    .object({
      exaMode: KiloExaSearchModeSchema.optional(),
    })
    .optional(),
  // TODO: Legacy hardcoded channel storage. Kept for backward compat with
  // existing DO state and the decryptChannelTokens/buildEnvVars startup path.
  // Migrate to read from encryptedSecrets via catalog, then remove.
  channels: z
    .object({
      telegramBotToken: EncryptedEnvelopeSchema.optional(),
      discordBotToken: EncryptedEnvelopeSchema.optional(),
      slackBotToken: EncryptedEnvelopeSchema.optional(),
      slackAppToken: EncryptedEnvelopeSchema.optional(),
    })
    .optional(),
  googleCredentials: GoogleCredentialsSchema.optional(),
  googleOAuthConnection: GoogleOAuthConnectionSchema.optional(),
  googleWorkspaceToolsEnabled: z.boolean().optional(),
  googleWorkspaceConfigSyncPending: z.boolean().optional(),
  googleWorkspaceConfigSyncError: z.string().nullable().optional(),
  googleWorkspaceConfigSyncedAt: z.number().nullable().optional(),
  machineSize: MachineSizeSchema.optional(),
  // Region for Fly Volume/Machine. Comma-separated priority list of region codes or aliases.
  // Examples: "us,eu" (try US first, then Europe), "lhr" (London only).
  // If omitted, falls back to the FLY_REGION env var.
  region: z.string().optional(),
  // If set, use this image tag instead of resolving latest from KV.
  // Set by the cloud app when the user has a version pin.
  pinnedImageTag: z.string().regex(IMAGE_TAG_RE).max(IMAGE_TAG_MAX_LENGTH).optional(),
  customSecretMeta: z.record(z.string(), CustomSecretMetaSchema).nullable().optional(),
});

export type InstanceConfig = z.infer<typeof InstanceConfigSchema>;
export type EncryptedEnvelope = z.infer<typeof EncryptedEnvelopeSchema>;
export type EncryptedChannelTokens = NonNullable<InstanceConfig['channels']>;

/**
 * Default embedding model for vector memory when no model is explicitly
 * selected. The controller (`controller/src/config-writer.ts`) and the UI
 * (`apps/web/src/app/(app)/claw/components/embeddingModels.ts`) keep their
 * own copies of this literal because they are bundled separately from the
 * worker — when changing this constant, update all three locations.
 */
export const DEFAULT_VECTOR_MEMORY_MODEL = 'mistralai/mistral-embed-2312';

// TODO: Legacy — no UI callers remain. Remove alongside patchChannels tRPC
// mutation and PATCH /api/platform/channels worker route.
export const ChannelsPatchSchema = z.object({
  userId: z.string().min(1),
  channels: z.object({
    telegramBotToken: EncryptedEnvelopeSchema.nullable().optional(),
    discordBotToken: EncryptedEnvelopeSchema.nullable().optional(),
    slackBotToken: EncryptedEnvelopeSchema.nullable().optional(),
    slackAppToken: EncryptedEnvelopeSchema.nullable().optional(),
  }),
});

export const SecretsPatchSchema = z.object({
  userId: z.string().min(1),
  secrets: z.record(
    z.string().refine(k => ALL_SECRET_FIELD_KEYS.has(k) || isValidCustomSecretKey(k), {
      message: 'Invalid secret key: must be a catalog field key or valid env var name',
    }),
    EncryptedEnvelopeSchema.nullable()
  ),
  meta: z
    .record(
      z.string().refine(k => isValidCustomSecretKey(k), { message: 'Invalid meta key' }),
      CustomSecretMetaSchema
    )
    .optional(),
});

/**
 * Zod schema for validating instanceId at IO boundaries (query params, path params).
 * instanceId = kiloclaw_instances.id UUID.
 */
export const InstanceIdParam = z.string().uuid();

export const ProvisionRequestSchema = z.object({
  userId: z.string().min(1),
  /** Optional DB row UUID used as the DO key for multi-instance support. */
  instanceId: z.string().uuid().optional(),
  /** Optional org ID — null/absent means personal instance. */
  orgId: z.string().uuid().nullable().optional(),
  /** Bootstrap subscription against an existing instance row during migration cleanup. */
  bootstrapSubscription: z.boolean().optional(),
  provider: ProviderIdSchema.optional(),
  ...InstanceConfigSchema.omit({
    googleCredentials: true,
    googleOAuthConnection: true,
    googleWorkspaceToolsEnabled: true,
    googleWorkspaceConfigSyncPending: true,
    googleWorkspaceConfigSyncError: true,
    googleWorkspaceConfigSyncedAt: true,
  }).shape,
});

export type ProvisionRequest = z.infer<typeof ProvisionRequestSchema>;

export const UserIdRequestSchema = z.object({
  userId: z.string().min(1),
});

export const DestroyRequestSchema = z.object({
  userId: z.string().min(1),
  reason: KiloclawDestroyReasonSchema.optional(),
});

/**
 * Schema for the KiloClawInstance DO's persisted KV state.
 * Used by loadState() to validate storage.get() results at runtime,
 * replacing untyped `as` casts.
 *
 * Every field uses .default() so that adding new fields in future PRs
 * won't break safeParse for existing DOs that lack the new key.
 */
export const PersistedStateSchema = z.object({
  userId: z.string().default(''),
  sandboxId: z.string().default(''),
  /** Organization ID — null for personal instances, set for org instances. */
  orgId: z.string().nullable().default(null),
  provider: ProviderIdSchema.default('fly'),
  providerState: ProviderStateSchema.nullable().default(null),
  status: z
    .enum([
      'provisioned',
      'starting',
      'restarting',
      'recovering',
      'running',
      'stopped',
      'destroying',
      'restoring',
    ])
    .default('stopped'),
  envVars: z.record(z.string(), z.string()).nullable().default(null),
  encryptedSecrets: z.record(z.string(), EncryptedEnvelopeSchema).nullable().default(null),
  kilocodeApiKey: z.string().nullable().default(null),
  kilocodeApiKeyExpiresAt: z.string().nullable().default(null),
  kilocodeDefaultModel: z.string().nullable().default(null),
  userTimezone: UserTimezoneSchema.nullable().default(null),
  userLocation: UserLocationSchema.nullable().default(null),
  kiloExaSearchMode: KiloExaSearchModeSchema.nullable().default(null),
  channels: z
    .object({
      telegramBotToken: EncryptedEnvelopeSchema.optional(),
      discordBotToken: EncryptedEnvelopeSchema.optional(),
      slackBotToken: EncryptedEnvelopeSchema.optional(),
      slackAppToken: EncryptedEnvelopeSchema.optional(),
    })
    .nullable()
    .default(null),
  googleCredentials: GoogleCredentialsSchema.nullable().default(null),
  googleOAuthConnection: GoogleOAuthConnectionSchema.nullable().default(null),
  googleWorkspaceToolsEnabled: z.boolean().default(false),
  googleWorkspaceConfigSyncPending: z.boolean().default(false),
  googleWorkspaceConfigSyncError: z.string().nullable().default(null),
  googleWorkspaceConfigSyncedAt: z.number().nullable().default(null),
  provisionedAt: z.number().nullable().default(null),
  startingAt: z.number().nullable().default(null),
  restartingAt: z.number().nullable().default(null),
  recoveryStartedAt: z.number().nullable().default(null),
  restartUpdateSent: z.boolean().default(false),
  pendingStartReason: KiloclawStartReasonSchema.nullable().default(null),
  lastStartedAt: z.number().nullable().default(null),
  lastStoppedAt: z.number().nullable().default(null),
  // Fly.io app/machine/volume identifiers
  flyAppName: z.string().nullable().default(null),
  flyMachineId: z.string().nullable().default(null),
  flyVolumeId: z.string().nullable().default(null),
  flyRegion: z.string().nullable().default(null),
  machineSize: MachineSizeSchema.nullable().default(null),
  // Health check tracking
  healthCheckFailCount: z.number().default(0),
  // Two-phase destroy: IDs pending deletion on Fly. Cleared once Fly confirms.
  pendingDestroyMachineId: z.string().nullable().default(null),
  pendingDestroyVolumeId: z.string().nullable().default(null),
  // For stale auto-destroy only: defer DO state wipe until Postgres row is marked destroyed.
  pendingPostgresMarkOnFinalize: z.boolean().default(false),
  // Cooldown: last time we attempted metadata-based machine recovery from Fly.
  // Prevents hammering listMachines on every alarm when there's genuinely nothing.
  lastMetadataRecoveryAt: z.number().nullable().default(null),
  // Image version tracking: records what version/variant/tag a user was provisioned with
  openclawVersion: z.string().nullable().default(null),
  imageVariant: z.string().nullable().default(null),
  trackedImageTag: z.string().nullable().default(null),
  trackedImageDigest: z.string().nullable().default(null),
  // Structured last-error from the destroy retry loop, for admin observability.
  lastDestroyErrorOp: z.enum(['machine', 'volume', 'recover']).nullable().default(null),
  lastDestroyErrorStatus: z.number().nullable().default(null),
  lastDestroyErrorMessage: z.string().nullable().default(null),
  lastDestroyErrorAt: z.number().nullable().default(null),
  // Structured last-error from background start() failures, for admin observability.
  // Populated by the startAsync() catch handler when start() throws before creating a machine.
  lastStartErrorMessage: z.string().nullable().default(null),
  lastStartErrorAt: z.number().nullable().default(null),
  lastRestartErrorMessage: z.string().nullable().default(null),
  lastRestartErrorAt: z.number().nullable().default(null),
  pendingRecoveryVolumeId: z.string().nullable().default(null),
  recoveryPreviousVolumeId: z.string().nullable().default(null),
  recoveryPreviousVolumeCleanupAfter: z.number().nullable().default(null),
  lastRecoveryErrorMessage: z.string().nullable().default(null),
  lastRecoveryErrorAt: z.number().nullable().default(null),
  // Cooldown for bound-machine recovery during destroy: avoids repeated getVolume
  // calls when the volume consistently reports no attached machine.
  lastBoundMachineRecoveryAt: z.number().nullable().default(null),
  // Instance feature flags: set on first provision, persisted across reboots.
  // Each entry is a feature name (e.g. "npm-global-prefix") that gates runtime behavior.
  // New instances get the current feature set; legacy instances have an empty array.
  instanceFeatures: z.array(z.string()).default([]),
  gmailNotificationsEnabled: z.boolean().default(false),
  gmailLastHistoryId: z.string().nullable().default(null),
  gmailPushOidcEmail: z.string().nullable().default(null),
  // User-selected exec permissions preset (persisted so it survives restarts).
  // null = use defaults (security: 'allowlist', ask: 'on-miss').
  execSecurity: z.string().nullable().default(null),
  execAsk: z.string().nullable().default(null),
  // Set when updateExecPreset patched DO state but the gateway write was skipped
  // or failed (e.g. status !== 'running'). Cleared when flushed on start or via
  // alarm retry. See flushPendingConfigToGateway.
  execPresetApplyPending: z.boolean().default(false),
  botName: z.string().nullable().default(null),
  botNature: z.string().nullable().default(null),
  botVibe: z.string().nullable().default(null),
  botEmoji: z.string().nullable().default(null),
  // Set when updateBotIdentity patched DO state but the gateway write was
  // skipped or failed. Cleared when flushed on start or via alarm retry.
  botIdentityApplyPending: z.boolean().default(false),
  // Set when additive channel updates were persisted but the running gateway
  // config patch was skipped or failed. Removals intentionally do not set this.
  channelsApplyPending: z.boolean().default(false),
  // Snapshot restore: tracks the volume before the most recent restore for admin revert path.
  previousVolumeId: z.string().nullable().default(null),
  // Snapshot restore: timestamp set at enqueue time. Used by alarm for stuck-restore detection
  // (>30 min) and by admin UI to show "Restoring... (started X ago)".
  restoreStartedAt: z.string().nullable().default(null),
  // Snapshot restore: status before entering 'restoring'. Used by failSnapshotRestore() to
  // restore the correct status if the restore fails without the queue worker ever running.
  // Only 'running', 'stopped', or 'provisioned' are reachable in practice — enqueueSnapshotRestore
  // blocks starting/restarting/destroying/restoring. Uses the full enum for forward compat.
  preRestoreStatus: z
    .enum([
      'provisioned',
      'starting',
      'restarting',
      'recovering',
      'running',
      'stopped',
      'destroying',
      'restoring',
    ])
    .nullable()
    .default(null),
  // Snapshot restore: volume ID created by the queue worker during restore.
  // Used for idempotency on retry — if set, the worker reuses this volume instead of creating another.
  pendingRestoreVolumeId: z.string().nullable().default(null),
  // Tracks whether the "instance ready" email has been sent for this provision lifecycle.
  // Set to true on first low-load checkin; reset on DO wipe (destroy + re-provision).
  instanceReadyEmailSent: z.boolean().default(false),
  // Metadata for custom (non-catalog) secrets: env var name → { configPath? }.
  // configPath is a JSON dot-notation path for patching into openclaw.json at boot.
  customSecretMeta: z.record(z.string(), CustomSecretMetaSchema).nullable().default(null),
  // Stream Chat default channel (auto-provisioned on first instance creation).
  // Null on existing instances (pre-Stream Chat) and when STREAM_CHAT_API_KEY is not set.
  streamChatApiKey: z.string().nullable().default(null),
  streamChatBotUserId: z.string().nullable().default(null),
  streamChatBotUserToken: z.string().nullable().default(null),
  streamChatChannelId: z.string().nullable().default(null),
  // Vector memory: whether the builtin embedding-backed memory search is enabled.
  vectorMemoryEnabled: z.boolean().default(false),
  // Vector memory: embedding model ID (e.g. "mistralai/mistral-embed-2312").
  vectorMemoryModel: z.string().nullable().default(null),
  // Dreaming: whether background memory consolidation is enabled.
  dreamingEnabled: z.boolean().default(false),
});

export type PersistedState = z.infer<typeof PersistedStateSchema>;

/**
 * Default instance features enabled for newly provisioned instances.
 * Existing instances keep their persisted (possibly empty) feature set.
 * See kiloclaw/docs/instance-features.md for details.
 */
export const DEFAULT_INSTANCE_FEATURES: readonly string[] = [
  'npm-global-prefix',
  'pip-global-prefix',
  'uv-global-prefix',
  'kilo-cli',
];
