import type { KiloClawEnv } from '../types';
import type { EncryptedEnvelope, EncryptedChannelTokens } from '../schemas/instance-config';
import { deriveGatewayToken } from '../auth/gateway-token';
import { mergeEnvVarsWithSecrets, decryptChannelTokens } from '../utils/encryption';
import { validateUserEnvVarName } from '../utils/env-encryption';

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
 * Result of buildEnvVars: split into non-sensitive env vars and sensitive values
 * that will be encrypted before placement in config.env.
 */
export type EnvVarsBuild = {
  /** Non-sensitive vars — placed in config.env as-is. */
  env: Record<string, string>;
  /** Sensitive vars — encrypted and prefixed with KILOCLAW_ENC_ before config.env. */
  sensitive: Record<string, string>;
};

/**
 * Env var names that are always classified as sensitive.
 * Values for these keys go into the `sensitive` bucket.
 */
const SENSITIVE_KEYS = new Set([
  'KILOCODE_API_KEY',
  'OPENCLAW_GATEWAY_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  'DISCORD_BOT_TOKEN',
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
]);

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
 * Returns a split result: non-sensitive vars in `env`, sensitive vars in `sensitive`.
 * User-provided plaintext env vars go to `env` unless they match SENSITIVE_KEYS.
 * User-provided encrypted secrets always go to `sensitive`.
 *
 * @param env - Worker environment bindings
 * @param sandboxId - Per-user sandbox ID
 * @param gatewayTokenSecret - Secret for deriving per-sandbox gateway tokens
 * @param userConfig - User-provided env vars, encrypted secrets, and channel tokens
 * @returns Split env vars: `env` (plaintext) and `sensitive` (to be encrypted)
 */
export async function buildEnvVars(
  env: KiloClawEnv,
  sandboxId: string,
  gatewayTokenSecret: string,
  userConfig?: UserConfig
): Promise<EnvVarsBuild> {
  // Layer 1: Worker-level defaults (non-sensitive)
  const plainEnv: Record<string, string> = {};

  if (env.DEV_MODE) plainEnv.OPENCLAW_DEV_MODE = env.DEV_MODE;
  if (env.KILOCODE_API_BASE_URL) plainEnv.KILOCODE_API_BASE_URL = env.KILOCODE_API_BASE_URL;
  plainEnv.KILOCODE_FEATURE = 'kilo-claw';

  // Collect all sensitive values
  const sensitive: Record<string, string> = {};

  // Layer 2 + 3: User env vars merged with decrypted secrets.
  if (userConfig) {
    // Validate user-provided env var names
    if (userConfig.envVars) {
      for (const name of Object.keys(userConfig.envVars)) {
        validateUserEnvVarName(name);
      }
    }
    if (userConfig.encryptedSecrets) {
      for (const name of Object.keys(userConfig.encryptedSecrets)) {
        validateUserEnvVarName(name);
      }
    }

    const userEnv = mergeEnvVarsWithSecrets(
      userConfig.envVars,
      userConfig.encryptedSecrets,
      env.AGENT_ENV_VARS_PRIVATE_KEY
    );

    // User-provided decrypted secrets are sensitive (they came from encrypted envelopes).
    // User-provided plaintext env vars: classify based on SENSITIVE_KEYS.
    for (const [key, value] of Object.entries(userEnv)) {
      if (SENSITIVE_KEYS.has(key)) {
        sensitive[key] = value;
      } else if (userConfig.encryptedSecrets?.[key]) {
        // Was an encrypted secret — treat as sensitive
        sensitive[key] = value;
      } else {
        plainEnv[key] = value;
      }
    }

    if (userConfig.kilocodeApiKey) {
      sensitive.KILOCODE_API_KEY = userConfig.kilocodeApiKey;
    }
    if (userConfig.kilocodeDefaultModel) {
      plainEnv.KILOCODE_DEFAULT_MODEL = userConfig.kilocodeDefaultModel;
    }
    if (userConfig.kilocodeModels) {
      plainEnv.KILOCODE_MODELS_JSON = JSON.stringify(userConfig.kilocodeModels);
    }

    // Layer 4: Decrypt channel tokens and map to container env var names
    if (userConfig.channels && env.AGENT_ENV_VARS_PRIVATE_KEY) {
      const channelEnv = decryptChannelTokens(userConfig.channels, env.AGENT_ENV_VARS_PRIVATE_KEY);
      // All channel tokens are sensitive
      Object.assign(sensitive, channelEnv);
    }
  }

  // Worker-level passthrough (non-sensitive)
  if (env.TELEGRAM_DM_POLICY) plainEnv.TELEGRAM_DM_POLICY = env.TELEGRAM_DM_POLICY;
  if (env.DISCORD_DM_POLICY) plainEnv.DISCORD_DM_POLICY = env.DISCORD_DM_POLICY;
  if (env.OPENCLAW_ALLOWED_ORIGINS)
    plainEnv.OPENCLAW_ALLOWED_ORIGINS = env.OPENCLAW_ALLOWED_ORIGINS;

  // Layer 5: Reserved system vars (cannot be overridden by any user config)
  sensitive.OPENCLAW_GATEWAY_TOKEN = await deriveGatewayToken(sandboxId, gatewayTokenSecret);
  plainEnv.AUTO_APPROVE_DEVICES = 'true';

  return { env: plainEnv, sensitive };
}
