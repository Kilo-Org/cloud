/**
 * Event types that flow through the streaming system.
 *
 * From wrapper -> DO:
 *   started, kilocode, output, status, heartbeat, pong, error, interrupted, complete, wrapper_resumed,
 *   autocommit_started, autocommit_completed
 *
 * From DO -> /stream clients:
 *   All of the above, plus wrapper_disconnected, wrapper_reconnected, preparing
 */
export type StreamEventType =
  // Wrapper -> DO (execution lifecycle)
  | 'started' // Execution began
  | 'kilocode' // Parsed JSON from kilocode stdout
  | 'output' // Raw stdout/stderr
  | 'status' // Status message (e.g., "Auto-committing...")
  | 'heartbeat' // Keep-alive during idle periods
  | 'pong' // Response to ping command from DO
  | 'error' // Error occurred { error: string, fatal: boolean }
  | 'interrupted' // User/signal interrupt
  | 'complete' // Execution finished { exitCode, currentBranch? }
  | 'wrapper_resumed' // Wrapper reconnected after disconnect (may have lost events)
  | 'autocommit_started' // Auto-commit process began
  | 'autocommit_completed' // Auto-commit finished (success, skip, or failure)
  // DO -> /stream clients (connection status)
  | 'wrapper_disconnected' // Wrapper WebSocket closed unexpectedly
  | 'wrapper_reconnected' // Wrapper reconnected successfully
  // DO -> /stream clients (async preparation progress)
  | 'preparing' // Async preparation step progress (autoInitiate flow)
  // DO -> /stream clients (cloud infrastructure lifecycle)
  | 'cloud.status' // Cloud infrastructure status (preparing/ready/finalizing/error)
  | 'connected'; // Sent on WebSocket connect with current service state

/**
 * Event envelope sent by wrapper to DO via /ingest WebSocket.
 */
export type IngestEvent = {
  streamEventType: StreamEventType;
  timestamp: string; // ISO 8601
  data: unknown;
};

/**
 * Commands sent from DO to wrapper via /ingest WebSocket.
 */
export type WrapperCommand =
  | { type: 'kill'; signal?: 'SIGTERM' | 'SIGKILL' }
  | { type: 'ping' }
  | { type: 'request_snapshot' };

/**
 * Data included in 'complete' events.
 */
export type CompleteEventData = {
  exitCode: number;
  currentBranch?: string; // Omitted if detached HEAD
  gateResult?: 'pass' | 'fail';
};

/**
 * Data included in 'kilocode' events (passthrough from CLI).
 */
export type KilocodeEventData = {
  event?: string; // e.g., 'session_created', 'token_usage'
  sessionId?: string; // Present in session_created events
  [key: string]: unknown; // Other CLI event fields
};

/**
 * Data included in 'autocommit_started' events.
 */
export type AutocommitStartedData = {
  message: string;
  messageId?: string;
};

/**
 * Data included in 'autocommit_completed' events.
 */
export type AutocommitCompletedData = {
  success: boolean;
  message: string;
  messageId?: string;
  skipped?: boolean;
  commitHash?: string;
  commitMessage?: string;
};

/**
 * Preparation step identifiers for async preparation progress events.
 */
export type PreparingStep =
  | 'disk_check'
  | 'workspace_setup'
  | 'cloning'
  | 'branch'
  | 'setup_commands'
  | 'kilo_server'
  | 'kilo_session'
  | 'ready'
  | 'failed';

/**
 * Data included in 'preparing' events (async preparation progress).
 * Emitted by the DO during startPreparationAsync to report progress to /stream clients.
 */
export type PreparingEventData = {
  step: PreparingStep;
  message: string;
  /** Branch name, included in the 'ready' step after preparation completes. */
  branch?: string;
};

/** Cloud infrastructure status types. */
export type CloudStatusType = 'preparing' | 'ready' | 'finalizing' | 'error';

/** Data included in 'cloud.status' events. */
export type CloudStatusData = {
  cloudStatus: {
    type: CloudStatusType;
    step?: string;
    message?: string;
  };
};

/** Session status as reported by the Kilo server via session.status events. */
export type SessionStatus =
  | { type: 'busy' }
  | { type: 'idle' }
  | { type: 'retry'; attempt: number; message: string; next: number };

/** Data included in 'connected' events. */
export type ConnectedEventData = {
  sessionStatus?: SessionStatus;
  cloudStatus?: { type: CloudStatusType; step?: string; message?: string };
};

/**
 * Regex for validating session IDs (agent_<uuid>).
 * Shared between worker (zod schema) and wrapper (defense-in-depth validation).
 */
export const SESSION_ID_RE =
  /^agent_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
