/**
 * Types for the cloud-agent execution system.
 *
 * This module defines the core types for queue-first acceptance and wrapper delivery.
 *
 * NOTE: Legacy worker-queue types (ExecutionMessage, WrapperLaunchPlan) have been removed.
 */

import type { ExecutionId, SessionId, UserId } from '../types/ids.js';
import type { AgentMode } from '../schema.js';
import type { Attachments } from '../router/schemas.js';
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

/** Prompt text and optional canonical attachments before message identity is added. */
export type PromptContent = {
  prompt: string;
  attachments?: Attachments;
};

/** Prompt input submitted before queue admission settles the message identity. */
export type PromptSubmission = PromptContent & {
  id?: string | null;
};

export type PromptExecutionTurnSubmission = PromptSubmission & {
  type: 'prompt';
};

export type CommandExecutionTurnSubmission = {
  type: 'command';
  id?: string | null;
  command: string;
  arguments: string;
  attachments?: Attachments;
};

export type ExecutionTurnSubmission =
  | PromptExecutionTurnSubmission
  | CommandExecutionTurnSubmission;

/** Prompt turn after queue admission has selected the durable message identity. */
export type AcceptedPromptTurn = PromptContent & {
  type: 'prompt';
  messageId: string;
};

export type AcceptedCommandTurn = {
  type: 'command';
  messageId: string;
  command: string;
  arguments: string;
};

export type AcceptedExecutionTurn = AcceptedPromptTurn | AcceptedCommandTurn;

export function renderExecutionTurnContent(turn: AcceptedExecutionTurn): string {
  if (turn.type === 'prompt') return turn.prompt;
  return turn.arguments.length > 0 ? `/${turn.command} ${turn.arguments}` : `/${turn.command}`;
}

/** Resolved model plus optional variant. */
export type ModelChoice = {
  model: string;
  variant?: string;
};

/** Fully resolved agent selection. */
export type AgentSelection = ModelChoice & {
  mode: ExecutionMode;
};

/** Partial agent fields merged with registered session defaults during admission. */
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
  attachments?: Attachments;
};

/** A single user message to deliver to the agent. */
export type MessageRequest = {
  messageId: string;
  prompt: string;
  executionOptions?: AgentSelectionOverride & TurnFinalization;
};

// ---------------------------------------------------------------------------
// Session Message Intent
// ---------------------------------------------------------------------------

/**
 * Durable intent for a user message queued in the session.
 *
 * Stored in pending-queue records and used as the canonical internal
 * representation of what the user asked. Does NOT store a fenced dispatch
 * request or mutable workspace metadata - those are resolved at delivery time from
 * current session state.
 */
export type SessionMessageIntent = {
  turn: AcceptedExecutionTurn;
  agent: AgentSelection;
  finalization?: TurnFinalization;
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

/** Turn payload preserved by the queue seam before the DO accepts a durable turn. */
export type QueueExecutionTurnCommand = {
  turn: ExecutionTurnSubmission;
  agent?: AgentSelectionOverride;
  finalization?: TurnFinalization;
};

/** Current-path submitted message before durable admission resolves identity/defaults. */
export type SubmittedSessionMessageRequest = {
  userId: UserId;
  botId?: string;
} & QueueExecutionTurnCommand;

/** Already-canonical current message intent admitted without recreating its turn identity. */
export type AdmitAcceptedSessionMessageRequest = {
  userId: UserId;
  botId?: string;
  turn: AcceptedExecutionTurn;
  agent: AgentSelection;
  finalization?: TurnFinalization;
};

/** Retained legacy command requesting admission of the stored prepared initial turn. */
export type LegacyRegisteredInitialAdmissionRequest = {
  userId: UserId;
  botId?: string;
};

/**
 * Retryable error codes that map to 503 Service Unavailable.
 * These match the TransientErrorResponse schema.
 */
export type RetryableResultCode =
  | 'SANDBOX_CONNECT_FAILED'
  | 'WORKSPACE_SETUP_FAILED'
  | 'KILO_SERVER_FAILED'
  | 'WRAPPER_START_FAILED';

export type AdmissionFailure = {
  success: false;
  code: 'NOT_FOUND' | 'BAD_REQUEST' | 'INTERNAL' | 'PENDING_QUEUE_FULL' | RetryableResultCode;
  error: string;
  failureBoundary?: 'registration' | 'admission';
};

/** Durable acknowledgement that a message intent is stored for asynchronous delivery. */
export type DurableAdmissionAck = {
  success: true;
  outcome: 'queued';
  messageId: string;
  compatibilityDelivery: 'queued' | 'sent';
};

/** Runtime acknowledgement that the fenced wrapper accepted a delivered message. */
export type RuntimeAcceptanceResult = {
  success: true;
  outcome: 'accepted';
  messageId: string;
  wrapperRunId: string;
};

export type SessionMessageAdmissionResult = DurableAdmissionAck | AdmissionFailure;
export type MessageDeliveryResult = RuntimeAcceptanceResult | AdmissionFailure;

/** Compatibility request retained only for external schema/type imports. */
export type QueueSessionMessageRequest = SubmittedSessionMessageRequest;
/** Compatibility result retained only for external schema/type imports. */
export type QueueSessionMessageResult = SessionMessageAdmissionResult;
/** @deprecated Use SubmittedSessionMessageRequest. */
export type StartExecutionV2Request = SubmittedSessionMessageRequest;
/** @deprecated Use SessionMessageAdmissionResult. */
export type StartExecutionV2Result = SessionMessageAdmissionResult;

// ---------------------------------------------------------------------------
// Delivery Plan Components
// ---------------------------------------------------------------------------

export type WorkspaceDeliveryPlan = {
  sandboxId: string;
  metadata: SessionMetadata;
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

export type WrapperDeliveryTarget = {
  kiloSessionId?: string;
};

export type FencedWrapperDeliveryBinding = WrapperDeliveryTarget & {
  fence: WrapperRunFence;
};

// ---------------------------------------------------------------------------
// Message Delivery Boundary
// ---------------------------------------------------------------------------

type DeliveryRequestBase = {
  scope: Pick<SessionScope, 'sessionId' | 'userId' | 'orgId'>;
  turn: AcceptedExecutionTurn;
  agent: AgentSelection;
  finalization?: TurnFinalization;
  workspace: WorkspaceDeliveryPlan;
};

/** Durable queued message handed to AgentRuntime before runtime identity allocation. */
export type MessageDeliveryRequest = DeliveryRequestBase & {
  wrapper: WrapperDeliveryTarget;
};

/** Wrapper dispatch request after AgentRuntime has allocated a complete active fence. */
export type FencedWrapperDispatchRequest = DeliveryRequestBase & {
  wrapper: FencedWrapperDeliveryBinding;
};

/** Compatibility dispatch request for still-used execution-record orchestration tests. */
export type FencedLegacyExecutionRequest = FencedWrapperDispatchRequest & {
  executionId: ExecutionId;
};

/** @deprecated Use FencedLegacyExecutionRequest. */
export type ExecutionPlan = FencedLegacyExecutionRequest;

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
