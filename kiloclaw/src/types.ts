import type { KiloClawInstance } from './durable-objects/kiloclaw-instance';

/**
 * Environment bindings for the KiloClaw Worker
 */
export type KiloClawEnv = {
  KILOCLAW_INSTANCE: DurableObjectNamespace<KiloClawInstance>;
  HYPERDRIVE: Hyperdrive;

  // Auth secrets
  NEXTAUTH_SECRET?: string;
  INTERNAL_API_SECRET?: string;
  GATEWAY_TOKEN_SECRET?: string;
  WORKER_ENV?: string; // e.g. 'production' or 'development' -- for JWT env validation

  // KiloCode provider configuration
  KILOCODE_API_BASE_URL?: string;
  DEV_MODE?: string;
  DEBUG_ROUTES?: string;
  DEBUG_ROUTES_SECRET?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_DM_POLICY?: string;
  DISCORD_BOT_TOKEN?: string;
  DISCORD_DM_POLICY?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_APP_TOKEN?: string;
  // Encryption (for user secrets)
  AGENT_ENV_VARS_PRIVATE_KEY?: string;

  // Fly.io configuration
  FLY_API_TOKEN?: string;
  FLY_APP_NAME?: string;
  FLY_REGION?: string;
};

/**
 * Hono app environment type
 */
export type AppEnv = {
  Bindings: KiloClawEnv;
  Variables: {
    userId: string;
    authToken: string;
    sandboxId: string;
  };
};
