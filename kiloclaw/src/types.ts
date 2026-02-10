import type { Sandbox } from '@cloudflare/sandbox';

/**
 * Environment bindings for the KiloClaw Worker
 */
export type KiloClawEnv = {
  Sandbox: DurableObjectNamespace<Sandbox>;
  KILOCLAW_BUCKET: R2Bucket;

  // Auth secrets
  NEXTAUTH_SECRET?: string;
  INTERNAL_API_SECRET?: string;
  GATEWAY_TOKEN_SECRET?: string;
  WORKER_ENV?: string; // e.g. 'production' or 'development' -- for JWT env validation

  // Cloudflare AI Gateway configuration (preferred)
  CF_AI_GATEWAY_ACCOUNT_ID?: string;
  CF_AI_GATEWAY_GATEWAY_ID?: string;
  CLOUDFLARE_AI_GATEWAY_API_KEY?: string;
  CF_AI_GATEWAY_MODEL?: string;
  // Legacy AI Gateway configuration (still supported for backward compat)
  AI_GATEWAY_API_KEY?: string;
  AI_GATEWAY_BASE_URL?: string;
  // Direct provider configuration
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
  OPENAI_API_KEY?: string;
  DEV_MODE?: string;
  DEBUG_ROUTES?: string;
  DEBUG_ROUTES_SECRET?: string;
  SANDBOX_SLEEP_AFTER?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_DM_POLICY?: string;
  DISCORD_BOT_TOKEN?: string;
  DISCORD_DM_POLICY?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_APP_TOKEN?: string;
  // R2 credentials for bucket mounting (set via wrangler secret)
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET_NAME?: string;
  CF_ACCOUNT_ID?: string;
};

/**
 * Hono app environment type
 */
export type AppEnv = {
  Bindings: KiloClawEnv;
  Variables: {
    sandbox: Sandbox;
    userId: string;
    authToken: string;
    sandboxId: string;
  };
};
