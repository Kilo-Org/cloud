import type { KiloClawInstance } from './durable-objects/kiloclaw-instance';
import type { KiloClawApp } from './durable-objects/kiloclaw-app';

/**
 * Environment bindings for the KiloClaw Worker
 */
export type KiloClawEnv = {
  KILOCLAW_INSTANCE: DurableObjectNamespace<KiloClawInstance>;
  KILOCLAW_APP: DurableObjectNamespace<KiloClawApp>;
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
  FLY_APP_NAME?: string; // Legacy: fallback for existing instances without per-user apps
  FLY_ORG_SLUG?: string; // Org for creating new per-user Fly apps
  FLY_REGISTRY_APP?: string; // Shared app for Docker image registry
  FLY_REGION?: string;
  FLY_IMAGE_TAG?: string;

  // OpenClaw gateway configuration
  OPENCLAW_ALLOWED_ORIGINS?: string;
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
