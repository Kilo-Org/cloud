import { z } from 'zod';
import { ALL_SECRET_FIELD_KEYS } from '@kilocode/kiloclaw-secret-catalog';
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

const MachineSizeSchema = z.object({
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

export const InstanceConfigSchema = z.object({
  envVars: z.record(envVarNameSchema, z.string()).optional(),
  encryptedSecrets: z.record(envVarNameSchema, EncryptedEnvelopeSchema).optional(),
  kilocodeApiKey: z.string().nullable().optional(),
  kilocodeApiKeyExpiresAt: z.string().nullable().optional(),
  kilocodeDefaultModel: z.string().nullable().optional(),
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
  machineSize: MachineSizeSchema.optional(),
  // Region for Fly Volume/Machine. Comma-separated priority list of region codes or aliases.
  // Examples: "us,eu" (try US first, then Europe), "lhr" (London only).
  // If omitted, falls back to the FLY_REGION env var.
  region: z.string().optional(),
  // If set, use this image tag instead of resolving latest from KV.
  // Set by the cloud app when the user has a version pin.
  pinnedImageTag: z.string().regex(IMAGE_TAG_RE).max(IMAGE_TAG_MAX_LENGTH).optional(),
});

export type InstanceConfig = z.infer<typeof InstanceConfigSchema>;
export type EncryptedEnvelope = z.infer<typeof EncryptedEnvelopeSchema>;
export type EncryptedChannelTokens = NonNullable<InstanceConfig['channels']>;

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
    z.string().refine(k => ALL_SECRET_FIELD_KEYS.has(k), { message: 'Unknown secret field key' }),
    EncryptedEnvelopeSchema.nullable()
  ),
});

export const ProvisionRequestSchema = z.object({
  userId: z.string().min(1),
  ...InstanceConfigSchema.omit({ googleCredentials: true }).shape,
});

export type ProvisionRequest = z.infer<typeof ProvisionRequestSchema>;

export const UserIdRequestSchema = z.object({
  userId: z.string().min(1),
});

export const DestroyRequestSchema = z.object({
  userId: z.string().min(1),
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
  status: z
    .enum(['provisioned', 'starting', 'restarting', 'running', 'stopped', 'destroying'])
    .default('stopped'),
  envVars: z.record(z.string(), z.string()).nullable().default(null),
  encryptedSecrets: z.record(z.string(), EncryptedEnvelopeSchema).nullable().default(null),
  kilocodeApiKey: z.string().nullable().default(null),
  kilocodeApiKeyExpiresAt: z.string().nullable().default(null),
  kilocodeDefaultModel: z.string().nullable().default(null),
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
  provisionedAt: z.number().nullable().default(null),
  startingAt: z.number().nullable().default(null),
  restartingAt: z.number().nullable().default(null),
  restartUpdateSent: z.boolean().default(false),
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
  // Tracks whether the "instance ready" email has been sent for this provision lifecycle.
  // Set to true on first low-load checkin; reset on DO wipe (destroy + re-provision).
  instanceReadyEmailSent: z.boolean().default(false),
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
