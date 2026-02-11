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
 * Layering order:
 * 1. Worker-level shared AI keys (platform defaults)
 * 2. User-provided plaintext env vars (override platform defaults)
 * 3. User-provided encrypted secrets (override env vars on conflict)
 * 4. Decrypted channel tokens (mapped to container env var names)
 * 5. Reserved system vars (cannot be overridden by any user config)
 *
 * @param env - Worker environment bindings
 * @param sandboxId - Per-user sandbox ID
 * @param gatewayTokenSecret - Secret for deriving per-sandbox gateway tokens
 * @param userConfig - User-provided env vars, encrypted secrets, and channel tokens
 * @returns Environment variables record
 */
export async function buildEnvVars(
  env: KiloClawEnv,
  sandboxId: string,
  gatewayTokenSecret: string,
  userConfig?: UserConfig
): Promise<Record<string, string>> {
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
    envVars.ANTHROPIC_BASE_URL = normalizedBaseUrl;
    envVars.ANTHROPIC_API_KEY = env.AI_GATEWAY_API_KEY;
  } else if (env.ANTHROPIC_BASE_URL) {
    envVars.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL;
  }

  if (env.DEV_MODE) envVars.OPENCLAW_DEV_MODE = env.DEV_MODE;
  if (env.CF_AI_GATEWAY_MODEL) envVars.CF_AI_GATEWAY_MODEL = env.CF_AI_GATEWAY_MODEL;
  if (env.CF_ACCOUNT_ID) envVars.CF_ACCOUNT_ID = env.CF_ACCOUNT_ID;

  // Layer 2 + 3: User env vars merged with decrypted secrets.
  if (userConfig) {
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

  // Layer 5: Reserved system vars (cannot be overridden by any user config)
  envVars.OPENCLAW_GATEWAY_TOKEN = await deriveGatewayToken(sandboxId, gatewayTokenSecret);
  envVars.AUTO_APPROVE_DEVICES = 'true';

  return envVars;
}
