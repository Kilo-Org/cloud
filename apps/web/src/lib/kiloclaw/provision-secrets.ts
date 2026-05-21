import { FIELD_KEY_TO_ENV_VAR } from '@kilocode/kiloclaw-secret-catalog';
import { encryptKiloClawSecret } from '@/lib/kiloclaw/encryption';

export function encryptProvisionSecretsForWorker(
  secrets: Record<string, string> | undefined
): Record<string, ReturnType<typeof encryptKiloClawSecret>> | undefined {
  if (!secrets) return undefined;
  return Object.fromEntries(
    Object.entries(secrets).map(([key, value]) => [
      FIELD_KEY_TO_ENV_VAR.get(key) ?? key,
      encryptKiloClawSecret(value),
    ])
  );
}
