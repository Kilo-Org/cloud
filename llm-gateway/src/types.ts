import type { Hono } from 'hono';

export type Env = {
  // Hyperdrive binding for Postgres
  HYPERDRIVE: Hyperdrive;

  // KV binding for BYOK cache
  BYOK_CACHE: KVNamespace;

  // Secrets
  NEXTAUTH_SECRET: string;
  OPENROUTER_API_KEY: string;
  SENTRY_DSN: string;
  BYOK_ENCRYPTION_KEY: string;
  VERCEL_AI_GATEWAY_API_KEY: string;

  // Abuse service
  ABUSE_SERVICE_URL: string;
  ABUSE_SERVICE_CF_ACCESS_CLIENT_ID: string;
  ABUSE_SERVICE_CF_ACCESS_CLIENT_SECRET: string;

  // Observability
  POSTHOG_API_KEY: string;
  O11Y_SERVICE_URL: string;
  O11Y_CLIENT_SECRET: string;

  // Vars
  ENVIRONMENT: string;

  // Version metadata
  CF_VERSION_METADATA: { id: string; tag: string; timestamp: string };
};

export type HonoEnv = { Bindings: Env };

export type AppType = Hono<HonoEnv>;
