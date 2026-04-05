/**
 * WebSocket protocol types for the cloud-agent streaming feature.
 *
 * This module defines message formats for:
 * - `/stream` endpoint: Client-facing WebSocket for receiving execution events
 * - `/ingest` endpoint: Internal WebSocket for queue consumers/wrapper to push events
 */

import type { ExecutionId, SessionId, EventId } from '../types/ids.js';

// Re-export shared protocol types for convenience (except IngestEvent which has a local definition)
export type {
  StreamEventType as SharedStreamEventType,
  WrapperCommand,
  CompleteEventData,
  KilocodeEventData,
} from '../shared/protocol.js';

// ---------------------------------------------------------------------------
// Stream Event Types
// ---------------------------------------------------------------------------

/**
 * Types of events that can flow through the streaming system.
 * These map to execution lifecycle events and output streams.
 */
export type StreamEventType =
  | 'output' // stdout/stderr content
  | 'metadata' // execution metadata updates
  | 'error' // error occurred during execution
  | 'complete' // execution completed successfully
  | 'interrupted' // execution was interrupted
  | 'started' // execution started
  | 'progress' // progress update (e.g., tokens consumed)
  | 'kilocode' // Kilocode CLI structured events
  | 'status'; // execution status updates

// ---------------------------------------------------------------------------
// Server -> Client Events (/stream endpoint)
// ---------------------------------------------------------------------------

/**
 * Event envelope sent to clients connected to the /stream endpoint.
 * Each event is uniquely identified and associated with an execution and session.
 */
export type StreamEvent = {
  /** Auto-incrementing event ID from SQLite storage */
  eventId: EventId;
  /** Execution this event belongs to */
  executionId: ExecutionId;
  /** Session this event belongs to */
  sessionId: SessionId;
  /** Type of stream event */
  streamEventType: StreamEventType;
  /** ISO 8601 timestamp when the event occurred */
  timestamp: string;
  /** Event payload - structure depends on streamEventType */
  data: unknown;
};

// ---------------------------------------------------------------------------
// Queue Consumer -> DO Events (/ingest endpoint)
// ---------------------------------------------------------------------------

/**
 * Event envelope sent by queue consumers to the Durable Object via /ingest.
 * The execution and session context is established at connection time.
 */
export type IngestEvent = {
  /** Type of stream event */
  streamEventType: StreamEventType;
  /** ISO 8601 timestamp when the event occurred */
  timestamp: string;
  /** Event payload - structure depends on streamEventType */
  data: unknown;
};

// ---------------------------------------------------------------------------
// Error Handling
// ---------------------------------------------------------------------------

/** Error codes for WebSocket protocol errors */
export type StreamErrorCode =
  | 'WS_PROTOCOL_ERROR' // Invalid message format
  | 'WS_AUTH_ERROR' // Authentication failed
  | 'WS_SESSION_NOT_FOUND' // Session doesn't exist
  | 'WS_EXECUTION_NOT_FOUND' // Execution doesn't exist
  | 'WS_DUPLICATE_CONNECTION' // Ingest connection already exists for execution
  | 'WS_INTERNAL_ERROR'; // Internal server error

/**
 * Error message envelope sent to clients when an error occurs.
 */
export type StreamError = {
  type: 'error';
  code: StreamErrorCode;
  message: string;
};

// ---------------------------------------------------------------------------
// Stream Filtering
// ---------------------------------------------------------------------------

/**
 * Filter options for the /stream endpoint.
 * These are passed via query parameters and control which events are returned.
 */
export type StreamFilters = {
  /** Session ID to filter events for (required) */
  sessionId: SessionId;
  /** Only return events with ID > fromId (exclusive, for pagination) */
  fromId?: EventId;
  /** Only return events for these execution IDs */
  executionIds?: ExecutionId[];
  /** Only return events of these types */
  eventTypes?: StreamEventType[];
  /** Only return events at or after this timestamp (Unix ms, inclusive) */
  startTime?: number;
  /** Only return events at or before this timestamp (Unix ms, inclusive) */
  endTime?: number;
};

/**
 * Parsed and validated query parameters for the /stream endpoint.
 */
export type ParsedStreamParams = {
  sessionId: SessionId;
  fromId?: EventId;
  executionIds?: ExecutionId[];
  eventTypes?: StreamEventType[];
  startTime?: number;
  endTime?: number;
};

// ---------------------------------------------------------------------------
// SQLite Storage
// ---------------------------------------------------------------------------

/**
 * Row structure for events stored in SQLite.
 * Uses snake_case to match SQL conventions.
 */
export type StoredEvent = {
  /** Auto-incrementing primary key */
  id: EventId;
  /** Execution ID as string (without type safety at storage layer) */
  execution_id: string;
  /** Session ID as string */
  session_id: string;
  /** Event type as string */
  stream_event_type: string;
  /** JSON stringified event data */
  payload: string;
  /** Unix timestamp in milliseconds */
  timestamp: number;
};

// ---------------------------------------------------------------------------
// WebSocket Hibernation
// ---------------------------------------------------------------------------

/**
 * Attachment data stored with hibernating WebSocket connections.
 * This data persists across hibernation cycles.
 */
export type StreamAttachment = {
  /** Client's filter preferences */
  filters: StreamFilters;
  /** Unix timestamp when connection was established */
  connectedAt: number;
};
