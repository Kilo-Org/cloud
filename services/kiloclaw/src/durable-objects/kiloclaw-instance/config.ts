import { signKiloToken, withTimeout } from '@kilocode/worker-utils';
import type { KiloClawEnv } from '../../types';
import { buildEnvVars } from '../../gateway/env';
import { ENCRYPTED_ENV_PREFIX, encryptEnvValue } from '../../utils/env-encryption';
import { findPepperByUserId, getWorkerDb } from '../../db';
import { KILOCODE_API_KEY_EXPIRY_SECONDS } from '../../config';
import type { InstanceMutableState } from './types';
import { getAppKey } from './types';
import { storageUpdate } from './state';
import { doWarn, toLoggable } from './log';

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

export function resolveImageRef(state: InstanceMutableState, env: KiloClawEnv): string {
  return `registry.fly.io/${getRegistryApp(env)}:${resolveImageTag(state, env)}`;
}

export function resolveRuntimeImageRef(state: InstanceMutableState, env: KiloClawEnv): string {
  if (state.provider === 'docker-local') {
    return env.DOCKER_LOCAL_IMAGE ?? 'kiloclaw:local';
  }
  return resolveImageRef(state, env);
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
  bootstrapEnv: Record<string, string>;
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
      doWarn(state, 'buildUserEnvVars: failed to mint fresh API key, using stored key', {
        error: toLoggable(err),
      });
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
      googleCredentials: state.googleCredentials ?? undefined,
      kiloExaSearchMode: state.kiloExaSearchMode,
      instanceFeatures: state.instanceFeatures,
      execSecurity: state.execSecurity ?? undefined,
      execAsk: state.execAsk ?? undefined,
      botName: state.botName ?? undefined,
      botNature: state.botNature ?? undefined,
      botVibe: state.botVibe ?? undefined,
      botEmoji: state.botEmoji ?? undefined,
      orgId: state.orgId,
      customSecretMeta: state.customSecretMeta ?? undefined,
    }
  );

  // Inject latest Gmail historyId for controller to patch gog state on startup.
  if (state.gmailLastHistoryId) {
    plainEnv.KILOCLAW_GMAIL_LAST_HISTORY_ID = state.gmailLastHistoryId;
  }

  // Stream Chat default channel (auto-provisioned at first provision).
  // API key and bot user ID are plaintext; bot user token is sensitive.
  if (state.streamChatApiKey && state.streamChatBotUserId && state.streamChatBotUserToken) {
    plainEnv.STREAM_CHAT_API_KEY = state.streamChatApiKey;
    plainEnv.STREAM_CHAT_BOT_USER_ID = state.streamChatBotUserId;
    sensitive.STREAM_CHAT_BOT_USER_TOKEN = state.streamChatBotUserToken;
    if (state.streamChatChannelId) {
      plainEnv.STREAM_CHAT_DEFAULT_CHANNEL_ID = state.streamChatChannelId;
    }
  }

  // Get the env encryption key from the App DO, creating it if needed.
  // Instance-keyed DOs get per-instance apps, legacy DOs get per-user apps.
  const appKey = getAppKey({ userId: state.userId, sandboxId: state.sandboxId });
  const appStub = env.KILOCLAW_APP.get(env.KILOCLAW_APP.idFromName(appKey));
  const { key: envKey, secretsVersion } = await appStub.ensureEnvKey(appKey);

  // Encrypt sensitive values and prefix their names with KILOCLAW_ENC_
  const result: Record<string, string> = { ...plainEnv };
  for (const [name, value] of Object.entries(sensitive)) {
    result[`${ENCRYPTED_ENV_PREFIX}${name}`] = encryptEnvValue(envKey, value);
  }

  return {
    envVars: result,
    bootstrapEnv: {
      KILOCLAW_ENV_KEY: envKey,
    },
    minSecretsVersion: secretsVersion,
  };
}
