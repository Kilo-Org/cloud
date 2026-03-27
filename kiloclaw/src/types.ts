import type { KiloClawInstance } from './durable-objects/kiloclaw-instance';
import type { KiloClawApp } from './durable-objects/kiloclaw-app';
import type { SnapshotRestoreMessage } from './schemas/snapshot-restore';

/**
 * Environment bindings for the KiloClaw Worker
 */
export type KiloClawEnv = {
  KILOCLAW_INSTANCE: DurableObjectNamespace<KiloClawInstance>;
  KILOCLAW_APP: DurableObjectNamespace<KiloClawApp>;
  KILOCLAW_AE?: AnalyticsEngineDataset;
  KILOCLAW_CONTROLLER_AE: AnalyticsEngineDataset;
  HYPERDRIVE?: Hyperdrive;
  KV_CLAW_CACHE: KVNamespace;
  SNAPSHOT_RESTORE_QUEUE?: Queue<SnapshotRestoreMessage>;

  // Backend app origin for internal API calls (e.g. instance-ready email)
  BACKEND_API_URL?: string;

  // Auth secrets
  NEXTAUTH_SECRET?: string;
  INTERNAL_API_SECRET?: string;
  GATEWAY_TOKEN_SECRET?: string;
  WORKER_ENV?: string; // e.g. 'production' or 'development' -- for JWT env validation

  // KiloCode provider configuration
  KILOCODE_API_BASE_URL?: string;
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
  FLY_IMAGE_DIGEST?: string;
  OPENCLAW_VERSION?: string;

  // Stream Chat (default channel for new instances)
  STREAM_CHAT_API_KEY?: string;
  STREAM_CHAT_API_SECRET?: string;

  // OpenClaw gateway configuration
  OPENCLAW_ALLOWED_ORIGINS?: string;
  KILOCLAW_CHECKIN_URL?: string;
  REQUIRE_PROXY_TOKEN?: string;

  // PostHog product telemetry
  NEXT_PUBLIC_POSTHOG_KEY?: string;

  // Tuning overrides (wrangler vars)
  /** Override proactive API key refresh threshold (hours). Default: 72 (3 days). */
  PROACTIVE_REFRESH_THRESHOLD_HOURS?: string;
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
    requestStartTime: number;
  };
};
