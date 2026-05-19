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
import type {
  MCPServerConfig,
  RuntimeSkill,
  RuntimeAgent,
  RuntimeKiloCommand,
} from '../persistence/types.js';
import type { SessionProfileBundle } from '../session-profile.js';

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
  /**
   * Profile-derived configuration snapshot (envVars, encryptedSecrets,
   * setupCommands, mcpServers, runtimeSkills, runtimeAgents). Adding a new
   * profile field is a single-line change in {@link SessionProfileBundle}.
   */
  profile?: SessionProfileBundle;
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
  createdOnPlatform?: string;
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
  runtimeSkills?: readonly RuntimeSkill[];
  runtimeAgents?: readonly RuntimeAgent[];
  kiloCommands?: readonly RuntimeKiloCommand[];
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
  messageId?: string;
};

/**
 * Discriminated payload for follow-up execution.
 *
 * Kept as a typed bundle so call sites stop juggling loose `prompt|command|args`
 * fields across five+ functions. The orchestrator's only branch point on this
 * union is the final wrapper call (prompt vs structured command).
 */
export type PromptExecutionPayload = {
  type: 'prompt';
  prompt: string;
  /** Defaults to the session's stored mode when omitted. */
  mode?: ExecutionMode;
  /** Defaults to the session's stored model when omitted. */
  model?: string;
  variant?: string;
};

export type CommandExecutionPayload = {
  type: 'command';
  /** Kilo command name (e.g. "review"). */
  command: string;
  /**
   * Verbatim args string passed after the command name. Kilo expands
   * `$1`, `$2`, `$ARGUMENTS` against the template server-side.
   */
  arguments: string;
};

export type ExecutionPayload = PromptExecutionPayload | CommandExecutionPayload;

/**
 * Request for follow-up message on existing session.
 */
type FollowupExecutionRequest = BaseExecutionRequest & {
  kind: 'followup';
  payload: ExecutionPayload;
  autoCommit?: boolean;
  condenseOnComplete?: boolean;
  messageId?: string;
  images?: Images;
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
  createdOnPlatform?: string;
};

/**
 * Context for initializing a new workspace.
 */
export type InitContext = {
  githubRepo?: string;
  gitUrl?: string;
  githubToken?: string;
  gitToken?: string;
  upstreamBranch?: string;
  kiloSessionId?: string;
  isPreparedSession?: boolean;
  /** Kilocode API token */
  kilocodeToken: string;
  /** Kilocode model to use */
  kilocodeModel?: string;
  /**
   * Profile-derived configuration snapshot (envVars, encryptedSecrets,
   * setupCommands, mcpServers, runtimeSkills, runtimeAgents).
   */
  profile?: SessionProfileBundle;
  /** Bot ID for bot-specific sessions */
  botId?: string;
  /** GitHub app type for determining which app to use */
  githubAppType?: 'lite' | 'standard';
  /** Git platform type for correct token/env var handling */
  platform?: 'github' | 'gitlab';
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
  /**
   * Profile snapshot stored on the session at prepare time. Used by the
   * fast path to re-inject MCP servers, runtime skills, and runtime modes
   * when recreating the sandbox session.
   */
  profile?: SessionProfileBundle;
  /** GitHub repo (for token updates) */
  githubRepo?: string;
  /** Git URL (for token updates) */
  gitUrl?: string;
  createdOnPlatform?: string;
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
 * Complete plan for executing a prompt or slash command.
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
  /** What the user asked the agent to do (free-text prompt or structured slash command). */
  payload: ExecutionPayload;
  /**
   * Execution mode. For prompt payloads this is the picked agent. For command
   * payloads this is the session's existing mode (used for logger tags;
   * kilo applies the command's own `agent` override).
   */
  mode: AgentMode;
  /** Workspace preparation plan */
  workspace: WorkspacePlan;
  /** Wrapper configuration plan */
  wrapper: WrapperPlan;
  /** Optional image attachments (prompt payloads only). */
  images?: Images;
  /** Optional message ID for correlating the request */
  messageId?: string;
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
