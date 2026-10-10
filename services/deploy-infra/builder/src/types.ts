import { z } from 'zod';
import type { Sandbox } from '@cloudflare/sandbox';
import type { DeploymentOrchestrator } from './deployment-orchestrator';
import type { EventsManager } from './events-manager';

import type {
  BuildStatus,
  Provider,
  LogPayload,
  StatusChangePayload,
  Event,
  WebhookPayload,
  CancelBuildReason,
  CancelBuildResult,
} from '../../../../apps/web/src/lib/user-deployments/types';

import type { EncryptedEnvVar } from '../../../../apps/web/src/lib/user-deployments/env-vars-validation';

export type {
  BuildStatus,
  Provider,
  LogPayload,
  StatusChangePayload,
  Event,
  WebhookPayload,
  CancelBuildReason,
  CancelBuildResult,
};

export const supportedProjectTypeSchema = z.enum([
  'nextjs',
  'hugo',
  'jekyll',
  'eleventy',
  'astro',
  'plain-html',
]);

export type ProjectType = z.infer<typeof supportedProjectTypeSchema>;

export type DeploymentFile = {
  path: string;
  content: Buffer;
  mimeType: string;
};

export type WorkerMetadata = {
  main_module: string;
  compatibility_date: string;
  compatibility_flags: string[];
  assets?: { jwt: string; config: Record<string, unknown> };
  bindings?: Array<Record<string, unknown>>;
  migrations?: { tag: string; new_classes?: string[] }[];
};

export type DeploymentArtifacts = {
  workerScript: DeploymentFile;
  artifacts: DeploymentFile[];
  assets: DeploymentFile[];
};

export type GitSource = {
  type: 'git';
  provider: Provider;
  /** For github: owner/repo, for git: full URL */
  repoSource: string;
  accessToken?: string;
  branch?: string;
};

export type ArchiveSource = {
  type: 'archive';
};

export type BuildSource = GitSource | ArchiveSource;

export type Build = {
  buildId: string;
  slug: string;
  source?: BuildSource;
  envVars?: EncryptedEnvVar[];
  status: BuildStatus;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  projectType?: ProjectType;
};

export type ArchiveDeployParams = {
  buildId: string;
  slug: string;
  archiveBuffer: Uint8Array;
  envVars?: EncryptedEnvVar[];
};

export type DeliveryState = {
  /** Epoch milliseconds for the next scheduled delivery attempt (0 means no scheduled attempt) */
  nextAttemptAt: number;
  attempt: number;
};

export type Env = {
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;

  SENTRY_DSN: string;
  ENVIRONMENT: string;

  /** RSA private key in PEM format for decrypting secret environment variables */
  ENV_ENCRYPTION_PRIVATE_KEY: string;

  CF_VERSION_METADATA: { id: string; tag: string; timestamp: string };

  BACKEND_AUTH_TOKEN: string;
  DISPATCHER_AUTH_TOKEN: string;

  /** URL endpoint where build events will be sent (REQUIRED) */
  BACKEND_EVENTS_URL: string;

  BACKEND_WEBHOOK_BATCH_MAX_EVENTS?: string;

  BACKEND_WEBHOOK_BATCH_MAX_MS?: string;

  BACKEND_WEBHOOK_BACKOFF_BASE_MS?: string;

  BACKEND_WEBHOOK_STOP_AFTER_ATTEMPTS?: string;

  Sandbox: DurableObjectNamespace<Sandbox>;
  DeploymentOrchestrator: DurableObjectNamespace<DeploymentOrchestrator>;
  EventsManager: DurableObjectNamespace<EventsManager>;

  NEXTAUTH_SECRET: SecretsStoreSecret;
  HYPERDRIVE: Hyperdrive;
  WORKER_ENV: string;
  DEPLOY_HOSTNAME_BASE: string;
  DeployDispatcher: Fetcher;
  HtmlDeployRateLimiter: RateLimit;
};

/** Hono app environment with Worker bindings. */
export type HonoEnv = { Bindings: Env };

export type DeployRequest = {
  slug: string;
  provider: Provider;
  /** For github: owner/repo, for git: full URL */
  repoSource: string;
  accessToken?: string;
  branch?: string;
  /** Optional array of build IDs to cancel before starting new deployment */
  cancelBuildIds?: string[];
  envVars?: EncryptedEnvVar[];
};

export type DeployResponse = {
  buildId: string;
  slug: string;
  status: BuildStatus;
};

export type StatusResponse = {
  status: BuildStatus;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  projectType?: ProjectType;
};

/**
 * Standard Cloudflare API response structure
 */
export type CloudflareApiResponse<T = unknown> = {
  success: boolean;
  result?: T;
  errors?: Array<{ code: number; message: string }>;
};

export type HtmlDeployResponse = {
  slug: string;
  url: string;
  expires_at: string;
};
