/**
 * Type definitions for deployment artifacts and job state.
 */

import { z } from 'zod';
import type { Sandbox } from '@cloudflare/sandbox';
import type { DeploymentOrchestrator } from './deployment-orchestrator';
import type { EventsManager } from './events-manager';

// Import and re-export shared types from backend
import type {
  BuildStatus,
  Provider,
  LogPayload,
  StatusChangePayload,
  Event,
  WebhookPayload,
  CancelBuildReason,
  CancelBuildResult,
} from '../../../src/lib/user-deployments/types';

import type { EncryptedEnvVar } from '../../../src/lib/user-deployments/env-vars-validation';

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

/**
 * Zod schema for supported project types
 * - nextjs: Next.js application (uses OpenNext pipeline)
 * - hugo: Hugo static site generator (uses Hugo binary)
 * - jekyll: Jekyll static site generator (uses Ruby/Bundler)
 * - eleventy: Eleventy/11ty static site generator (uses Node.js)
 * - plain-html: Plain HTML site (index.html in root)
 */
export const supportedProjectTypeSchema = z.enum([
  'nextjs',
  'hugo',
  'jekyll',
  'eleventy',
  'astro',
  'plain-html',
]);

export type ProjectType = z.infer<typeof supportedProjectTypeSchema>;

/**
 * Represents a file to be deployed
 */
export type DeploymentFile = {
  /** Relative path of the file */
  path: string;
  /** File content */
  content: Buffer;
  /** MIME type of the file */
  mimeType: string;
};

/**
 * Worker metadata for Cloudflare deployment
 */
export type WorkerMetadata = {
  /** Main module entry point */
  main_module: string;
  /** Compatibility date for the worker */
  compatibility_date: string;
  /** Compatibility flags for the worker */
  compatibility_flags: string[];
  /** Asset configuration with JWT and config */
  assets?: { jwt: string; config: Record<string, unknown> };
  /** Worker bindings (e.g., KV, Durable Objects, Assets) */
  bindings?: Array<Record<string, unknown>>;
  /** Durable Object migrations */
  migrations?: { tag: string; new_classes?: string[] }[];
};

/**
 * Artifacts needed for worker deployment
 */
export type DeploymentArtifacts = {
  /** Worker script content */
  workerScript: DeploymentFile;
  /** Additional artifact files (empty array if no artifacts) */
  artifacts: DeploymentFile[];
  /** Asset files (empty array if no assets) */
  assets: DeploymentFile[];
};

/**
 * Git repository source for deployment
 */
export type GitSource = {
  type: 'git';
  provider: Provider;
  /** For github: owner/repo, for git: full URL */
  repoSource: string;
  accessToken?: string;
  branch?: string;
};

/**
 * Archive source for deployment
 */
export type ArchiveSource = {
  type: 'archive';
};

/**
 * Source for deployment - either a git repository or an archive
 */
export type BuildSource = GitSource | ArchiveSource;

/**
 * Build
 */
export type Build = {
  buildId: string;
  slug: string;
  source?: BuildSource;
  envVars?: EncryptedEnvVar[];
  status: BuildStatus;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  /** Detected project type (set after detection phase) */
  projectType?: ProjectType;
};

/**
 * Request params for starting deployment from archive
 */
export type ArchiveDeployParams = {
  buildId: string;
  slug: string;
  archiveBuffer: Uint8Array;
  envVars?: EncryptedEnvVar[];
};

/**
 * Webhook delivery state tracking (persisted to durable storage).
 */
export type DeliveryState = {
  /** Epoch milliseconds for the next scheduled delivery attempt (0 means no scheduled attempt) */
  nextAttemptAt: number;
  /** Number of consecutive delivery failures for exponential backoff calculation */
  attempt: number;
};

/**
 * Environment bindings for the worker
 */
export type Env = {
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;

  SENTRY_DSN: string;
  ENVIRONMENT: string;

  /** RSA private key in PEM format for decrypting secret environment variables */
  ENV_ENCRYPTION_PRIVATE_KEY: string;

  /** Cloudflare version metadata binding */
  CF_VERSION_METADATA: { id: string; tag: string; timestamp: string };

  BACKEND_AUTH_TOKEN: string;

  /** URL endpoint where build events will be sent (REQUIRED) */
  BACKEND_EVENTS_URL: string;

  /** Maximum number of events to batch before sending (default: 50) */
  BACKEND_WEBHOOK_BATCH_MAX_EVENTS?: string;

  /** Maximum time in milliseconds to wait before sending a batch (default: 3000) */
  BACKEND_WEBHOOK_BATCH_MAX_MS?: string;

  /** Base backoff time in milliseconds for retry attempts (default: 2000) */
  BACKEND_WEBHOOK_BACKOFF_BASE_MS?: string;

  /** Maximum number of attempts before giving up (default: 10) */
  BACKEND_WEBHOOK_STOP_AFTER_ATTEMPTS?: string;

  Sandbox: DurableObjectNamespace<Sandbox>;
  DeploymentOrchestrator: DurableObjectNamespace<DeploymentOrchestrator>;
  EventsManager: DurableObjectNamespace<EventsManager>;
};

/**
 * Request body for POST /deploy
 */
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

/**
 * Response for POST /deploy
 */
export type DeployResponse = {
  buildId: string;
  slug: string;
  status: BuildStatus;
};

/**
 * Response for GET /deploy/:buildId/status
 */
export type StatusResponse = {
  status: BuildStatus;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  /** Detected project type (available after build detection phase) */
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
