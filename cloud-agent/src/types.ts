import type { getSandbox, ExecutionSession, Sandbox } from '@cloudflare/sandbox';
import type { CloudAgentSession } from './persistence/CloudAgentSession.js';
import type { ExecutionMessage } from './queue/types.js';
import type { CallbackJob } from './callbacks/index.js';
import * as z from 'zod';
import { Limits } from './schema.js';

export const sessionIdSchema = z
  .string()
  .regex(
    /^agent_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    'Invalid session ID format'
  );

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

/** Unique identifier for a sandbox (container) per organizationId-userId pair, with optional bot suffix */
export type SandboxId = `${string}__${string}` | `${string}__${string}__${string}`;

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
  envVars?: Record<string, string>;
};
/** Result of interrupting a session's running processes */
export type InterruptResult = {
  success: boolean;
  killedProcessIds: string[];
  failedProcessIds: string[];
  message: string;
};

export type TokenPayload = {
  kiloUserId: string;
  apiTokenPepper: string;
  version: number;
  env: string;
  botId?: string;
};

export type Env = {
  Sandbox: DurableObjectNamespace<Sandbox>;
  /** Durable Object namespace for CloudAgentSession metadata (SQLite-backed) with RPC support */
  CLOUD_AGENT_SESSION: DurableObjectNamespace<CloudAgentSession>;
  /** Queue for execution messages (WebSocket streaming) */
  EXECUTION_QUEUE: Queue<ExecutionMessage>;
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
  /** Wrapper idle timeout override (ms) */
  WRAPPER_IDLE_TIMEOUT_MS?: string;
  /** Kilocode CLI timeout override (seconds) */
  CLI_TIMEOUT_SECONDS?: string;
  /** Reaper interval override (ms) */
  REAPER_INTERVAL_MS?: string;
  /** Execution stale threshold override (ms) */
  STALE_THRESHOLD_MS?: string;
  /** Pending execution start timeout override (ms) */
  PENDING_START_TIMEOUT_MS?: string;
  /** Shared secret for backend-to-backend authentication (prepareSession/updateSession) */
  INTERNAL_API_SECRET?: string;
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
};

/** tRPC context passed to all procedures */
export type TRPCContext = {
  env: Env;
  userId: string;
  request: Request;
  authToken: string;
  botId?: string;
};

// Streaming event types

/**
 * Raw Kilocode CLI event - preserved exactly as received from stdout JSON.
 * These events come directly from the Kilocode CLI and may contain any fields.
 */
export type KilocodeEvent = Record<string, unknown>;

/**
 * System events use streamEventType discriminator to avoid collision with Kilocode's type field.
 * These are internal events generated by the streaming infrastructure.
 */
export type SystemStatusEvent = {
  streamEventType: 'status';
  message: string;
  timestamp: string;
  sessionId?: string;
};

export type SystemOutputEvent = {
  streamEventType: 'output';
  content: string;
  source: 'stdout' | 'stderr';
  timestamp: string;
  sessionId?: string;
};

export type SystemErrorEvent = {
  streamEventType: 'error';
  error: string;
  details?: unknown;
  timestamp: string;
  sessionId?: string;
};

export type SystemCompleteEvent = {
  streamEventType: 'complete';
  sessionId: string;
  exitCode: number;
  metadata: {
    executionTimeMs: number;
    workspace: string;
    userId: string;
    startedAt: string;
    completedAt: string;
  };
};

export type SystemKilocodeEvent = {
  streamEventType: 'kilocode';
  payload: KilocodeEvent;
  sessionId?: string;
};

export type SystemInterruptedEvent = {
  streamEventType: 'interrupted';
  reason: string;
  timestamp: string;
  sessionId?: string;
};

export type SystemSandboxUsageEvent = {
  streamEventType: 'sandbox-usage';
  availableMB: number;
  totalMB: number;
  isLow: boolean;
  timestamp: string;
  sessionId?: string;
};

/**
 * Union of all streaming event types.
 * All events now use streamEventType discriminator - Kilocode CLI events are wrapped in SystemKilocodeEvent.
 */
export type StreamEvent =
  | SystemKilocodeEvent
  | SystemStatusEvent
  | SystemOutputEvent
  | SystemErrorEvent
  | SystemCompleteEvent
  | SystemInterruptedEvent
  | SystemSandboxUsageEvent;
