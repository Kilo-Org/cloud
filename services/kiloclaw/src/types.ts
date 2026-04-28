import type { KiloClawInstance } from './durable-objects/kiloclaw-instance';
import type { KiloClawApp } from './durable-objects/kiloclaw-app';
import type { KiloClawRegistry } from './durable-objects/kiloclaw-registry';
import type { SnapshotRestoreMessage } from './schemas/snapshot-restore';
import type { KiloClawBillingBinding } from './kiloclaw-billing-binding';
import type { KiloChatBinding } from './kilo-chat-binding';

/**
 * Environment bindings for the KiloClaw Worker
 */
export type KiloClawEnv = {
  KILOCLAW_INSTANCE: DurableObjectNamespace<KiloClawInstance>;
  KILOCLAW_APP: DurableObjectNamespace<KiloClawApp>;
  KILOCLAW_REGISTRY: DurableObjectNamespace<KiloClawRegistry>;
  KILOCLAW_BILLING?: KiloClawBillingBinding;
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
  KILOCLAW_INTERNAL_API_SECRET?: string;
  GATEWAY_TOKEN_SECRET?: string;
  GOOGLE_WORKSPACE_OAUTH_CLIENT_ID?: string;
  GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET?: string;
  GOOGLE_WORKSPACE_REFRESH_TOKEN_ENCRYPTION_KEY?: string;
  WORKER_ENV?: string; // e.g. 'production' or 'development' -- for JWT env validation
  KILOCLAW_DEFAULT_PROVIDER?: string;

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

  // Northflank configuration
  NF_API_TOKEN?: string;
  NF_API_BASE?: string;
  NF_TEAM_ID?: string;
  NF_REGION?: string;
  NF_DEPLOYMENT_PLAN?: string;
  NF_STORAGE_CLASS_NAME?: string;
  NF_STORAGE_ACCESS_MODE?: string;
  NF_VOLUME_SIZE_MB?: string;
  NF_EPHEMERAL_STORAGE_MB?: string;
  NF_EDGE_HEADER_NAME?: string;
  NF_EDGE_HEADER_VALUE?: string;
  NF_IMAGE_PATH_TEMPLATE?: string;
  NF_IMAGE_CREDENTIALS_ID?: string;

  DOCKER_LOCAL_API_BASE?: string;
  DOCKER_LOCAL_IMAGE?: string;
  DOCKER_LOCAL_PORT_RANGE?: string;

  // Developer identity (development only, auto-populated by dev-start from `fly auth whoami`)
  DEV_CREATOR?: string;

  // Stream Chat (default channel for new instances)
  STREAM_CHAT_API_KEY?: string;
  STREAM_CHAT_API_SECRET?: string;

  // OpenClaw gateway configuration
  OPENCLAW_ALLOWED_ORIGINS?: string;
  KILOCLAW_CHECKIN_URL?: string;
  REQUIRE_PROXY_TOKEN?: string;

  /** Base URL of the kilo-chat worker for bot HTTP routes. */
  KILOCHAT_BASE_URL?: string;

  /** Service binding to the kilo-chat worker (RPC for destroySandboxData etc.). */
  KILO_CHAT?: KiloChatBinding;

  // PostHog product telemetry
  NEXT_PUBLIC_POSTHOG_KEY?: string;

  // Tuning overrides (wrangler vars)
  /** Override proactive API key refresh threshold (hours). Default: 72 (3 days). */
  PROACTIVE_REFRESH_THRESHOLD_HOURS?: string;
};

import type { z } from 'zod';
import type { chatWebhookRpcSchema } from '@kilocode/kilo-chat';

/**
 * Payload for kilo-chat webhook delivery via service binding RPC.
 * The shared schema lives in `@kilocode/kilo-chat/webhook-schemas`.
 */
export type ChatWebhookPayload = z.infer<typeof chatWebhookRpcSchema>;

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
