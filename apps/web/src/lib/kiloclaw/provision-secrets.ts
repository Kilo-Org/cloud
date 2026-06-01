import { TRPCError } from '@trpc/server';
import {
  FIELD_KEY_TO_ENTRY,
  FIELD_KEY_TO_ENV_VAR,
  validateFieldValue,
} from '@kilocode/kiloclaw-secret-catalog';
import { encryptKiloClawSecret } from '@/lib/kiloclaw/encryption';

const COMPOSIO_SECRET_FIELD_KEYS = ['composioUserApiKey', 'composioOrg'] as const;

function hasComposioProvisionSecrets(secrets: Record<string, string>): boolean {
  return COMPOSIO_SECRET_FIELD_KEYS.some(key => secrets[key] !== undefined);
}

function validateComposioProvisionSecrets(secrets: Record<string, string>): void {
  if (!hasComposioProvisionSecrets(secrets)) return;
  const hasAllFields = COMPOSIO_SECRET_FIELD_KEYS.every(key => secrets[key] !== undefined);
  if (!hasAllFields) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Composio requires all fields to be set together',
    });
  }

  for (const key of COMPOSIO_SECRET_FIELD_KEYS) {
    const value = secrets[key];
    if (value === undefined) continue;
    const entry = FIELD_KEY_TO_ENTRY.get(key);
    const field = entry?.fields.find(candidate => candidate.key === key);
    if (field?.maxLength != null && value.length > field.maxLength) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `${field.label} exceeds maximum length of ${field.maxLength} characters`,
      });
    }
    if (!validateFieldValue(value, field?.validationPattern)) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: field?.validationMessage ?? `Invalid value for ${key}`,
      });
    }
  }
}

export function encryptProvisionSecretsForWorker(
  secrets: Record<string, string> | undefined
): Record<string, ReturnType<typeof encryptKiloClawSecret>> | undefined {
  if (!secrets) return undefined;
  validateComposioProvisionSecrets(secrets);
  return Object.fromEntries(
    Object.entries(secrets).map(([key, value]) => [
      FIELD_KEY_TO_ENV_VAR.get(key) ?? key,
      encryptKiloClawSecret(value),
    ])
  );
}
