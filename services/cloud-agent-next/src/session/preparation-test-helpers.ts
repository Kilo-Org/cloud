import { materializePreparationEvent } from './preparation-history.js';
import type { PreparationAttempt, PreparationStepSnapshot } from '../shared/protocol.js';
import type { EventQueries } from './queries/index.js';
import type {
  AssistantMessageInfo,
  AssistantMessagePart,
  LatestAssistantMessage,
} from './types.js';
import type { StoredEvent } from '../websocket/types.js';

type KilocodePayload = {
  event?: string;
  properties?: { info?: AssistantMessageInfo; part?: AssistantMessagePart };
};

function parseKilocodePayload(payload: string): KilocodePayload | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    return typeof parsed === 'object' && parsed !== null ? (parsed as KilocodePayload) : null;
  } catch {
    return null;
  }
}

/** Entity-keyed in-memory stand-in for the preparation slice of EventQueries. */
export function createMemoryEventQueries(): EventQueries {
  const rows = new Map<string, StoredEvent>();
  let nextId = 1;
  return {
    upsert: (params: {
      executionId: string;
      sessionId: string;
      streamEventType: string;
      payload: string;
      timestamp: number;
      entityId: string;
    }) => {
      const existing = rows.get(params.entityId);
      const id = existing?.id ?? nextId++;
      rows.set(params.entityId, {
        id,
        execution_id: params.executionId,
        session_id: params.sessionId,
        stream_event_type: params.streamEventType,
        payload: params.payload,
        timestamp: params.timestamp,
      } as StoredEvent);
      return id;
    },
    findByEntityId: (entityId: string) => rows.get(entityId) ?? null,
    findByEntityPrefix: (prefix: string) =>
      [...rows.entries()]
        .filter(([entityId]) => entityId.startsWith(prefix))
        .map(([, row]) => row)
        .sort((a, b) => a.timestamp - b.timestamp || a.id - b.id),
    getAssistantMessageForUserMessage: (
      sessionId: string,
      kiloSessionId: string,
      parentMessageId: string
    ): LatestAssistantMessage | null => {
      const updated = [...rows.values()]
        .filter(row => row.stream_event_type === 'kilocode' && row.session_id === sessionId)
        .flatMap(row => {
          const payload = parseKilocodePayload(row.payload);
          const info = payload?.event === 'message.updated' ? payload.properties?.info : undefined;
          if (
            info?.role !== 'assistant' ||
            info.sessionID !== kiloSessionId ||
            info.parentID !== parentMessageId
          )
            return [];
          return [{ row, info }];
        })
        .sort(
          (left, right) => left.row.timestamp - right.row.timestamp || left.row.id - right.row.id
        );
      const latest = updated[updated.length - 1];
      if (!latest) return null;
      const partsById = new Map<string, AssistantMessagePart>();
      for (const row of rows.values()) {
        const payload = parseKilocodePayload(row.payload);
        const part =
          payload?.event === 'message.part.updated' ? payload.properties?.part : undefined;
        if (part?.messageID === latest.info.id) partsById.set(part.id, part);
      }
      return {
        eventId: latest.row.id,
        timestamp: latest.row.timestamp,
        info: latest.info,
        parts: [...partsById.values()].sort((left, right) => left.id.localeCompare(right.id)),
      } satisfies LatestAssistantMessage;
    },
  } as unknown as EventQueries;
}

export function storedEvent(
  timestamp: number
): Pick<StoredEvent, 'execution_id' | 'session_id' | 'timestamp'> {
  return { execution_id: 'exec-1', session_id: 'sess-1', timestamp };
}

/** Materialize a running attempt with one running kilo_server step. */
export function seedRunningAttempt(
  eventQueries: EventQueries,
  options: { attemptId?: string; startedAt?: number } = {}
): { attemptId: string; lastEventAt: number } {
  const attemptId = options.attemptId ?? 'attempt-1';
  const startedAt = options.startedAt ?? 1000;
  materializePreparationEvent(eventQueries, storedEvent(startedAt), {
    version: 2,
    attemptId,
    triggerMessageId: 'msg-1',
    revision: 1,
    timestamp: startedAt,
    step: 'workspace_setup',
    message: 'Preparing environment',
    action: 'attempt_started',
  });
  const lastEventAt = startedAt + 5000;
  materializePreparationEvent(eventQueries, storedEvent(lastEventAt), {
    version: 2,
    attemptId,
    triggerMessageId: 'msg-1',
    revision: 2,
    timestamp: lastEventAt,
    step: 'kilo_server',
    message: 'Starting Kilo',
    action: 'step_started',
    stepId: 'phase:kilo_server',
    kind: 'phase',
    label: 'kilo server',
  });
  return { attemptId, lastEventAt };
}

export function readAttempt(
  eventQueries: EventQueries,
  attemptId: string
): Omit<PreparationAttempt, 'steps'> {
  const row = eventQueries.findByEntityId(`preparation/attempt/${attemptId}`);
  if (!row) throw new Error('Expected attempt snapshot row');
  return (JSON.parse(row.payload) as { attempt: Omit<PreparationAttempt, 'steps'> }).attempt;
}

export function readStep(
  eventQueries: EventQueries,
  attemptId: string,
  stepId: string
): PreparationStepSnapshot {
  const row = eventQueries.findByEntityId(`preparation/attempt/${attemptId}/step/${stepId}`);
  if (!row) throw new Error('Expected step snapshot row');
  return (JSON.parse(row.payload) as { stepSnapshot: PreparationStepSnapshot }).stepSnapshot;
}
