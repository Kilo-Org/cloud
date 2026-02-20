import { z } from 'zod';

export const EncryptedEnvelopeSchema = z.object({
  encryptedData: z.string(),
  encryptedDEK: z.string(),
  algorithm: z.literal('rsa-aes-256-gcm'),
  version: z.literal(1),
});

export type ModelEntry = { id: string; name: string };

const ModelEntrySchema = z.object({ id: z.string(), name: z.string() });

const MachineSizeSchema = z.object({
  cpus: z.number(),
  memory_mb: z.number(),
  cpu_kind: z.enum(['shared', 'performance']).optional(),
});

export type MachineSize = z.infer<typeof MachineSizeSchema>;

/**
 * Valid env var name: must be a valid shell identifier and must not use
 * reserved prefixes (KILOCLAW_ENC_, KILOCLAW_ENV_) which are reserved
 * for the env var encryption system.
 */
const envVarNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Must be a valid shell identifier')
  .refine(
    s => !s.startsWith('KILOCLAW_ENC_') && !s.startsWith('KILOCLAW_ENV_'),
    'Uses reserved prefix (KILOCLAW_ENC_ or KILOCLAW_ENV_)'
  );

export const InstanceConfigSchema = z.object({
  envVars: z.record(envVarNameSchema, z.string()).optional(),
  encryptedSecrets: z.record(envVarNameSchema, EncryptedEnvelopeSchema).optional(),
  kilocodeApiKey: z.string().nullable().optional(),
  kilocodeApiKeyExpiresAt: z.string().nullable().optional(),
  kilocodeDefaultModel: z.string().nullable().optional(),
  kilocodeModels: z.array(ModelEntrySchema).nullable().optional(),
  channels: z
    .object({
      telegramBotToken: EncryptedEnvelopeSchema.optional(),
      discordBotToken: EncryptedEnvelopeSchema.optional(),
      slackBotToken: EncryptedEnvelopeSchema.optional(),
      slackAppToken: EncryptedEnvelopeSchema.optional(),
    })
    .optional(),
  machineSize: MachineSizeSchema.optional(),
  // Region for Fly Volume/Machine. Comma-separated priority list of region codes or aliases.
  // Examples: "us,eu" (try US first, then Europe), "lhr" (London only).
  // If omitted, falls back to the FLY_REGION env var.
  region: z.string().optional(),
});

export type InstanceConfig = z.infer<typeof InstanceConfigSchema>;
export type EncryptedEnvelope = z.infer<typeof EncryptedEnvelopeSchema>;
export type EncryptedChannelTokens = NonNullable<InstanceConfig['channels']>;

export const ChannelsPatchSchema = z.object({
  userId: z.string().min(1),
  channels: z.object({
    telegramBotToken: EncryptedEnvelopeSchema.nullable().optional(),
    discordBotToken: EncryptedEnvelopeSchema.nullable().optional(),
    slackBotToken: EncryptedEnvelopeSchema.nullable().optional(),
    slackAppToken: EncryptedEnvelopeSchema.nullable().optional(),
  }),
});

export const ProvisionRequestSchema = z.object({
  userId: z.string().min(1),
  ...InstanceConfigSchema.shape,
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
  status: z.enum(['provisioned', 'running', 'stopped', 'destroying']).default('stopped'),
  envVars: z.record(z.string(), z.string()).nullable().default(null),
  encryptedSecrets: z.record(z.string(), EncryptedEnvelopeSchema).nullable().default(null),
  kilocodeApiKey: z.string().nullable().default(null),
  kilocodeApiKeyExpiresAt: z.string().nullable().default(null),
  kilocodeDefaultModel: z.string().nullable().default(null),
  kilocodeModels: z.array(ModelEntrySchema).nullable().default(null),
  channels: z
    .object({
      telegramBotToken: EncryptedEnvelopeSchema.optional(),
      discordBotToken: EncryptedEnvelopeSchema.optional(),
      slackBotToken: EncryptedEnvelopeSchema.optional(),
      slackAppToken: EncryptedEnvelopeSchema.optional(),
    })
    .nullable()
    .default(null),
  provisionedAt: z.number().nullable().default(null),
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
  // Cooldown: last time we attempted metadata-based machine recovery from Fly.
  // Prevents hammering listMachines on every alarm when there's genuinely nothing.
  lastMetadataRecoveryAt: z.number().nullable().default(null),
});

export type PersistedState = z.infer<typeof PersistedStateSchema>;
