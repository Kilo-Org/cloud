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
