/**
 * Types for the cloud-agent execution system.
 *
 * This module defines the core types for direct execution without queuing.
 * The key insight is that executionId === messageId for correlation.
 *
 * NOTE: Queue-specific types (ExecutionMessage, WrapperLaunchPlan) have been removed
 * as part of the migration to direct execution.
 */

import type { ExecutionId, SessionId, UserId } from '../types/ids.js';
import type { AgentMode } from '../schema.js';
import type { Images, EncryptedSecrets as SchemaEncryptedSecrets } from '../router/schemas.js';
import type { EncryptedSecrets } from '../utils/encryption.js';
import type { MCPServerConfig } from '../persistence/types.js';

// ---------------------------------------------------------------------------
// Execution Modes
// ---------------------------------------------------------------------------

/** Mode of execution - passed directly to kilocode CLI */
export type ExecutionMode = AgentMode;

/** How the client receives streaming output */
export type StreamingMode = 'sse' | 'websocket';

// ---------------------------------------------------------------------------
// Token Resume Context (for DO token management)
// ---------------------------------------------------------------------------

/**
 * Resume context for follow-up executions (token management).
 * Used by CloudAgentSession DO for managing authentication tokens.
 */
export type TokenResumeContext = {
  kilocodeToken: string;
  kilocodeModel: string;
  githubToken?: string;
  gitToken?: string;
};

// ---------------------------------------------------------------------------
// Initialize Context (for session initialization)
// ---------------------------------------------------------------------------

/**
 * Context for initializing a new session on first execution.
 * Contains all parameters needed to set up workspace, clone repos, etc.
 * Used by CloudAgentSession DO for the initiate flow.
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
  encryptedSecrets?: SchemaEncryptedSecrets;
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
};

// ---------------------------------------------------------------------------
// V2 Request/Response Types (for DO methods and tRPC handlers)
// ---------------------------------------------------------------------------

/**
 * Common fields shared by all execution request types.
 */
type BaseExecutionRequest = {
  userId: UserId;
  botId?: string;
};

/**
 * Request for initiating a new session (full initialization).
 */
type InitiateExecutionRequest = BaseExecutionRequest & {
  kind: 'initiate';
  authToken: string;
  prompt: string;
  mode: ExecutionMode;
  model: string;
  githubRepo?: string;
  githubToken?: string;
  gitUrl?: string;
  gitToken?: string;
  envVars?: Record<string, string>;
  encryptedSecrets?: SchemaEncryptedSecrets;
  setupCommands?: string[];
  mcpServers?: Record<string, MCPServerConfig>;
  autoCommit?: boolean;
  condenseOnComplete?: boolean;
  upstreamBranch?: string;
  orgId?: string;
};

/**
 * Request for initiating a prepared session.
 */
type InitiatePreparedRequest = BaseExecutionRequest & {
  kind: 'initiatePrepared';
  authToken?: string;
};

/**
 * Request for follow-up message on existing session.
 */
type FollowupExecutionRequest = BaseExecutionRequest & {
  kind: 'followup';
  prompt: string;
  mode?: ExecutionMode;
  model?: string;
  autoCommit?: boolean;
  condenseOnComplete?: boolean;
  tokenOverrides?: {
    githubToken?: string;
    gitToken?: string;
  };
};

/**
 * Request payload for starting a V2 execution.
 */
export type StartExecutionV2Request =
  | InitiateExecutionRequest
  | InitiatePreparedRequest
  | FollowupExecutionRequest;

/**
 * Retryable error codes that map to 503 Service Unavailable.
 * These match the TransientErrorResponse schema.
 */
export type RetryableResultCode =
  | 'SANDBOX_CONNECT_FAILED'
  | 'WORKSPACE_SETUP_FAILED'
  | 'KILO_SERVER_FAILED'
  | 'WRAPPER_START_FAILED';

/**
 * Result of starting a V2 execution.
 * Returns 409 Conflict if an execution is already in progress.
 *
 * Error codes:
 * - EXECUTION_IN_PROGRESS: 409 Conflict (another execution is running)
 * - SANDBOX_CONNECT_FAILED, WORKSPACE_SETUP_FAILED, KILO_SERVER_FAILED, WRAPPER_START_FAILED: 503 Service Unavailable
 * - NOT_FOUND: 404 Not Found
 * - BAD_REQUEST: 400 Bad Request
 * - INTERNAL: 500 Internal Server Error
 */
export type StartExecutionV2Result =
  | {
      success: true;
      executionId: ExecutionId;
      status: 'started';
    }
  | {
      success: false;
      code:
        | 'NOT_FOUND'
        | 'BAD_REQUEST'
        | 'INTERNAL'
        | 'EXECUTION_IN_PROGRESS'
        | RetryableResultCode;
      error: string;
      /** For EXECUTION_IN_PROGRESS, the currently active execution ID */
      activeExecutionId?: ExecutionId;
    };

// ---------------------------------------------------------------------------
// Workspace Plan
// ---------------------------------------------------------------------------

/**
 * Context needed to resume an existing workspace (no clone needed).
 */
export type ResumeContext = {
  kiloSessionId: string;
  workspacePath: string;
  kilocodeToken: string;
  kilocodeModel?: string;
  branchName: string;
  /** GitHub token for token refresh (optional) */
  githubToken?: string;
  /** Git token for non-GitHub repos (optional) */
  gitToken?: string;
};

/**
 * Context for initializing a new workspace.
 */
export type InitContext = {
  githubRepo?: string;
  gitUrl?: string;
  githubToken?: string;
  gitToken?: string;
  envVars?: Record<string, string>;
  setupCommands?: string[];
  upstreamBranch?: string;
  kiloSessionId?: string;
  isPreparedSession?: boolean;
  /** Kilocode API token */
  kilocodeToken: string;
  /** Kilocode model to use */
  kilocodeModel?: string;
  /** Encrypted secrets for agent environment profiles */
  encryptedSecrets?: EncryptedSecrets;
  /** MCP server configurations */
  mcpServers?: Record<string, MCPServerConfig>;
  /** Bot ID for bot-specific sessions */
  botId?: string;
  /** GitHub app type for determining which app to use */
  githubAppType?: 'lite' | 'standard';
};

/**
 * Existing metadata for prepared sessions.
 */
export type ExistingSessionMetadata = {
  workspacePath: string;
  kiloSessionId: string;
  branchName: string;
  sandboxId?: string;
  sessionHome?: string;
  upstreamBranch?: string;
  appendSystemPrompt?: string;
  /** GitHub repo (for token updates) */
  githubRepo?: string;
  /** Git URL (for token updates) */
  gitUrl?: string;
};

/**
 * Plan for workspace preparation.
 * Determines whether to resume existing workspace or set up new one.
 */
export type WorkspacePlan =
  | {
      shouldPrepare: false;
      sandboxId: string;
      resumeContext: ResumeContext;
      existingMetadata?: ExistingSessionMetadata;
    }
  | {
      shouldPrepare: true;
      sandboxId?: string;
      initContext: InitContext;
      existingMetadata?: ExistingSessionMetadata;
    };

// ---------------------------------------------------------------------------
// Wrapper Plan
// ---------------------------------------------------------------------------

/**
 * Model configuration for the AI model to use.
 */
export type ModelConfig = {
  providerID?: string;
  modelID: string;
};

/**
 * Plan for wrapper execution.
 */
export type WrapperPlan = {
  kiloSessionId?: string;
  kiloSessionTitle?: string;
  model?: ModelConfig;
  autoCommit?: boolean;
  condenseOnComplete?: boolean;
};

// ---------------------------------------------------------------------------
// Execution Plan
// ---------------------------------------------------------------------------

/**
 * Complete plan for executing a prompt.
 * Contains all information needed to set up and execute.
 */
export type ExecutionPlan = {
  /** Unique execution ID (msg_<uuid> format, same as messageId) */
  executionId: ExecutionId;
  /** Cloud-agent session ID */
  sessionId: SessionId;
  /** User who owns this execution */
  userId: UserId;
  /** Organization ID (optional) */
  orgId?: string;
  /** The prompt to execute */
  prompt: string;
  /** Execution mode */
  mode: AgentMode;
  /** Workspace preparation plan */
  workspace: WorkspacePlan;
  /** Wrapper configuration plan */
  wrapper: WrapperPlan;
  /** Optional image attachments */
  images?: Images;
};

// ---------------------------------------------------------------------------
// Execution Result
// ---------------------------------------------------------------------------

/**
 * Result of starting an execution.
 * Note: This is returned immediately after the prompt is sent.
 * Actual completion is tracked via SSE events.
 */
export type ExecutionResult = {
  /** Message ID from wrapper.prompt() - same as executionId */
  messageId: string;
  /** Kilo session ID (created or resumed) */
  kiloSessionId: string;
};
