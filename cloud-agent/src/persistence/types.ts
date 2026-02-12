import type { SandboxId, SessionId, SessionContext, ExecutionSession } from '../types.js';
import type { Sandbox } from '@cloudflare/sandbox';
import type { CloudAgentSession } from './CloudAgentSession.js';
import type { EncryptedSecrets } from '../router/schemas.js';
import type { CallbackTarget } from '../callbacks/index.js';
import type { Images } from './schemas.js';

/**
 * Base configuration shared by all MCP server types
 */
export type BaseConfig = {
  /** Whether this server is disabled */
  disabled?: boolean;
  /** Timeout in seconds (1-3600), default 60 */
  timeout?: number;
  /** Tools that are always allowed without user confirmation */
  alwaysAllow?: string[];
  /** File paths to watch for changes */
  watchPaths?: string[];
  /** Tools that should be disabled */
  disabledTools?: string[];
};

/**
 * Stdio-based MCP server configuration (local process)
 */
export type StdioServerConfig = BaseConfig & {
  /** Transport type - defaults to stdio */
  type?: 'stdio';
  /** Command to execute */
  command: string;
  /** Command arguments */
  args?: string[];
  /** Working directory for the command */
  cwd?: string;
  /** Environment variables for the command */
  env?: Record<string, string>;
};

/**
 * SSE-based MCP server configuration (Server-Sent Events)
 */
export type SseServerConfig = BaseConfig & {
  /** Transport type */
  type: 'sse';
  /** Server URL */
  url: string;
  /** HTTP headers */
  headers?: Record<string, string>;
};

/**
 * Streamable HTTP-based MCP server configuration
 */
export type StreamableHttpServerConfig = BaseConfig & {
  /** Transport type */
  type: 'streamable-http';
  /** Server URL */
  url: string;
  /** HTTP headers */
  headers?: Record<string, string>;
};

/**
 * MCP Server configuration - discriminated union of three transport types
 */
export type MCPServerConfig = StdioServerConfig | SseServerConfig | StreamableHttpServerConfig;

export type CloudAgentSessionState = {
  /** Current version timestamp (for cache invalidation) */
  version: number;
  /** Session identifier (e.g., agent_abc-123) */
  sessionId: string;
  /** Organization ID (optional for personal accounts) */
  orgId?: string;
  /** User ID */
  userId: string;
  /** Bot/service identifier (if token is for a bot) */
  botId?: string;
  /** Kilocode authentication token for CLI (stored securely, never exposed in getSession) */
  kilocodeToken?: string;
  /** Last save timestamp */
  timestamp: number;
  /** GitHub repository (e.g., 'facebook/react') */
  githubRepo?: string;
  /** GitHub token for private repos */
  githubToken?: string;
  /** GitHub App installation ID for token generation */
  githubInstallationId?: string;
  /** GitHub App type: 'standard' for full KiloConnect, 'lite' for read-only KiloConnect-Lite */
  githubAppType?: 'standard' | 'lite';
  /** Generic git repository URL (full HTTPS URL, e.g., 'https://gitlab.com/org/repo.git') */
  gitUrl?: string;
  /** Git token for authentication (username is always 'x-access-token') */
  gitToken?: string;
  /** Git platform type for correct token/env var handling */
  platform?: 'github' | 'gitlab';
  /** Environment variables to inject into sandbox execution sessions (plaintext) */
  envVars?: Record<string, string>;
  /**
   * Encrypted secret env vars from agent environment profiles.
   * Stored encrypted in DO, decrypted only at execution time when injected into CLI.
   * Keys are env var names, values are encrypted envelopes.
   */
  encryptedSecrets?: EncryptedSecrets;
  /** Installation commands to run on init/resume */
  setupCommands?: string[];
  /** MCP server configurations written to .kilocode/cli/global/setting/mcp_settings.json */
  mcpServers?: Record<string, MCPServerConfig>;
  /** Upstream branch to checkout when cloning the repo */
  upstreamBranch?: string;
  /** Kilo CLI session ID for continuation (from session_created event) */
  kiloSessionId?: string;

  // Execution params (for prepareSession flow)
  /** The prompt/task to execute */
  prompt?: string;
  /** The mode to use (e.g., 'code', 'architect') */
  mode?: string;
  /** The model to use */
  model?: string;
  /** Whether to auto-commit changes */
  autoCommit?: boolean;
  /** Whether to condense context after execution */
  condenseOnComplete?: boolean;
  /** Custom text to append to the system prompt */
  appendSystemPrompt?: string;

  // Lifecycle timestamps (for state machine)
  /** Timestamp when session was prepared (state machine: prepared) */
  preparedAt?: number;
  /** Timestamp when session execution started (state machine: initiated) */
  initiatedAt?: number;

  // Callback configuration
  /** Optional callback target for execution completion notifications */
  callbackTarget?: CallbackTarget;

  // Image attachments
  /** Optional image attachments to download from R2 to the sandbox */
  images?: Images;
};

/**
 * Result type for atomic DO operations with success/error feedback.
 */
export type OperationResult<T = void> = {
  success: boolean;
  error?: string;
  data?: T;
};

export type PersistenceEnv = {
  /** Durable Object namespace for Sandbox instances */
  Sandbox: DurableObjectNamespace<Sandbox>;
  /** Durable Object namespace for CloudAgentSession metadata (SQLite-backed) with RPC support */
  CLOUD_AGENT_SESSION: DurableObjectNamespace<CloudAgentSession>;
  /** Shared secret for JWT token validation */
  NEXTAUTH_SECRET: string;
  /** Comma-separated list of allowed Origins for /stream WebSocket connections */
  WS_ALLOWED_ORIGINS?: string;
  /** Optional override for Kilocode token injected into session environment (does not affect authentication) */
  KILOCODE_TOKEN_OVERRIDE?: string;
  /** Optional override for Kilocode org ID injected into session environment (does not affect authentication) */
  KILOCODE_ORG_ID_OVERRIDE?: string;
  /** Backend base URL for API calls and session environment variables (defaults to https://kilo.ai) */
  KILOCODE_BACKEND_BASE_URL?: string;
  /** Kilocode CLI timeout override (seconds) */
  CLI_TIMEOUT_SECONDS?: string;
  /** GitHub App slug for git commit attribution (e.g., 'kiloconnect') */
  GITHUB_APP_SLUG?: string;
  /** GitHub App bot user ID for git commit email (e.g., '240665456') */
  GITHUB_APP_BOT_USER_ID?: string;
  /** GitHub Lite App slug for git commit attribution (e.g., 'kiloconnect-lite') */
  GITHUB_LITE_APP_SLUG?: string;
  /** GitHub Lite App bot user ID for git commit email */
  GITHUB_LITE_APP_BOT_USER_ID?: string;
  /**
   * RSA private key for decrypting encrypted secrets from agent environment profiles.
   * Required when using encryptedSecrets feature. PEM format.
   */
  AGENT_ENV_VARS_PRIVATE_KEY?: string;

  R2_ENDPOINT?: string;
  R2_ATTACHMENTS_READONLY_ACCESS_KEY_ID?: string;
  R2_ATTACHMENTS_READONLY_SECRET_ACCESS_KEY?: string;
  R2_ATTACHMENTS_BUCKET?: string;
};

// Re-export commonly used types for convenience
export type { SessionContext, SandboxId, SessionId, ExecutionSession };
