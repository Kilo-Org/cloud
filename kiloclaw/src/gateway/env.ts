import type { KiloClawEnv } from '../types';
import type { EncryptedEnvelope, EncryptedChannelTokens } from '../schemas/instance-config';
import { deriveGatewayToken } from '../auth/gateway-token';
import { mergeEnvVarsWithSecrets, decryptChannelTokens } from '../utils/encryption';

/**
 * User-provided configuration for building container environment variables.
 * Stored in the KiloClawInstance DO, passed to buildEnvVars at start time.
 */
export type UserConfig = {
  envVars?: Record<string, string>;
  encryptedSecrets?: Record<string, EncryptedEnvelope>;
  channels?: EncryptedChannelTokens;
};

/**
 * Build environment variables to pass to the OpenClaw container process.
 *
 * Two modes:
 * - **Shared sandbox** (no sandboxId): passes worker-level env vars including
 *   channel tokens. Used by the catch-all proxy's ensureOpenClawGateway().
 * - **Multi-tenant** (sandboxId + gatewayTokenSecret): derives a per-sandbox
 *   gateway token, merges user-provided env vars and decrypted secrets,
 *   decrypts and maps channel tokens, and sets AUTO_APPROVE_DEVICES.
 *
 * Layering order (multi-tenant):
 * 1. Worker-level shared AI keys (platform defaults)
 * 2. User-provided plaintext env vars (override platform defaults)
 * 3. User-provided encrypted secrets (override env vars on conflict)
 * 4. Decrypted channel tokens (mapped to container env var names)
 * 5. Reserved system vars (cannot be overridden by any user config)
 *
 * @param env - Worker environment bindings
 * @param sandboxId - Per-user sandbox ID (multi-tenant path)
 * @param gatewayTokenSecret - Secret for deriving per-sandbox gateway tokens
 * @param userConfig - User-provided env vars, encrypted secrets, and channel tokens
 * @returns Environment variables record
 */
export async function buildEnvVars(
  env: KiloClawEnv,
  sandboxId?: string,
  gatewayTokenSecret?: string,
  userConfig?: UserConfig
): Promise<Record<string, string>> {
  // Per-user path (DO start): both sandboxId and secret are present.
  // Legacy shared-sandbox path (catch-all proxy): neither is passed.
  // Remove this flag when PR7 eliminates the shared-sandbox catch-all.
  const isPerUserPath = Boolean(sandboxId && gatewayTokenSecret);

  // Layer 1: Worker-level shared AI keys (platform defaults)
  const envVars: Record<string, string> = {};

  // Cloudflare AI Gateway configuration (new native provider)
  if (env.CLOUDFLARE_AI_GATEWAY_API_KEY) {
    envVars.CLOUDFLARE_AI_GATEWAY_API_KEY = env.CLOUDFLARE_AI_GATEWAY_API_KEY;
  }
  if (env.CF_AI_GATEWAY_ACCOUNT_ID) {
    envVars.CF_AI_GATEWAY_ACCOUNT_ID = env.CF_AI_GATEWAY_ACCOUNT_ID;
  }
  if (env.CF_AI_GATEWAY_GATEWAY_ID) {
    envVars.CF_AI_GATEWAY_GATEWAY_ID = env.CF_AI_GATEWAY_GATEWAY_ID;
  }

  // Direct provider keys
  if (env.ANTHROPIC_API_KEY) envVars.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
  if (env.OPENAI_API_KEY) envVars.OPENAI_API_KEY = env.OPENAI_API_KEY;

  // Legacy AI Gateway support: AI_GATEWAY_BASE_URL + AI_GATEWAY_API_KEY
  // When set, these override direct keys for backward compatibility
  if (env.AI_GATEWAY_API_KEY && env.AI_GATEWAY_BASE_URL) {
    const normalizedBaseUrl = env.AI_GATEWAY_BASE_URL.replace(/\/+$/, '');
    envVars.AI_GATEWAY_BASE_URL = normalizedBaseUrl;
    // Legacy path routes through Anthropic base URL
    envVars.ANTHROPIC_BASE_URL = normalizedBaseUrl;
    envVars.ANTHROPIC_API_KEY = env.AI_GATEWAY_API_KEY;
  } else if (env.ANTHROPIC_BASE_URL) {
    envVars.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL;
  }

  if (env.DEV_MODE) envVars.OPENCLAW_DEV_MODE = env.DEV_MODE;
  if (env.CF_AI_GATEWAY_MODEL) envVars.CF_AI_GATEWAY_MODEL = env.CF_AI_GATEWAY_MODEL;
  if (env.CF_ACCOUNT_ID) envVars.CF_ACCOUNT_ID = env.CF_ACCOUNT_ID;

  // Channel tokens: only pass worker-level tokens in shared-sandbox mode.
  // In multi-tenant mode, channel tokens come from the user's encrypted config.
  if (!isPerUserPath) {
    if (env.TELEGRAM_BOT_TOKEN) envVars.TELEGRAM_BOT_TOKEN = env.TELEGRAM_BOT_TOKEN;
    if (env.TELEGRAM_DM_POLICY) envVars.TELEGRAM_DM_POLICY = env.TELEGRAM_DM_POLICY;
    if (env.DISCORD_BOT_TOKEN) envVars.DISCORD_BOT_TOKEN = env.DISCORD_BOT_TOKEN;
    if (env.DISCORD_DM_POLICY) envVars.DISCORD_DM_POLICY = env.DISCORD_DM_POLICY;
    if (env.SLACK_BOT_TOKEN) envVars.SLACK_BOT_TOKEN = env.SLACK_BOT_TOKEN;
    if (env.SLACK_APP_TOKEN) envVars.SLACK_APP_TOKEN = env.SLACK_APP_TOKEN;
  }

  // Multi-tenant: merge user config on top of platform defaults
  if (isPerUserPath && userConfig) {
    // Layer 2 + 3: User env vars merged with decrypted secrets.
    // Secrets override plaintext env vars on conflict.
    const userEnv = mergeEnvVarsWithSecrets(
      userConfig.envVars,
      userConfig.encryptedSecrets,
      env.AGENT_ENV_VARS_PRIVATE_KEY
    );
    Object.assign(envVars, userEnv);

    // Layer 4: Decrypt channel tokens and map to container env var names
    if (userConfig.channels && env.AGENT_ENV_VARS_PRIVATE_KEY) {
      const channelEnv = decryptChannelTokens(userConfig.channels, env.AGENT_ENV_VARS_PRIVATE_KEY);
      Object.assign(envVars, channelEnv);
    }
  }

  // Layer 5: Reserved system vars for multi-tenant mode (cannot be overridden)
  if (sandboxId && gatewayTokenSecret) {
    envVars.OPENCLAW_GATEWAY_TOKEN = await deriveGatewayToken(sandboxId, gatewayTokenSecret);
    envVars.AUTO_APPROVE_DEVICES = 'true';
  }

  return envVars;
}
