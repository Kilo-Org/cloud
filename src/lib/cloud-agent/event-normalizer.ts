/**
 * Normalizes V2 WebSocket events to V1 format for compatibility with existing processEvent logic.
 */

export type V2Event = {
  eventId: number;
  executionId: string;
  sessionId: string;
  streamEventType: string;
  timestamp: string;
  data: unknown;
};

export type V1Event = {
  streamEventType: string;
  payload: unknown;
  sessionId: string;
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

export type StreamError = {
  type: 'error';
  code: StreamErrorCode;
  message: string;
};

export function isValidV2Event(event: unknown): event is V2Event {
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

/**
 * Safely normalize a V2 event, returning null if validation fails.
 */
export function tryNormalizeV2Event(event: unknown): V1Event | null {
  if (!isValidV2Event(event)) {
    return null;
  }

  return {
    streamEventType: event.streamEventType,
    payload: event.data,
    sessionId: event.sessionId,
  };
}
