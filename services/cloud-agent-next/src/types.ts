import type { getSandbox, ExecutionSession, Sandbox } from '@cloudflare/sandbox';
import type { CloudAgentSession } from './persistence/CloudAgentSession.js';
import type { CallbackJob } from './callbacks/index.js';
import type { SessionIngestBinding } from './session-ingest-binding.js';
import * as z from 'zod';
import { Limits } from './schema.js';
import { SESSION_ID_RE } from './shared/protocol.js';

export const sessionIdSchema = z.string().regex(SESSION_ID_RE, 'Invalid session ID format');

export const githubRepoSchema = z
  .string()
  .regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, 'Invalid repository format');

export const gitUrlSchema = z
  .string()
  .url()
  .refine(url => url.startsWith('https://'), 'Only HTTPS URLs are supported');

export const RESERVED_ENV_VARS = ['HOME', 'SESSION_ID', 'SESSION_HOME'] as const;

export const envVarsSchema = z
  .record(
    z.string().max(Limits.MAX_ENV_VAR_KEY_LENGTH),
    z.string().max(Limits.MAX_ENV_VAR_VALUE_LENGTH)
  )
  .refine(obj => Object.keys(obj).length <= Limits.MAX_ENV_VARS, {
    message: `Maximum ${Limits.MAX_ENV_VARS} environment variables allowed`,
  })
  .refine(
    obj => {
      const keys = Object.keys(obj);
      return !keys.some(key => (RESERVED_ENV_VARS as readonly string[]).includes(key));
    },
    {
      message: `Cannot set reserved environment variables: ${RESERVED_ENV_VARS.join(', ')}. These are managed by the system.`,
    }
  );

export type SandboxInstance = ReturnType<typeof getSandbox>;

/** Cloudflare Session instance for executing commands within a sandbox */
export type { ExecutionSession };

/** Unique identifier for a sandbox (container). Covers hash-based prefixes, per-session IDs, and legacy `__`-delimited formats. */
export type SandboxId =
  | `org-${string}`
  | `usr-${string}`
  | `bot-${string}`
  | `ubt-${string}`
  | `ses-${string}`
  | `${string}__${string}`
  | `${string}__${string}__${string}`;

/** Unique identifier for a session within a sandbox */
export type SessionId = `agent_${string}`;

export type SessionContext = {
  sandboxId: SandboxId;
  sessionId: SessionId;
  sessionHome: string;
  workspacePath: string;
  branchName: string;
  /** Upstream branch requested by the user (if any) */
  upstreamBranch?: string;
  orgId?: string;
  userId: string;
  botId?: string;
  githubRepo?: string;
  githubToken?: string;
  /** Generic git URL (e.g., GitLab, Bitbucket) */
  gitUrl?: string;
  /** Token for generic git authentication (e.g., GitLab token) */
  gitToken?: string;
  /** Git platform type for correct token/env var handling */
  platform?: 'github' | 'gitlab';
  envVars?: Record<string, string>;
};
/** Result of interrupting a session's running processes */
export type InterruptResult = {
  success: boolean;
  message: string;
  /** Whether matching processes were found by pkill/sandbox API */
  processesFound: boolean;
};

export type Env = {
  Sandbox: DurableObjectNamespace<Sandbox>;
  /** Durable Object namespace for per-session sandbox containers (standard-2, experimental) */
  SandboxSmall: DurableObjectNamespace<Sandbox>;
  /** Durable Object namespace for CloudAgentSession metadata (SQLite-backed) with RPC support */
  CLOUD_AGENT_SESSION: DurableObjectNamespace<CloudAgentSession>;
  /** Service binding for the session ingest worker */
  SESSION_INGEST: SessionIngestBinding;
  /** Shared secret for internal service-to-service authentication */
  INTERNAL_API_SECRET_PROD: SecretsStoreSecret;
  /** R2 bucket for storing session logs */
  R2_BUCKET: R2Bucket;
  /** Queue for callback messages (optional - supports incremental rollout) */
  CALLBACK_QUEUE?: Queue<CallbackJob>;
  /** KV namespace for caching GitHub installation tokens */
  GITHUB_TOKEN_CACHE?: KVNamespace;
  /** GitHub App ID for token generation */
  GITHUB_APP_ID?: string;
  /** GitHub App private key (PEM format) for token generation */
  GITHUB_APP_PRIVATE_KEY?: string;
  /** GitHub Lite App ID for read-only token generation */
  GITHUB_LITE_APP_ID?: string;
  /** GitHub Lite App private key (PEM format) for read-only token generation */
  GITHUB_LITE_APP_PRIVATE_KEY?: string;
  /** GitHub Lite App slug for git commit attribution (e.g., 'kiloconnect-lite') */
  GITHUB_LITE_APP_SLUG?: string;
  /** GitHub Lite App bot user ID for git commit email */
  GITHUB_LITE_APP_BOT_USER_ID?: string;
  /** Shared secret for JWT token validation */
  NEXTAUTH_SECRET: string;
  /** Comma-separated list of allowed Origins for /stream WebSocket connections */
  WS_ALLOWED_ORIGINS?: string;
  /** Backend base URL (used for balance checks before session spin-up) */
  KILOCODE_BACKEND_BASE_URL?: string;
  /** Base URL override for OpenRouter-compatible Kilo API */
  KILO_OPENROUTER_BASE?: string;
  /** Kilocode CLI timeout override (seconds) */
  CLI_TIMEOUT_SECONDS?: string;
  /** Reaper interval override (ms) */
  REAPER_INTERVAL_MS?: string;
  /** Execution stale threshold override (ms) */
  STALE_THRESHOLD_MS?: string;
  /** Pending execution start timeout override (ms) */
  PENDING_START_TIMEOUT_MS?: string;
  /** Kilo server idle timeout override (ms) - defaults to 15 minutes */
  KILO_SERVER_IDLE_TIMEOUT_MS?: string;
  /** Shared secret for backend-to-backend authentication (prepareSession/updateSession) */
  INTERNAL_API_SECRET?: string;
  /** Worker base URL for building WebSocket ingest endpoint */
  WORKER_URL?: string;
  /**
   * RSA private key for decrypting encrypted secrets from agent environment profiles.
   * Required when using encryptedSecrets feature. PEM format (base64-encoded).
   */
  AGENT_ENV_VARS_PRIVATE_KEY?: string;
  /**
   * Hyperdrive binding for PostgreSQL connection pooling.
   * Used for looking up GitHub installation IDs from the database.
   */
  HYPERDRIVE?: { connectionString: string };
  /** GitHub App slug for git commit attribution (e.g., 'kiloconnect') */
  GITHUB_APP_SLUG?: string;
  /** GitHub App bot user ID for git commit email (e.g., '240665456') */
  GITHUB_APP_BOT_USER_ID?: string;
  /** Comma-separated org IDs that use per-session sandbox containers */
  PER_SESSION_SANDBOX_ORG_IDS?: string;
};

/** tRPC context passed to all procedures */
export type TRPCContext = {
  env: Env;
  userId: string;
  request: Request;
  authToken: string;
  botId?: string;
};

export type SystemSandboxUsageEvent = {
  streamEventType: 'sandbox-usage';
  availableMB: number;
  totalMB: number;
  isLow: boolean;
  timestamp: string;
  sessionId?: string;
};
