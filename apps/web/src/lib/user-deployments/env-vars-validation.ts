import * as z from 'zod';
import { MAX_ENV_VAR_KEY_LENGTH, MAX_ENV_VAR_VALUE_LENGTH } from './env-vars-constants';

/**
 * Branding symbols for nominal typing.
 * These ensure PlaintextEnvVar and EncryptedEnvVar are not interchangeable
 * even though they have the same structure.
 */
declare const PlaintextBrand: unique symbol;
declare const EncryptedBrand: unique symbol;

/**
 * Schema for environment variable keys.
 * - Must contain only uppercase letters, numbers, and underscores
 * - Cannot start with an underscore
 * - Maximum length from MAX_ENV_VAR_KEY_LENGTH
 */
export const envVarKeySchema = z
  .string()
  .min(1, 'Environment variable key cannot be empty')
  .max(
    MAX_ENV_VAR_KEY_LENGTH,
    `Environment variable key cannot exceed ${MAX_ENV_VAR_KEY_LENGTH} characters`
  )
  .regex(
    /^[A-Z0-9_]+$/,
    'Environment variable key must contain only uppercase letters, numbers, and underscores'
  )
  .regex(/^[A-Z0-9]/, 'Environment variable key cannot start with an underscore');

/**
 * Schema for environment variable values.
 * - Maximum length from MAX_ENV_VAR_VALUE_LENGTH
 */
export const envVarValueSchema = z
  .string()
  .max(
    MAX_ENV_VAR_VALUE_LENGTH,
    `Environment variable value cannot exceed ${MAX_ENV_VAR_VALUE_LENGTH} characters`
  );

/**
 * Base schema for environment variable structure.
 */
export const baseEnvVarSchema = z.object({
  key: envVarKeySchema,
  value: envVarValueSchema,
  isSecret: z.boolean(),
});

export type BaseEnvVar = z.infer<typeof baseEnvVarSchema>;

export type PlaintextEnvVar = BaseEnvVar & { readonly [PlaintextBrand]: typeof PlaintextBrand };
export type EncryptedEnvVar = BaseEnvVar & { readonly [EncryptedBrand]: typeof EncryptedBrand };

export function markAsPlaintext(envVar: BaseEnvVar): PlaintextEnvVar {
  return envVar as PlaintextEnvVar;
}

export function markAsEncrypted(envVar: BaseEnvVar): EncryptedEnvVar {
  return envVar as EncryptedEnvVar;
}

export const plaintextEnvVarSchema = baseEnvVarSchema.transform(markAsPlaintext);

export const encryptedEnvVarSchema = z
  .object({
    key: envVarKeySchema,
    value: z.string(), // No length limit - encrypted values are larger
    isSecret: z.boolean(),
  })
  .transform(markAsEncrypted);

/**
 * Schema for environment variable response.
 * Extends base schema with timestamps.
 * For secret variables, the value is masked ('***').
 */
export const envVarResponseSchema = baseEnvVarSchema.extend({
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * Response type for listing env vars - secrets are masked.
 */
export type EnvVarResponse = z.infer<typeof envVarResponseSchema>;
