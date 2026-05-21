/**
 * Types for the cloud-agent execution system.
 *
 * This module defines the core types for queue-first acceptance and wrapper delivery.
 *
 * NOTE: Legacy worker-queue types (ExecutionMessage, WrapperLaunchPlan) have been removed.
 */

import type { ExecutionId, SessionId, UserId } from '../types/ids.js';
import type { AgentMode } from '../schema.js';
import type { Images } from '../router/schemas.js';
import type { SessionMetadata } from '../persistence/session-metadata.js';
import type { CloudAgentSessionState } from '../persistence/types.js';

// ---------------------------------------------------------------------------
// Execution Modes
// ---------------------------------------------------------------------------

/** Mode of execution - passed directly to kilocode CLI */
export type ExecutionMode = AgentMode;

/** How the client receives streaming output */
export type StreamingMode = 'sse' | 'websocket';

// ---------------------------------------------------------------------------
// Parameter Bundles
// ---------------------------------------------------------------------------

/** Identity fields shared across most session operations. */
export type SessionScope = {
  userId: UserId;
  orgId?: string;
  sessionId: SessionId;
  botId?: string;
};

/** Prompt text and optional images before message identity concerns are added. */
export type PromptContent = {
  prompt: string;
  images?: Images;
};

/** Prompt input submitted before queue admission settles the message identity. */
export type PromptSubmission = PromptContent & {
  id?: string | null;
};

/** Prompt turn after queue admission has selected the durable message identity. */
export type AcceptedPromptTurn = PromptContent & {
  messageId: string;
};

/** Resolved model plus optional variant. */
export type ModelChoice = {
  model: string;
  variant?: string;
};

/** Fully resolved agent selection. */
export type AgentSelection = ModelChoice & {
  mode: ExecutionMode;
};

/** Partial agent fields accepted as a per-turn override. */
export type AgentSelectionOverride = {
  mode?: ExecutionMode;
  model?: string;
  variant?: string;
};

/** Finalization behavior applicable to a single delivered turn. */
export type TurnFinalization = {
  autoCommit?: boolean;
  condenseOnComplete?: boolean;
};

/** Session policy extends per-turn finalization with session-only gates. */
export type SessionFinalization = TurnFinalization & {
  gateThreshold?: 'off' | 'all' | 'warning' | 'critical';
};

/** Transient credentials used while resolving or refreshing repository access. */
export type RepositoryAuthOverrides = {
  githubToken?: string;
  gitToken?: string;
};

/** Workspace location on a sandbox - available after preparation. */
export type WorkspaceLocation = {
  sandboxId: string;
  workspacePath: string;
  sessionHome: string;
  branchName: string;
  upstreamBranch?: string;
};

/** Repository source - discriminated by hosting provider. */
export type RepoSource =
  | { kind: 'github'; repo: string; token?: string }
  | { kind: 'gitlab'; url: string; token?: string; managed: boolean };

/** Authentication tokens for the Kilocode runtime. */
export type AuthBundle = {
  kilocodeToken: string;
  kilocodeModel?: string;
};

/** Session-level execution configuration. */
export type SessionConfig = {
  mode: ExecutionMode;
  model: string;
  variant?: string;
  autoCommit?: boolean;
  condenseOnComplete?: boolean;
  appendSystemPrompt?: string;
  images?: Images;
};

/** A single user message to deliver to the agent. */
export type MessageRequest = {
  messageId: string;
  prompt: string;
  executionOptions?: AgentSelectionOverride & TurnFinalization;
  tokenOverrides?: RepositoryAuthOverrides;
};

// ---------------------------------------------------------------------------
// Session Message Intent
// ---------------------------------------------------------------------------

/**
 * Durable intent for a user message queued in the session.
 *
 * Stored in pending-queue records and used as the canonical internal
 * representation of what the user asked. Does NOT store full ExecutionPlan
 * or mutable workspace metadata - those are resolved at delivery time from
 * current session state.
 */
export type SessionMessageIntent = {
  turn: AcceptedPromptTurn;
  agent: AgentSelection;
  finalization?: TurnFinalization;
  repositoryAuthOverrides?: RepositoryAuthOverrides;
};

// ---------------------------------------------------------------------------
// Delivery Context
// ---------------------------------------------------------------------------

/**
 * Context for delivering a queued message to the wrapper.
 *
 * Built from current session metadata at delivery time; captures the
 * snapshot needed by the orchestrator and wrapper.
 */
export type ExecutionDeliveryContext = {
  sessionId: SessionId;
  userId: UserId;
  orgId?: string;
  sandboxId: string;
  kiloSessionId?: string;
  metadata: SessionMetadata;
};

// ---------------------------------------------------------------------------
// V2 Request/Response Types (for DO methods and tRPC handlers)
// ---------------------------------------------------------------------------

/** Prompt payload preserved by the queue seam before the DO accepts a durable turn. */
export type QueuePromptCommand = {
  message: PromptSubmission;
  agent?: AgentSelectionOverride;
  finalization?: TurnFinalization;
  tokenOverrides?: RepositoryAuthOverrides;
};

/** Explicit command payload for queuing a message via the session DO. */
export type QueueSessionMessageRequest =
  | {
      kind: 'registered-initial';
      userId: UserId;
      botId?: string;
    }
  | ({
      kind: 'user-message';
      userId: UserId;
      botId?: string;
    } & QueuePromptCommand);

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
 * Delivery mode for an accepted V2 start request.
 * - sent: the wrapper accepted the message synchronously with HTTP 200.
 * - queued: the DO accepted and stored the message for later delivery.
 */
export type StartExecutionDelivery = 'sent' | 'queued';

/**
 * Result of starting a V2 execution.
 *
 * Error codes:
 * - SANDBOX_CONNECT_FAILED, WORKSPACE_SETUP_FAILED, KILO_SERVER_FAILED, WRAPPER_START_FAILED: 503 Service Unavailable
 * - NOT_FOUND: 404 Not Found
 * - BAD_REQUEST: 400 Bad Request
 * - INTERNAL: 500 Internal Server Error
 */
export type QueueSessionMessageResult =
  | {
      success: true;
      status: 'started';
      messageId: string;
      delivery: StartExecutionDelivery;
      wrapperRunId?: string;
    }
  | {
      success: false;
      code: 'NOT_FOUND' | 'BAD_REQUEST' | 'INTERNAL' | 'PENDING_QUEUE_FULL' | RetryableResultCode;
      error: string;
    };

/** @deprecated Use QueueSessionMessageRequest */
export type StartExecutionV2Request = QueueSessionMessageRequest;

/** @deprecated Use QueueSessionMessageResult */
export type StartExecutionV2Result = QueueSessionMessageResult;

// ---------------------------------------------------------------------------
// Delivery Plan Components
// ---------------------------------------------------------------------------

export type WorkspaceDeliveryPlan = {
  sandboxId: string;
  metadata: SessionMetadata;
  repositoryAuthOverrides?: RepositoryAuthOverrides;
};

export type WorkspaceReady = {
  workspacePath: string;
  sandboxId: string;
  sessionHome: string;
  branchName: string;
  kiloSessionId: string;
  githubInstallationId?: string;
  githubAppType?: 'standard' | 'lite';
  gitToken?: string;
  gitlabTokenManaged?: boolean;
  devcontainer?: CloudAgentSessionState['devcontainer'];
};

/**
 * Model configuration used by wrapper HTTP DTOs, not runtime delivery plans.
 */
export type ModelConfig = {
  providerID?: string;
  modelID: string;
};

export type WrapperRunFence = {
  wrapperRunId: string;
  wrapperGeneration: number;
  wrapperConnectionId: string;
};

export type WrapperDeliveryBinding = {
  kiloSessionId?: string;
  fence?: Partial<WrapperRunFence>;
};

// ---------------------------------------------------------------------------
// Message Delivery Plan (new path - no executionId)
// ---------------------------------------------------------------------------

/**
 * Delivery plan for a queued user message.
 *
 * Runtime delivery is grouped by concern so the wrapper adapter has one
 * accepted turn, agent selection, workspace, and wrapper fence to project.
 */
export type MessageDeliveryPlan = {
  scope: Pick<SessionScope, 'sessionId' | 'userId' | 'orgId'>;
  turn: AcceptedPromptTurn;
  agent: AgentSelection;
  finalization?: TurnFinalization;
  workspace: WorkspaceDeliveryPlan;
  wrapper: WrapperDeliveryBinding;
};

// ---------------------------------------------------------------------------
// Execution Plan (legacy - new code should prefer MessageDeliveryPlan)
// ---------------------------------------------------------------------------

/**
 * Compatibility plan for execution-ID survivors.
 *
 * It is structurally the message-first delivery plan plus only the legacy
 * execution identity, so those paths cannot drift in runtime fields.
 */
export type ExecutionPlan = MessageDeliveryPlan & {
  executionId: ExecutionId;
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
