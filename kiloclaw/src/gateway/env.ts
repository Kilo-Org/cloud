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
  kilocodeApiKey?: string | null;
  kilocodeDefaultModel?: string | null;
  kilocodeModels?: Array<{ id: string; name: string }> | null;
  channels?: EncryptedChannelTokens;
};

/**
 * Build environment variables to pass to the OpenClaw container process.
 *
 * Layering order:
 * 1. Worker-level defaults
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
  // Layer 1: Worker-level defaults
  const envVars: Record<string, string> = {};

  if (env.DEV_MODE) envVars.OPENCLAW_DEV_MODE = env.DEV_MODE;
  if (env.KILOCODE_API_BASE_URL) envVars.KILOCODE_API_BASE_URL = env.KILOCODE_API_BASE_URL;
  if (env.CF_ACCOUNT_ID) envVars.CF_ACCOUNT_ID = env.CF_ACCOUNT_ID;

  // Layer 2 + 3: User env vars merged with decrypted secrets.
  if (userConfig) {
    const userEnv = mergeEnvVarsWithSecrets(
      userConfig.envVars,
      userConfig.encryptedSecrets,
      env.AGENT_ENV_VARS_PRIVATE_KEY
    );
    Object.assign(envVars, userEnv);

    if (userConfig.kilocodeApiKey) {
      envVars.KILOCODE_API_KEY = userConfig.kilocodeApiKey;
    }
    if (userConfig.kilocodeDefaultModel) {
      envVars.KILOCODE_DEFAULT_MODEL = userConfig.kilocodeDefaultModel;
    }

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
