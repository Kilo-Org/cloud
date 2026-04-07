/**
 * Types for the cloud-agent execution system.
 *
 * This module defines the core types for direct execution without queuing.
 *
 * NOTE: Queue-specific types (ExecutionMessage, WrapperLaunchPlan) have been removed
 * as part of the migration to direct execution.
 */

import type { ExecutionId, SessionId, UserId } from '../types/ids.js';
import type { AgentMode } from '../schema.js';
import type { Images, EncryptedSecrets as SchemaEncryptedSecrets } from '../router/schemas.js';
import type { EncryptedSecrets } from '../utils/encryption.js';
import type { MCPServerConfig } from '../persistence/types.js';
import type { SandboxId } from '../types.js';

// ---------------------------------------------------------------------------
// Execution Modes
// ---------------------------------------------------------------------------

/** Mode of execution - passed directly to kilocode CLI */
export type ExecutionMode = AgentMode;

/** How the client receives streaming output */
export type StreamingMode = 'sse' | 'websocket';

// ---------------------------------------------------------------------------
// Shared Composite Types
// ---------------------------------------------------------------------------

/**
 * Git repository source — discriminated union.
 * Replaces the flat githubRepo/githubToken/gitUrl/gitToken/platform fields
 * that were duplicated across 8+ types.
 */
export type GitSource =
  | { platform: 'github'; githubRepo: string; token?: string }
  | { platform: 'gitlab'; url: string; token?: string };

/**
 * Kilo authentication credentials.
 * Replaces the repeated kilocodeToken + kilocodeModel pair.
 */
export type KiloAuth = {
  kilocodeToken: string;
  kilocodeModel?: string;
};

/**
 * Workspace identity — the stable reference for where code lives.
 * These 4 fields always travel together.
 */
export type WorkspaceIdentity = {
  workspacePath: string;
  sessionHome: string;
  branchName: string;
  sandboxId: SandboxId;
};

/**
 * Per-turn overridable execution settings.
 * These move as a unit from DO → orchestrator → wrapper.
 */
export type ExecutionConfig = {
  model?: string;
  variant?: string;
  autoCommit?: boolean;
  condenseOnComplete?: boolean;
};

// ---------------------------------------------------------------------------
// Token Resume Context (for DO token management)
// ---------------------------------------------------------------------------

/**
 * Resume context for follow-up executions (token management).
 * Used by CloudAgentSession DO for managing authentication tokens.
 */
export type TokenResumeContext = KiloAuth & {
  kilocodeModel: string; // required (overrides optional in KiloAuth)
  githubToken?: string;
  gitToken?: string;
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
  variant?: string;
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
  /** Git platform type for correct token/env var handling */
  platform?: 'github' | 'gitlab';
  createdOnPlatform?: string;
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
  variant?: string;
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
export type ResumeContext = KiloAuth & {
  kiloSessionId: string;
  workspacePath: string;
  branchName: string;
  /** GitHub token for token refresh (optional) */
  githubToken?: string;
  /** Git token for non-GitHub repos (optional) */
  gitToken?: string;
};

/**
 * Context for initializing a new workspace.
 * Used by both the DO (initiate flow) and orchestrator (workspace plan).
 */
export type InitContext = KiloAuth & {
  /** Git repository source (GitHub or GitLab) */
  gitSource?: GitSource;
  /** Environment variables to set in the session (plaintext) */
  envVars?: Record<string, string>;
  /** Setup commands to run after clone (e.g., npm install) */
  setupCommands?: string[];
  /** Branch to checkout (if not session-specific) */
  upstreamBranch?: string;
  /** Existing Kilo session ID (for prepared sessions) */
  kiloSessionId?: string;
  /** Flag indicating this is a prepared session (via prepareSession flow) */
  isPreparedSession?: boolean;
  /** Encrypted secrets for agent environment profiles */
  encryptedSecrets?: EncryptedSecrets;
  /** MCP server configurations */
  mcpServers?: Record<string, MCPServerConfig>;
  /** Bot ID for bot-specific sessions */
  botId?: string;
  /** GitHub App type for selecting correct credentials and slug */
  githubAppType?: 'lite' | 'standard';
  /** Platform that created this session (e.g., "slack", "cloud-agent") */
  createdOnPlatform?: string;
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
  /** Git source (for token updates on resume) */
  gitSource?: GitSource;
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
  variant?: string;
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
  /** Unique execution ID (exc_<ulid> format) */
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
  /** Kilo session ID (created or resumed) */
  kiloSessionId: string;
};
