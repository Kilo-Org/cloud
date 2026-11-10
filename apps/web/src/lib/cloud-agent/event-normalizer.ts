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
 * Error codes for WebSocket protocol errors and the error envelope.
 * Canonical definitions live in `@kilocode/session-ingest-contracts` so the
 * Worker, the web app, and the cloud-agent SDK stay in lockstep.
 */
export { isStreamError } from '@kilocode/session-ingest-contracts';
export type { StreamError, StreamErrorCode } from '@kilocode/session-ingest-contracts';

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
