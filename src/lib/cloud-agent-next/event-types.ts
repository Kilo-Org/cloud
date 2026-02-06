/**
 * Cloud Agent Event Types
 *
 * Type definitions and validation for WebSocket stream events.
 * Events follow the OpenNext message format.
 */

/**
 * Event received from the cloud agent WebSocket stream.
 */
export type CloudAgentEvent = {
  eventId: number;
  executionId: string;
  sessionId: string;
  streamEventType: string;
  timestamp: string;
  data: unknown;
};

/**
 * Error codes for WebSocket protocol errors.
 * These match the WS_* codes from cloud-agent/src/websocket/types.ts.
 */
export type StreamErrorCode =
  | 'WS_PROTOCOL_ERROR'
  | 'WS_AUTH_ERROR'
  | 'WS_SESSION_NOT_FOUND'
  | 'WS_EXECUTION_NOT_FOUND'
  | 'WS_DUPLICATE_CONNECTION'
  | 'WS_INTERNAL_ERROR';

const STREAM_ERROR_CODES: ReadonlySet<string> = new Set<StreamErrorCode>([
  'WS_PROTOCOL_ERROR',
  'WS_AUTH_ERROR',
  'WS_SESSION_NOT_FOUND',
  'WS_EXECUTION_NOT_FOUND',
  'WS_DUPLICATE_CONNECTION',
  'WS_INTERNAL_ERROR',
]);

/**
 * Error sent over the WebSocket stream.
 */
export type StreamError = {
  type: 'error';
  code: StreamErrorCode;
  message: string;
};

/**
 * Type guard to validate a CloudAgentEvent from unknown data.
 */
export function isValidCloudAgentEvent(event: unknown): event is CloudAgentEvent {
  if (typeof event !== 'object' || event === null) {
    return false;
  }
  return (
    'eventId' in event &&
    typeof event.eventId === 'number' &&
    'executionId' in event &&
    typeof event.executionId === 'string' &&
    'sessionId' in event &&
    typeof event.sessionId === 'string' &&
    'streamEventType' in event &&
    typeof event.streamEventType === 'string' &&
    'timestamp' in event &&
    typeof event.timestamp === 'string' &&
    'data' in event
  );
}

/**
 * Type guard to validate a StreamError from unknown data.
 */
export function isStreamError(data: unknown): data is StreamError {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  return (
    'type' in data &&
    data.type === 'error' &&
    'code' in data &&
    typeof data.code === 'string' &&
    STREAM_ERROR_CODES.has(data.code) &&
    'message' in data &&
    typeof data.message === 'string'
  );
}
