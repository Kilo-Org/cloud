import { CONTROL_RUNTIME_RESERVED_ENV_VARS } from '../../shared/runtime-environment.js';
import { ISSUED_CREDENTIAL_ENV_KEYS } from '../../sandbox-control/session-credentials.js';
import { mergeEnvVarsWithSecrets, type EncryptedSecrets } from '../../utils/encryption.js';

/**
 * Names a secret must never reintroduce when the pre-overlay spec did not carry
 * them: the grant clears the org id (`!contained`) and the control-runtime names
 * belong to the platform. SCM names are deliberately excluded — a plaintext var
 * of the same name survives today, so a secret may set one the grant did not
 * issue.
 */
const DELETE_WHEN_UNOWNED_ENV_KEYS: readonly string[] = [
  'KILOCODE_ORGANIZATION_ID',
  ...CONTROL_RUNTIME_RESERVED_ENV_VARS,
];

export type FrameEnvInput = {
  /** The grant-projected route spec env, before the secret overlay. */
  specEnv: Record<string, string> | undefined;
  /** The DO-private encrypted-secrets snapshot, opaque to the shared schema. */
  encryptedSecrets: Record<string, unknown> | undefined;
  privateKey: string | undefined;
};

export type FrameEnvResult = {
  /** The merged env; the same object when there are no secrets. */
  env: Record<string, string> | undefined;
  /** Names the wrapper should redact: only keys whose value is the decrypted secret. */
  secretEnvKeys: string[];
};

/**
 * Copies `specEnv`, overlays the decrypted profile secrets, then restores the
 * credential keys the grant already projected. Decryption throws when the
 * snapshot is non-empty and no private key is configured. Presence is
 * `Object.hasOwn`, not truthiness, so a key projected with an empty string is
 * still restored. The merged env is returned, never written back to the route.
 */
export function buildFrameEnv(input: FrameEnvInput): FrameEnvResult {
  const encrypted = input.encryptedSecrets;
  if (encrypted === undefined || Object.keys(encrypted).length === 0) {
    return { env: input.specEnv, secretEnvKeys: [] };
  }
  const preOverlay = input.specEnv ?? {};
  const merged = mergeEnvVarsWithSecrets(
    preOverlay,
    encrypted as EncryptedSecrets,
    input.privateKey
  );
  const restored = new Set<string>();
  for (const key of ISSUED_CREDENTIAL_ENV_KEYS) {
    if (Object.hasOwn(preOverlay, key)) {
      merged[key] = preOverlay[key];
      restored.add(key);
    }
  }
  for (const key of DELETE_WHEN_UNOWNED_ENV_KEYS) {
    if (!Object.hasOwn(preOverlay, key) && Object.hasOwn(encrypted, key)) delete merged[key];
  }
  const secretEnvKeys = Object.keys(encrypted).filter(
    key => Object.hasOwn(merged, key) && !restored.has(key)
  );
  return { env: merged, secretEnvKeys };
}
