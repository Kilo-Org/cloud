/**
 * Queue message types for the cloud-agent execution system.
 *
 * These types define the structure of messages passed through
 * Cloudflare Queues for execution orchestration.
 */

import type { MCPServerConfig, CloudAgentSessionState } from '../persistence/types.js';
import type { AgentMode } from '../schema.js';
import type { ExecutionId, SessionId, UserId } from '../types/ids.js';
import type { EncryptedSecrets } from '../router/schemas.js';

// ---------------------------------------------------------------------------
// Execution Modes
// ---------------------------------------------------------------------------

/** Mode of execution - passed directly to kilocode CLI */
export type ExecutionMode = AgentMode;

/** How the client receives streaming output */
export type StreamingMode = 'sse' | 'websocket';

// ---------------------------------------------------------------------------
// Queue Messages
// ---------------------------------------------------------------------------

/**
 * Context for initializing a new session on first execution.
 * Contains all parameters needed to set up workspace, clone repos, etc.
 */
export type InitializeContext = {
  /** Kilocode authentication token */
  kilocodeToken: string;
  /** Model to use for Kilocode CLI */
  kilocodeModel?: string;
  /** GitHub repository to clone (e.g., "owner/repo") */
  githubRepo?: string;
  /** GitHub Personal Access Token for private repos */
  githubToken?: string;
  /** Generic Git URL to clone */
  gitUrl?: string;
  /** Git token for authentication */
  gitToken?: string;
  /** Environment variables to set in the session (plaintext) */
  envVars?: Record<string, string>;
  /**
   * Encrypted secret env vars from agent environment profiles.
   * Stored encrypted, decrypted only at session execution time.
   */
  encryptedSecrets?: EncryptedSecrets;
  /** Setup commands to run after clone (e.g., npm install) */
  setupCommands?: string[];
  /** MCP server configurations */
  mcpServers?: Record<string, MCPServerConfig>;
  /** Branch to checkout (if not session-specific) */
  upstreamBranch?: string;
  /** Bot ID for sandbox isolation */
  botId?: string;
  /**
   * Existing Kilo session ID (for prepared sessions).
   * When set, the CLI will resume this session instead of creating a new one.
   */
  kiloSessionId?: string;
  /**
   * Flag indicating this is a prepared session (via prepareSession flow).
   * When true, use initiateFromKiloSession instead of initiate,
   * and skip linking (backend already linked during prepareSession).
   */
  isPreparedSession?: boolean;
  /** GitHub App type for selecting correct credentials and slug */
  githubAppType?: 'standard' | 'lite';
  /** Git platform type for correct token/env var handling */
  platform?: 'github' | 'gitlab';
};

/**
 * Queue message for initiating a new execution.
 * Sent when a user submits a prompt for processing.
 */
type ExecutionMessageBase = {
  /** Unique identifier for this execution */
  executionId: ExecutionId;
  /** Session this execution belongs to */
  sessionId: SessionId;
  /** User who initiated the execution */
  userId: UserId;
  /** Organization ID (optional for personal accounts) */
  orgId?: string;
  /** Execution mode */
  mode: ExecutionMode;
  /** User's prompt/task description */
  prompt: string;
  /** Sandbox ID for execution (required for sandbox access) */
  sandboxId: string;
  /** Optional text to append to the system prompt */
  appendSystemPrompt?: string;
};

export type ExecutionMessage = ExecutionMessageBase & {
  /** Plan version for V2 executions */
  planVersion: 'v2';
  /** Pre-computed execution plan for the queue consumer */
  launchPlan: WrapperLaunchPlan;
};

/**
 * Resume context for follow-up executions.
 */
export type ResumeContext = {
  kilocodeToken: string;
  kilocodeModel: string;
  githubToken?: string;
  gitToken?: string;
};

/**
 * Plan describing how the queue consumer should start the wrapper.
 */
export type WrapperLaunchPlan = {
  executionId: ExecutionId;
  sandboxId: string;
  promptFile: string;
  appendSystemPromptFile?: string;
  workspace: {
    shouldPrepare: boolean;
    initContext?: InitializeContext;
    resumeContext?: ResumeContext;
    existingMetadata?: CloudAgentSessionState;
  };
  wrapper: {
    args: string[];
    env: Record<string, string>;
  };
};

/**
 * Request payload for starting a V2 execution.
 */
export type StartExecutionV2Request =
  | {
      kind: 'initiate';
      userId: UserId;
      orgId?: string;
      botId?: string;
      authToken: string;
      prompt: string;
      mode: ExecutionMode;
      model: string;
      githubRepo?: string;
      githubToken?: string;
      gitUrl?: string;
      gitToken?: string;
      envVars?: Record<string, string>;
      encryptedSecrets?: EncryptedSecrets;
      setupCommands?: string[];
      mcpServers?: Record<string, MCPServerConfig>;
      autoCommit?: boolean;
      condenseOnComplete?: boolean;
      upstreamBranch?: string;
      appendSystemPrompt?: string;
      /** Git platform type for correct token/env var handling */
      platform?: 'github' | 'gitlab';
    }
  | {
      kind: 'initiatePrepared';
      userId: UserId;
      botId?: string;
      authToken?: string;
    }
  | {
      kind: 'followup';
      userId: UserId;
      botId?: string;
      prompt: string;
      mode?: ExecutionMode;
      model?: string;
      autoCommit?: boolean;
      condenseOnComplete?: boolean;
      appendSystemPrompt?: string;
      tokenOverrides?: {
        githubToken?: string;
        gitToken?: string;
      };
    };

/**
 * Result of starting a V2 execution.
 */
export type StartExecutionV2Result =
  | {
      success: true;
      executionId: ExecutionId;
      status: 'started' | 'queued';
    }
  | {
      success: false;
      code: 'NOT_FOUND' | 'BAD_REQUEST' | 'INTERNAL';
      error: string;
    };
