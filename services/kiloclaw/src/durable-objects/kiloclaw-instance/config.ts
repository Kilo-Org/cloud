import { signKiloToken, withTimeout } from '@kilocode/worker-utils';
import type { PersistedState } from '../../schemas/instance-config';
import type { KiloClawEnv } from '../../types';
import { buildEnvVars } from '../../gateway/env';
import { ENCRYPTED_ENV_PREFIX, encryptEnvValue } from '../../utils/env-encryption';
import { findPepperByUserId, getWorkerDb } from '../../db';
import { KILOCODE_API_KEY_EXPIRY_SECONDS } from '../../config';
import { resolveLatestVersion, resolveVersionByTag } from '../../lib/image-version';
import { lookupCatalogVersion } from '../../lib/catalog-registration';
import { ImageVariantSchema } from '../../schemas/image-version';
import { setupDefaultStreamChatChannel } from '../../stream-chat/client';
import type { InstanceMutableState } from './types';
import { getAppKey } from './types';
import { storageUpdate } from './state';
import { doWarn, doLog, doError, toLoggable } from './log';

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

export type ResolvedImageVersion = {
  openclawVersion: string;
  variant: string;
  imageTag: string;
  imageDigest: string | null;
};

export async function resolveAndPersistImageVersion(
  env: KiloClawEnv,
  state: InstanceMutableState,
  opts:
    | { pinnedImageTag: string }
    | { latest: true; clearOnMiss?: boolean }
    | { imageTag: string },
  persist: (patch: Partial<PersistedState>) => Promise<void>
): Promise<ResolvedImageVersion | null> {
  if ('pinnedImageTag' in opts) {
    let pinned = await resolveVersionByTag(env.KV_CLAW_CACHE, opts.pinnedImageTag);

    if (!pinned && !env.HYPERDRIVE?.connectionString) {
      doError(state, 'HYPERDRIVE not configured — cannot look up pinned tag in Postgres', {
        pinnedImageTag: opts.pinnedImageTag,
      });
    }
    if (!pinned && env.HYPERDRIVE?.connectionString) {
      try {
        const catalogEntry = await lookupCatalogVersion(
          env.HYPERDRIVE.connectionString,
          opts.pinnedImageTag
        );
        if (catalogEntry) {
          const variantParse = ImageVariantSchema.safeParse(catalogEntry.variant);
          if (!variantParse.success) {
            doError(state, 'Invalid variant from Postgres catalog, skipping', {
              variant: catalogEntry.variant,
              pinnedImageTag: opts.pinnedImageTag,
              validationErrors: variantParse.error.flatten(),
            });
          } else {
            pinned = {
              openclawVersion: catalogEntry.openclawVersion,
              variant: variantParse.data,
              imageTag: catalogEntry.imageTag,
              imageDigest: catalogEntry.imageDigest,
              publishedAt: catalogEntry.publishedAt,
            };
          }
        }
      } catch (err) {
        doWarn(state, 'Failed to look up pinned tag in Postgres', {
          error: toLoggable(err),
        });
      }
    }

    if (pinned) {
      state.openclawVersion = pinned.openclawVersion;
      state.imageVariant = pinned.variant;
      state.trackedImageTag = pinned.imageTag;
      state.trackedImageDigest = pinned.imageDigest;
      await persist({
        openclawVersion: pinned.openclawVersion,
        imageVariant: pinned.variant,
        trackedImageTag: pinned.imageTag,
        trackedImageDigest: pinned.imageDigest,
      });
      return {
        openclawVersion: pinned.openclawVersion,
        variant: pinned.variant,
        imageTag: pinned.imageTag,
        imageDigest: pinned.imageDigest,
      };
    }

    state.openclawVersion = null;
    state.imageVariant = null;
    state.trackedImageTag = opts.pinnedImageTag;
    state.trackedImageDigest = null;
    await persist({
      openclawVersion: null,
      imageVariant: null,
      trackedImageTag: opts.pinnedImageTag,
      trackedImageDigest: null,
    });
    return null;
  }

  if ('latest' in opts) {
    const latest = await resolveLatestVersion(env.KV_CLAW_CACHE, 'default');
    if (latest) {
      state.openclawVersion = latest.openclawVersion;
      state.imageVariant = latest.variant;
      state.trackedImageTag = latest.imageTag;
      state.trackedImageDigest = latest.imageDigest;
      await persist({
        openclawVersion: latest.openclawVersion,
        imageVariant: latest.variant,
        trackedImageTag: latest.imageTag,
        trackedImageDigest: latest.imageDigest,
      });
      return {
        openclawVersion: latest.openclawVersion,
        variant: latest.variant,
        imageTag: latest.imageTag,
        imageDigest: latest.imageDigest,
      };
    }

    if (opts.clearOnMiss) {
      state.openclawVersion = null;
      state.imageVariant = null;
      state.trackedImageTag = null;
      state.trackedImageDigest = null;
      await persist({
        openclawVersion: null,
        imageVariant: null,
        trackedImageTag: null,
        trackedImageDigest: null,
      });
    }

    return null;
  }

  state.openclawVersion = null;
  state.imageVariant = null;
  state.trackedImageTag = opts.imageTag;
  state.trackedImageDigest = null;
  await persist({
    openclawVersion: null,
    imageVariant: null,
    trackedImageTag: opts.imageTag,
    trackedImageDigest: null,
  });
  return null;
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
      instanceFeatures: state.instanceFeatures,
      execSecurity: state.execSecurity ?? undefined,
      execAsk: state.execAsk ?? undefined,
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

  return { envVars: result, minSecretsVersion: secretsVersion };
}

export type StreamChatRuntime = {
  env: KiloClawEnv;
  state: InstanceMutableState;
  persist: (patch: Partial<PersistedState>) => Promise<void>;
  logLabel: string;
};

/**
 * Backfill Stream Chat channel for instances created before the feature was added.
 * setupDefaultStreamChatChannel is idempotent (upsert users, getOrCreate channel).
 * Failure is non-fatal.
 */
export async function ensureStreamChatChannel(
  runtime: StreamChatRuntime,
  sandboxId: string
): Promise<void> {
  const { env, state, persist, logLabel } = runtime;

  if (
    state.streamChatApiKey ||
    !env.STREAM_CHAT_API_KEY ||
    !env.STREAM_CHAT_API_SECRET
  ) {
    return;
  }

  try {
    const streamChat = await setupDefaultStreamChatChannel(
      env.STREAM_CHAT_API_KEY,
      env.STREAM_CHAT_API_SECRET,
      sandboxId
    );
    state.streamChatApiKey = streamChat.apiKey;
    state.streamChatBotUserId = streamChat.botUserId;
    state.streamChatBotUserToken = streamChat.botUserToken;
    state.streamChatChannelId = streamChat.channelId;
    await persist({
      streamChatApiKey: streamChat.apiKey,
      streamChatBotUserId: streamChat.botUserId,
      streamChatBotUserToken: streamChat.botUserToken,
      streamChatChannelId: streamChat.channelId,
    });
    doLog(state, `${logLabel} Stream Chat channel backfilled`, {
      channelId: streamChat.channelId,
    });
  } catch (err) {
    doWarn(state, `${logLabel} Stream Chat channel backfill failed (non-fatal)`, {
      error: toLoggable(err),
    });
  }
}
