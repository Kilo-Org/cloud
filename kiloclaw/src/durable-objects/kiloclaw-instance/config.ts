import { signKiloToken, withTimeout } from '@kilocode/worker-utils';
import type { KiloClawEnv } from '../../types';
import { buildEnvVars } from '../../gateway/env';
import { ENCRYPTED_ENV_PREFIX, encryptEnvValue } from '../../utils/env-encryption';
import { findPepperByUserId, getWorkerDb } from '../../db';
import { KILOCODE_API_KEY_EXPIRY_SECONDS } from '../../config';
import type { InstanceMutableState } from './types';
import { storageUpdate } from './state';

const MINT_TIMEOUT_MS = 5_000;

/**
 * Resolve the Docker image tag for this instance.
 * Falls back to FLY_IMAGE_TAG for instances provisioned before tracking was enabled.
 */
export function resolveImageTag(state: InstanceMutableState, env: KiloClawEnv): string {
  if (state.trackedImageTag) {
    return state.trackedImageTag;
  }
  return env.FLY_IMAGE_TAG ?? 'latest';
}

/**
 * Shared Docker image registry app name.
 */
export function getRegistryApp(env: KiloClawEnv): string {
  return env.FLY_REGISTRY_APP ?? env.FLY_APP_NAME ?? 'kiloclaw-machines';
}

/**
 * Check whether the stored API key has expired.
 */
export function hasExpiredStoredApiKey(state: InstanceMutableState): boolean {
  if (!state.kilocodeApiKey || !state.kilocodeApiKeyExpiresAt) {
    return false;
  }

  const expiresAtMs = Date.parse(state.kilocodeApiKeyExpiresAt);
  if (Number.isNaN(expiresAtMs)) {
    return false;
  }

  return expiresAtMs <= Date.now();
}

/**
 * Mint a fresh KiloCode API key for the given user.
 */
export async function mintFreshApiKey(
  env: KiloClawEnv,
  userId: string
): Promise<{ token: string; expiresAt: string } | null> {
  const connectionString = env.HYPERDRIVE?.connectionString;
  if (!connectionString) {
    return null;
  }

  const secret = env.NEXTAUTH_SECRET;
  if (!secret) {
    return null;
  }

  const db = getWorkerDb(connectionString);
  const user = await findPepperByUserId(db, userId);
  if (!user) {
    console.warn('[DO] mintFreshApiKey: user not found in DB');
    return null;
  }

  return signKiloToken({
    userId: user.id,
    pepper: user.api_token_pepper,
    secret,
    expiresInSeconds: KILOCODE_API_KEY_EXPIRY_SECONDS,
    env: env.WORKER_ENV,
  });
}

/**
 * Build the full env var set for a machine, including encrypted sensitive values.
 * Mints a fresh API key if possible, persists it, then builds the env/sensitive split.
 */
export async function buildUserEnvVars(
  env: KiloClawEnv,
  ctx: DurableObjectState,
  state: InstanceMutableState
): Promise<{
  envVars: Record<string, string>;
  minSecretsVersion: number;
}> {
  if (!state.sandboxId || !env.GATEWAY_TOKEN_SECRET) {
    throw new Error('Cannot build env vars: sandboxId or GATEWAY_TOKEN_SECRET missing');
  }
  if (!state.userId) {
    throw new Error('Cannot build env vars: userId missing');
  }
  if (!env.NEXTAUTH_SECRET) {
    throw new Error('Cannot build env vars: NEXTAUTH_SECRET missing');
  }

  let kilocodeApiKey = state.kilocodeApiKey ?? undefined;
  if (state.userId && env.HYPERDRIVE?.connectionString) {
    try {
      const freshKey = await withTimeout(
        mintFreshApiKey(env, state.userId),
        MINT_TIMEOUT_MS,
        'API key mint timed out'
      );
      if (freshKey) {
        kilocodeApiKey = freshKey.token;
        state.kilocodeApiKey = freshKey.token;
        state.kilocodeApiKeyExpiresAt = freshKey.expiresAt;
        await ctx.storage.put(
          storageUpdate({
            kilocodeApiKey: freshKey.token,
            kilocodeApiKeyExpiresAt: freshKey.expiresAt,
          })
        );
        console.log('[DO] buildUserEnvVars: minted fresh API key, expires:', freshKey.expiresAt);
      }
    } catch (err) {
      console.warn('[DO] buildUserEnvVars: failed to mint fresh API key, using stored key:', err);
    }
  }

  if (hasExpiredStoredApiKey(state)) {
    throw new Error(
      'Cannot build env vars: stored KiloCode API key expired and fresh mint unavailable'
    );
  }

  const { env: plainEnv, sensitive } = await buildEnvVars(
    env,
    state.sandboxId,
    env.GATEWAY_TOKEN_SECRET,
    {
      envVars: state.envVars ?? undefined,
      encryptedSecrets: state.encryptedSecrets ?? undefined,
      kilocodeApiKey,
      kilocodeDefaultModel: state.kilocodeDefaultModel ?? undefined,
      channels: state.channels ?? undefined,
      instanceFeatures: state.instanceFeatures,
    }
  );

  // Get the env encryption key from the App DO, creating it if needed.
  const appStub = env.KILOCLAW_APP.get(env.KILOCLAW_APP.idFromName(state.userId));
  const { key: envKey, secretsVersion } = await appStub.ensureEnvKey(state.userId);

  // Encrypt sensitive values and prefix their names with KILOCLAW_ENC_
  const result: Record<string, string> = { ...plainEnv };
  for (const [name, value] of Object.entries(sensitive)) {
    result[`${ENCRYPTED_ENV_PREFIX}${name}`] = encryptEnvValue(envKey, value);
  }

  return { envVars: result, minSecretsVersion: secretsVersion };
}
