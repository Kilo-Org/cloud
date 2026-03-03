/**
 * Event types that flow through the streaming system.
 *
 * From wrapper -> DO:
 *   started, kilocode, output, status, heartbeat, pong, error, interrupted, complete, wrapper_resumed,
 *   autocommit_started, autocommit_completed
 *
 * From DO -> /stream clients:
 *   All of the above, plus wrapper_disconnected, wrapper_reconnected
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
  | 'wrapper_reconnected'; // Wrapper reconnected successfully

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
export type WrapperCommand = { type: 'kill'; signal?: 'SIGTERM' | 'SIGKILL' } | { type: 'ping' };

/**
 * Data included in 'complete' events.
 */
export type CompleteEventData = {
  exitCode: number;
  currentBranch?: string; // Omitted if detached HEAD
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
 * Regex for validating session IDs (agent_<uuid>).
 * Shared between worker (zod schema) and wrapper (defense-in-depth validation).
 */
export const SESSION_ID_RE =
  /^agent_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
