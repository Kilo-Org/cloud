import type { EventQueries } from '../session/queries/index.js';
import {
  cloudStatusForPreparingEvent,
  materializePreparationEvent,
} from '../session/preparation-history.js';
import type { CloudStatusData } from '../shared/protocol.js';
import type { EventId } from '../types/ids.js';
import type { StoredEvent } from '../websocket/types.js';

export function applyControlPlanePreparingEvent(params: {
  sessionId: string;
  data: unknown;
  eventQueries: EventQueries;
  broadcast: (event: StoredEvent) => void;
}): boolean {
  const record = isRecord(params.data) ? params.data : {};
  const timestamp =
    typeof record.timestamp === 'number' && Number.isFinite(record.timestamp)
      ? record.timestamp
      : Date.now();
  const stored: StoredEvent = {
    id: 0 as EventId,
    execution_id: '',
    session_id: params.sessionId,
    stream_event_type: 'preparing',
    payload: JSON.stringify(params.data),
    timestamp,
  };
  params.broadcast(stored);
  const applied = materializePreparationEvent(params.eventQueries, stored, params.data);
  const cloudStatus = cloudStatusForPreparingEvent(params.data, applied);
  if (cloudStatus) {
    params.broadcast({
      id: 0 as EventId,
      execution_id: '',
      session_id: params.sessionId,
      stream_event_type: 'cloud.status',
      payload: JSON.stringify({ cloudStatus } satisfies CloudStatusData),
      timestamp,
    });
  }
  return applied;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
