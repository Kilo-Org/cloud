import type {
  VercelCreateIntent,
  VercelWrapperLaunchIntent,
} from './vercel/vercel-runtime-state.js';

/**
 * Durable, provider-tagged intents recorded by the owning session before it
 * mutates remote provider state, so interrupted operations reconcile instead
 * of leaking runtimes. Providers whose runtimes are created through remote
 * APIs without idempotency keys contribute one union member each; providers
 * with locally addressed runtimes (Cloudflare) never record intents.
 */
export type SandboxCreateIntentInput = {
  provider: 'vercel';
  sandboxName: string;
  projectId: string;
  snapshotId: string;
  runtimeBuildId: string;
  runtime: VercelCreateIntent['runtime'];
};

export type SandboxCreateIntent = VercelCreateIntent;

export type SandboxProviderRuntimeInput = {
  provider: 'vercel';
  sessionId: string;
  projectId: string;
  snapshotId: string;
  runtimeBuildId: string;
  runtime: VercelCreateIntent['runtime'];
};

export type SandboxWrapperLaunchIntent = VercelWrapperLaunchIntent;
