import type { Env, SandboxId, SessionId, SessionContext, ExecutionSession } from '../types.js';

import type { MCPSecretValue } from '../router/schemas.js';
import type { SessionMetadata } from './session-metadata.js';

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

/**
 * Instruction file injected from the web app's merged profile stack. Each entry
 * is materialized to `${SESSION_HOME}/.kilocode/rules/<name>.md` at session
 * preparation time, alongside the Cloud-Agent-owned `cloud-agent.md`.
 */
export type RuntimeInstruction = {
  name: string;
  content: string;
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

export type PersistenceEnv = Pick<
  Env,
  | 'SANDBOX_SESSION'
  | 'NEXTAUTH_SECRET'
  | 'GIT_TOKEN_SERVICE'
  | 'KILOCODE_BACKEND_BASE_URL'
  | 'KILO_OPENROUTER_BASE'
  | 'KILOCODE_ORG_ID_OVERRIDE'
>;

// Re-export commonly used types for convenience
export type { SessionContext, SandboxId, SessionId, ExecutionSession };
