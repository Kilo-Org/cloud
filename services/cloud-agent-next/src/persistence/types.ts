import type { SandboxId, SessionId, SessionContext, ExecutionSession } from '../types.js';
import type { Sandbox } from '@cloudflare/sandbox';
import type { CloudAgentSession } from './CloudAgentSession.js';
import type { MCPSecretValue } from '../router/schemas.js';
import type { SessionMetadata } from './session-metadata.js';
import type { SessionIngestBinding } from '../session-ingest-binding.js';
import type { NotificationsBinding } from '../notifications-binding.js';
import type { GitTokenService } from '../types.js';

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

export type CloudAgentSessionState = SessionMetadata;

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
  /** Worker base URL for building wrapper ingest WebSocket endpoints */
  WORKER_URL?: string;

  /** Shared secret for internal service-to-service authentication */
  INTERNAL_API_SECRET_PROD: SecretsStoreSecret;

  R2_ENDPOINT?: string;
  R2_ATTACHMENTS_READONLY_ACCESS_KEY_ID?: string;
  R2_ATTACHMENTS_READONLY_SECRET_ACCESS_KEY?: string;
  R2_ATTACHMENTS_BUCKET?: string;
  /** Comma-separated org IDs that use per-session sandbox containers */
  PER_SESSION_SANDBOX_ORG_IDS?: string;
  /** Service binding for centralized git token generation */
  GIT_TOKEN_SERVICE?: GitTokenService;
  /** Service binding for dispatching push notifications */
  NOTIFICATIONS: NotificationsBinding;
};

// Re-export commonly used types for convenience
export type { SessionContext, SandboxId, SessionId, ExecutionSession };
