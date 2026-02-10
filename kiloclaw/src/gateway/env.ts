import type { KiloClawEnv } from '../types';
import { deriveGatewayToken } from '../auth/gateway-token';

/**
 * Build environment variables to pass to the OpenClaw container process.
 *
 * Two modes:
 * - **Shared sandbox** (no sandboxId): passes worker-level env vars including
 *   channel tokens. Used by the catch-all proxy's ensureOpenClawGateway().
 * - **Multi-tenant** (sandboxId + gatewayTokenSecret): derives a per-sandbox
 *   gateway token, sets AUTO_APPROVE_DEVICES, and skips worker-level channel
 *   tokens (those come from the user's config in PR5).
 *
 * @param env - Worker environment bindings
 * @param sandboxId - Per-user sandbox ID (multi-tenant path)
 * @param gatewayTokenSecret - Secret for deriving per-sandbox gateway tokens
 * @returns Environment variables record
 */
export async function buildEnvVars(
  env: KiloClawEnv,
  sandboxId?: string,
  gatewayTokenSecret?: string
): Promise<Record<string, string>> {
  const envVars: Record<string, string> = {};
  // Per-user path (DO start): both sandboxId and secret are present.
  // Legacy shared-sandbox path (catch-all proxy): neither is passed.
  // Remove this flag when PR7 eliminates the shared-sandbox catch-all.
  const isPerUserPath = Boolean(sandboxId && gatewayTokenSecret);

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
  // In multi-tenant mode, channel tokens come from the user's encrypted config (PR5).
  if (!isPerUserPath) {
    if (env.TELEGRAM_BOT_TOKEN) envVars.TELEGRAM_BOT_TOKEN = env.TELEGRAM_BOT_TOKEN;
    if (env.TELEGRAM_DM_POLICY) envVars.TELEGRAM_DM_POLICY = env.TELEGRAM_DM_POLICY;
    if (env.DISCORD_BOT_TOKEN) envVars.DISCORD_BOT_TOKEN = env.DISCORD_BOT_TOKEN;
    if (env.DISCORD_DM_POLICY) envVars.DISCORD_DM_POLICY = env.DISCORD_DM_POLICY;
    if (env.SLACK_BOT_TOKEN) envVars.SLACK_BOT_TOKEN = env.SLACK_BOT_TOKEN;
    if (env.SLACK_APP_TOKEN) envVars.SLACK_APP_TOKEN = env.SLACK_APP_TOKEN;
  }

  // Reserved system vars for multi-tenant mode (cannot be overridden by user env vars)
  if (sandboxId && gatewayTokenSecret) {
    envVars.OPENCLAW_GATEWAY_TOKEN = await deriveGatewayToken(sandboxId, gatewayTokenSecret);
    envVars.AUTO_APPROVE_DEVICES = 'true';
  }

  return envVars;
}
