import type { KiloClawInstance } from './durable-objects/kiloclaw-instance';
import type { KiloClawApp } from './durable-objects/kiloclaw-app';
import type { KiloClawRegistry } from './durable-objects/kiloclaw-registry';
import type { SnapshotRestoreMessage } from './schemas/snapshot-restore';

/**
 * Environment bindings for the KiloClaw Worker
 */
export type KiloClawEnv = {
  KILOCLAW_INSTANCE: DurableObjectNamespace<KiloClawInstance>;
  KILOCLAW_APP: DurableObjectNamespace<KiloClawApp>;
  KILOCLAW_REGISTRY: DurableObjectNamespace<KiloClawRegistry>;
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

  // KiloChat channel plugin.
  // Outbound traffic goes plugin → controller proxy → kiloclaw Worker (this
  // worker!) → kilo-chat via service binding, authenticated by the
  // per-sandbox gateway token. No shared token crosses the internet.
  /** Enable the kilo-chat channel on new/restarted machines. "true" to enable. */
  KILOCHAT_ENABLED?: string;
  /** Reaction feature level forwarded to the plugin's channel config. */
  KILOCHAT_REACTION_LEVEL?: string;

  /**
   * Service binding to the kilo-chat worker. Used by /api/kilo-chat/* routes
   * to dispatch bot operations via RPC after verifying the caller's
   * per-sandbox gateway token. The method signatures are duplicated in
   * worker-configuration.d.ts and here because AppEnv uses this manual type
   * rather than the generated Env.
   */
  KILOCHAT?: Fetcher & {
    botCreateMessage(params: {
      sandboxId: string;
      conversationId: string;
      content: Array<{ type: string; [key: string]: unknown }>;
      inReplyToMessageId?: string;
    }): Promise<
      | { ok: true; messageId: string; version: number }
      | {
          ok: false;
          code: 'forbidden' | 'internal' | 'invalid_sandbox';
          error: string;
        }
    >;
    botEditMessage(params: {
      sandboxId: string;
      conversationId: string;
      messageId: string;
      content: Array<{ type: string; [key: string]: unknown }>;
      version: number;
    }): Promise<
      | { ok: true; conflict: false; messageId: string; version: number }
      | { ok: true; conflict: true; messageId: string; version: number }
      | {
          ok: false;
          code: 'forbidden' | 'not_found' | 'internal' | 'invalid_sandbox';
          error: string;
        }
    >;
    botDeleteMessage(params: {
      sandboxId: string;
      conversationId: string;
      messageId: string;
    }): Promise<
      | { ok: true }
      | {
          ok: false;
          code: 'forbidden' | 'not_found' | 'internal' | 'invalid_sandbox';
          error: string;
        }
    >;
    botAddReaction(params: {
      sandboxId: string;
      conversationId: string;
      messageId: string;
      emoji: string;
    }): Promise<
      | { ok: true; id: string; added: boolean }
      | {
          ok: false;
          code: 'forbidden' | 'internal' | 'invalid_sandbox';
          error: string;
        }
    >;
    botRemoveReaction(params: {
      sandboxId: string;
      conversationId: string;
      messageId: string;
      emoji: string;
    }): Promise<
      | { ok: true }
      | {
          ok: false;
          code: 'forbidden' | 'internal' | 'invalid_sandbox';
          error: string;
        }
    >;
    botSendTyping(params: {
      sandboxId: string;
      conversationId: string;
    }): Promise<{ ok: true } | { ok: false; code: 'forbidden' | 'invalid_sandbox'; error: string }>;
  };

  // PostHog product telemetry
  NEXT_PUBLIC_POSTHOG_KEY?: string;

  // Tuning overrides (wrangler vars)
  /** Override proactive API key refresh threshold (hours). Default: 72 (3 days). */
  PROACTIVE_REFRESH_THRESHOLD_HOURS?: string;
};

/**
 * Payload for kilo-chat webhook delivery via service binding RPC.
 */
export type ChatWebhookPayload = {
  targetBotId: string;
  conversationId: string;
  messageId: string;
  from: string;
  text: string;
  sentAt: string;
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
