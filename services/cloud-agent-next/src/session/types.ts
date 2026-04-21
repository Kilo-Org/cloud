/**
 * Session types for WebSocket streaming execution management.
 *
 * These types define the structure of execution metadata stored in
 * the CloudAgentSession Durable Object's key-value storage.
 */

import type { EventId, ExecutionId } from '../types/ids.js';
import type { ExecutionStatus } from '../core/execution.js';
import type { ExecutionMode, StreamingMode } from '../execution/types.js';

// ---------------------------------------------------------------------------
// Execution Metadata
// ---------------------------------------------------------------------------

/**
 * Execution metadata stored in session state.
 * Tracks the status and configuration of each execution within a session.
 */
export type ExecutionMetadata = {
  executionId: ExecutionId;
  status: ExecutionStatus;
  startedAt: number;
  completedAt?: number;
  mode: ExecutionMode;
  streamingMode: StreamingMode;
  error?: string;
  /** Process ID for long-running sandbox processes */
  processId?: string;
  lastHeartbeat?: number;
  /** Timestamp of most recent non-heartbeat ingest event */
  lastEventAt?: number;
  /** Token for authenticating ingest WebSocket connections */
  ingestToken?: string;
};

// ---------------------------------------------------------------------------
// Latest Assistant Message
// ---------------------------------------------------------------------------

export type AssistantMessageInfo = Record<string, unknown> & {
  id: string;
  role: 'assistant';
};

export type AssistantMessagePart = Record<string, unknown> & {
  id: string;
  messageID: string;
};

export type LatestAssistantMessage = {
  eventId: EventId;
  timestamp: number;
  info: AssistantMessageInfo;
  parts: AssistantMessagePart[];
};

// ---------------------------------------------------------------------------
// Session State Extension
// ---------------------------------------------------------------------------

/**
 * Extended session state with WebSocket streaming support.
 * These fields are stored in the DO key-value storage alongside metadata.
 */
export type CloudAgentSessionStateExtension = {
  activeExecutionId?: ExecutionId;
  executions?: ExecutionMetadata[];
  interruptRequested?: boolean;
};

// ---------------------------------------------------------------------------
// RPC Parameters
// ---------------------------------------------------------------------------

/**
 * Parameters for adding a new execution.
 */
export type AddExecutionParams = {
  executionId: ExecutionId;
  mode: ExecutionMode;
  streamingMode: StreamingMode;
  /** Token for authenticating ingest WebSocket connections */
  ingestToken?: string;
};

/**
 * Parameters for updating execution status.
 */
export type UpdateExecutionStatusParams = {
  executionId: ExecutionId;
  status: ExecutionStatus;
  error?: string;
  completedAt?: number;
  gateResult?: 'pass' | 'fail';
};

/**
 * Parameters for updating execution heartbeat.
 */
export type UpdateExecutionHeartbeatParams = {
  executionId: ExecutionId;
  timestamp: number;
};
