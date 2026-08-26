import { extractEntityId } from '../session/ingest-handlers/entity-id.js';
import type { EventId } from '../types/ids.js';
import type { StoredEvent } from '../websocket/types.js';

const PERSISTED_KILO_EVENT_NAMES: ReadonlySet<string> = new Set([
  'message.part.removed',
  'session.created',
  'session.updated',
  'session.status',
  'session.error',
  'session.idle',
  'session.turn.close',
]);

export type SandboxControlEventQueries = {
  upsert(params: {
    executionId: string;
    sessionId: string;
    streamEventType: string;
    payload: string;
    timestamp: number;
    entityId: string;
  }): EventId;
  insert(params: {
    executionId: string;
    sessionId: string;
    streamEventType: string;
    payload: string;
    timestamp: number;
  }): EventId;
};

export type SandboxControlSessionEventInput = {
  type: string;
  properties: Record<string, unknown>;
  timestamp?: string;
};

export function persistSandboxControlSessionEvent(params: {
  sessionId: string;
  payload: SandboxControlSessionEventInput;
  eventQueries: SandboxControlEventQueries;
  broadcast: (event: StoredEvent) => void;
}): { applied: true } {
  const timestamp = params.payload.timestamp ? Date.parse(params.payload.timestamp) : Date.now();
  const payload = JSON.stringify({
    type: params.payload.type,
    event: params.payload.type,
    properties: params.payload.properties,
  });
  const entityId = extractEntityId(params.payload.type, { properties: params.payload.properties });
  let eventId: EventId = 0;
  if (entityId) {
    eventId = params.eventQueries.upsert({
      executionId: '',
      sessionId: params.sessionId,
      streamEventType: 'kilocode',
      payload,
      timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
      entityId,
    });
  } else if (PERSISTED_KILO_EVENT_NAMES.has(params.payload.type)) {
    eventId = params.eventQueries.insert({
      executionId: '',
      sessionId: params.sessionId,
      streamEventType: 'kilocode',
      payload,
      timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
    });
  }

  params.broadcast({
    id: eventId,
    execution_id: '',
    session_id: params.sessionId,
    stream_event_type: 'kilocode',
    payload,
    timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
  });
  return { applied: true };
}
