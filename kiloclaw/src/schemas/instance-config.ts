import { z } from 'zod';

export const EncryptedEnvelopeSchema = z.object({
  encryptedData: z.string(),
  encryptedDEK: z.string(),
  algorithm: z.literal('rsa-aes-256-gcm'),
  version: z.literal(1),
});

export const InstanceConfigSchema = z.object({
  envVars: z.record(z.string(), z.string()).optional(),
  encryptedSecrets: z.record(z.string(), EncryptedEnvelopeSchema).optional(),
  channels: z
    .object({
      telegramBotToken: EncryptedEnvelopeSchema.optional(),
      discordBotToken: EncryptedEnvelopeSchema.optional(),
      slackBotToken: EncryptedEnvelopeSchema.optional(),
      slackAppToken: EncryptedEnvelopeSchema.optional(),
    })
    .optional(),
});

export type InstanceConfig = z.infer<typeof InstanceConfigSchema>;

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
  deleteData: z.boolean().optional(),
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
  status: z.enum(['provisioned', 'running', 'stopped']).default('stopped'),
  envVars: z.record(z.string(), z.string()).nullable().default(null),
  encryptedSecrets: z.record(z.string(), EncryptedEnvelopeSchema).nullable().default(null),
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
  lastSyncAt: z.number().nullable().default(null),
  syncInProgress: z.boolean().default(false),
  syncLockedAt: z.number().nullable().default(null),
  syncFailCount: z.number().default(0),
});

export type PersistedState = z.infer<typeof PersistedStateSchema>;
