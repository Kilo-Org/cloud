/**
 * Types for the cloud-agent execution system.
 *
 * This module defines the core types for queue-first acceptance and wrapper delivery.
 *
 * NOTE: Legacy worker-queue types (ExecutionMessage, WrapperLaunchPlan) have been removed.
 */

import type { UserId } from '../types/ids.js';
import type { AgentMode } from '../schema.js';
import type { Attachments } from '../router/schemas.js';

/** Mode of execution - passed directly to kilocode CLI */
export type ExecutionMode = AgentMode;

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

/**
 * Retryable error codes that map to 503 Service Unavailable.
 * These match the TransientErrorResponse schema.
 */
export type RetryableResultCode =
  | 'SANDBOX_CONNECT_FAILED'
  | 'WORKSPACE_SETUP_FAILED'
  | 'KILO_SERVER_FAILED'
  | 'WRAPPER_START_FAILED'
  | 'WRAPPER_FINALIZING';

// Keep aligned with the customer-safe schemas in trpc-error.ts and cloud-agent-sdk.
export type CustomerBillingFailure = {
  code: 'INSUFFICIENT_CREDITS' | 'COMPUTE_STOPPING' | 'BILLING_UNAVAILABLE';
  payer: { type: 'user' | 'org'; id: string };
  retryable: boolean;
  remainingMicrodollars?: number;
  minimumRequiredMicrodollars?: number;
};

export type AdmissionFailure = {
  success: false;
  code:
    | 'NOT_FOUND'
    | 'BAD_REQUEST'
    | 'INTERNAL'
    | 'PAYMENT_REQUIRED'
    | 'COMPUTE_STOPPING'
    | 'BILLING_UNAVAILABLE'
    | 'PENDING_QUEUE_FULL'
    | RetryableResultCode;
  error: string;
  billingFailure?: CustomerBillingFailure;
  failureBoundary?: 'registration' | 'admission';
};

/** Durable acknowledgement that a message intent is stored for asynchronous delivery. */
export type DurableAdmissionAck = {
  success: true;
  outcome: 'queued';
  messageId: string;
  compatibilityDelivery: 'queued' | 'sent';
};

export type ModelValidationAdmissionFailure = Omit<AdmissionFailure, 'code'> & {
  code: 'FORBIDDEN' | 'MODEL_VALIDATION_UNAVAILABLE';
};

export type SessionMessageAdmissionResult =
  | DurableAdmissionAck
  | AdmissionFailure
  | ModelValidationAdmissionFailure;
