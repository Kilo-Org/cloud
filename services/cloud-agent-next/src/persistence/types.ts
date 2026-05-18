import type { SandboxId, SessionId, SessionContext, ExecutionSession } from '../types.js';
import type { Sandbox } from '@cloudflare/sandbox';
import type { CloudAgentSession } from './CloudAgentSession.js';
import type { EncryptedSecrets, MCPSecretValue } from '../router/schemas.js';
import type { CallbackTarget } from '../callbacks/index.js';
import type { Images, SessionProfileBundle, InitialExecutionPayload } from './schemas.js';
import type { SessionIngestBinding } from '../session-ingest-binding.js';

/**
 * Local MCP server configuration (runs a command).
 * Each env value is a plain string or an encrypted envelope; the worker
 * decrypts envelope-shaped values per key when materializing
 * `KILO_CONFIG_CONTENT.mcp` for the sandbox session.
 */
export type MCPLocalServerConfig = {
  type: 'local';
  /** Command to execute — first element is the binary, rest are args */
  command: string[];
  /** Env values: plain strings pass through, envelopes are decrypted per key. */
  environment?: Record<string, MCPSecretValue>;
  /** Whether this server is enabled (default true) */
  enabled?: boolean;
  /** Timeout in milliseconds */
  timeout?: number;
};

/**
 * Remote MCP server configuration (connects to a URL).
 * Each header value is a plain string or an encrypted envelope; the worker
 * decrypts envelope-shaped values per key when materializing
 * `KILO_CONFIG_CONTENT.mcp` for the sandbox session.
 */
export type MCPRemoteServerConfig = {
  type: 'remote';
  /** Server URL */
  url: string;
  /** Header values: plain strings pass through, envelopes are decrypted per key. */
  headers?: Record<string, MCPSecretValue>;
  /** Whether this server is enabled (default true) */
  enabled?: boolean;
  /** Timeout in milliseconds */
  timeout?: number;
};

/**
 * MCP Server configuration — CLI-native local/remote discriminated union
 */
export type MCPServerConfig = MCPLocalServerConfig | MCPRemoteServerConfig;

/**
 * Runtime skill injected from the web app's merged profile stack. `rawMarkdown`
 * is materialized to `${SESSION_HOME}/.kilocode/skills/<name>/SKILL.md`; each
 * entry in `files` is written under the same directory.
 */
export type RuntimeSkill = {
  name: string;
  rawMarkdown: string;
  files?: Record<string, string>;
};

/**
 * Runtime agent injected from the web app's merged profile stack. Stored in
 * the CLI's AgentConfig shape and passed through to
 * `KILO_CONFIG_CONTENT.agent.<slug>` at session preparation time.
 *
 * Permission is typed loosely here to match the zod schema — the web-app
 * service layer does the tight validation before values land in the DO.
 */
export type PermissionAction = 'allow' | 'ask' | 'deny';
export type PermissionConfig = PermissionAction | Record<string, unknown>;

export type RuntimeAgent = {
  slug: string;
  name: string;
  config: {
    prompt?: string;
    description?: string;
    mode?: 'subagent' | 'primary' | 'all';
    model?: string | null;
    variant?: string;
    temperature?: number;
    top_p?: number;
    steps?: number;
    hidden?: boolean;
    disable?: boolean;
    color?: string;
    permission?: PermissionConfig;
    options?: Record<string, unknown>;
  };
};

export type RuntimeKiloCommand = {
  name: string;
  template: string;
  description?: string | null;
  agent?: string | null;
  model?: string | null;
  subtask?: boolean;
};

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
  /** Platform that created this session (e.g. slack, app-builder) */
  createdOnPlatform?: string;
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
  /** Whether the GitLab token was auto-looked up via git-token-service (enables refresh on resume) */
  gitlabTokenManaged?: boolean;
  /**
   * Profile-derived configuration (envVars, encryptedSecrets, setupCommands,
   * mcpServers, runtimeSkills, runtimeAgents). Always written in this nested
   * form; the legacy flat fields below are a read-only compatibility surface
   * for sessions stored before nesting landed. Never access these fields
   * directly — go through `readProfileBundle` to get a normalized bundle.
   */
  profile?: SessionProfileBundle;
  /** @deprecated Legacy flat read-fallback. Use `readProfileBundle(state).envVars`. */
  envVars?: Record<string, string>;
  /** @deprecated Legacy flat read-fallback. Use `readProfileBundle(state).encryptedSecrets`. */
  encryptedSecrets?: EncryptedSecrets;
  /** @deprecated Legacy flat read-fallback. Use `readProfileBundle(state).setupCommands`. */
  setupCommands?: string[];
  /** @deprecated Legacy flat read-fallback. Use `readProfileBundle(state).mcpServers`. */
  mcpServers?: Record<string, MCPServerConfig>;
  /** @deprecated Legacy flat read-fallback. Use `readProfileBundle(state).runtimeSkills`. */
  runtimeSkills?: readonly RuntimeSkill[];
  /** @deprecated Legacy flat read-fallback. Use `readProfileBundle(state).runtimeAgents`. */
  runtimeAgents?: readonly RuntimeAgent[];
  /** @deprecated Legacy flat read-fallback. Use `readProfileBundle(state).kiloCommands`. */
  kiloCommands?: readonly RuntimeKiloCommand[];
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
  variant?: string;
  /** Whether to auto-commit changes */
  autoCommit?: boolean;
  /** Whether to condense context after execution */
  condenseOnComplete?: boolean;
  /** Custom text to append to the system prompt */
  appendSystemPrompt?: string;
  /** PR gate threshold — when not "off", the agent evaluates findings and reports gateResult */
  gateThreshold?: 'off' | 'all' | 'warning' | 'critical';

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

  // Kilo server lifecycle tracking
  /** Timestamp of last kilo server activity (for idle timeout cleanup) */
  kiloServerLastActivity?: number;

  // Workspace metadata (set during prepareSession)
  /** Workspace path where the repo was cloned */
  workspacePath?: string;
  /** Session home directory */
  sessionHome?: string;
  /** Git branch name created for the session */
  branchName?: string;
  /** Sandbox ID where the session runs */
  sandboxId?: SandboxId;

  // Initial message ID for correlation
  initialMessageId?: string;

  // Discriminated payload for the first execution (prompt or command)
  initialPayload?: InitialExecutionPayload;
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
  /** Service binding for the session ingest worker */
  SESSION_INGEST: SessionIngestBinding;
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
  /** Base URL override for OpenRouter-compatible Kilo API */
  KILO_OPENROUTER_BASE?: string;
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

  /** URL for session ingest service, injected into sandbox session env vars */
  KILO_SESSION_INGEST_URL?: string;

  /** Shared secret for internal service-to-service authentication */
  INTERNAL_API_SECRET_PROD: SecretsStoreSecret;

  R2_ENDPOINT?: string;
  R2_ATTACHMENTS_READONLY_ACCESS_KEY_ID?: string;
  R2_ATTACHMENTS_READONLY_SECRET_ACCESS_KEY?: string;
  R2_ATTACHMENTS_BUCKET?: string;
  /** Comma-separated org IDs that use per-session sandbox containers */
  PER_SESSION_SANDBOX_ORG_IDS?: string;
};

// Re-export commonly used types for convenience
export type { SessionContext, SandboxId, SessionId, ExecutionSession };
