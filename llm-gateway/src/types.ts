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

  // Vars
  ENVIRONMENT: string;

  // Version metadata
  CF_VERSION_METADATA: { id: string; tag: string; timestamp: string };
};

export type HonoEnv = { Bindings: Env };

export type AppType = Hono<HonoEnv>;
