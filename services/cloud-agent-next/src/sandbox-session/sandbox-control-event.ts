import { z } from 'zod';
import { autoCommitRecordSchema } from '@kilocode/worker-utils/cloud-agent-commits';
import { extractEntityId } from '../session/ingest-handlers/entity-id.js';
import type { EventId } from '../types/ids.js';
import type { StoredEvent } from '../websocket/types.js';

const PERSISTED_KILO_EVENT_NAMES: ReadonlySet<string> = new Set([
  'message.removed',
  'message.part.removed',
  'session.created',
  'session.updated',
  'session.status',
  'session.error',
  'session.idle',
  'session.turn.close',
  'question.asked',
  'question.replied',
  'question.rejected',
  'permission.asked',
  'permission.replied',
]);

export const pendingInteractionsSchema = z.object({
  revision: z.number().int().nonnegative(),
  questions: z.array(z.unknown()),
  permissions: z.array(z.unknown()),
});

export type PendingInteractions = z.infer<typeof pendingInteractionsSchema>;

const interactionIdentitySchema = z.object({ id: z.string().min(1) }).passthrough();
const interactionReplySchema = z.object({ requestID: z.string().min(1) });

export function applyPendingInteractionEvent(
  snapshot: PendingInteractions | undefined,
  payload: SandboxControlSessionEventInput
): PendingInteractions | undefined {
  let collection: 'questions' | 'permissions';
  switch (payload.type) {
    case 'question.asked':
    case 'question.replied':
    case 'question.rejected':
      collection = 'questions';
      break;
    case 'permission.asked':
    case 'permission.replied':
      collection = 'permissions';
      break;
    default:
      return undefined;
  }
  const asked = payload.type.endsWith('.asked');
  if (!snapshot && !asked) return undefined;
  const request = asked ? interactionIdentitySchema.safeParse(payload.properties) : undefined;
  const reply = asked ? undefined : interactionReplySchema.safeParse(payload.properties);
  const id = request?.success ? request.data.id : reply?.success ? reply.data.requestID : undefined;
  if (!id) return undefined;
  const current = snapshot ?? { revision: 0, questions: [], permissions: [] };
  const remaining = current[collection].filter(item => {
    const parsed = interactionIdentitySchema.safeParse(item);
    return !parsed.success || parsed.data.id !== id;
  });
  return {
    ...current,
    revision: current.revision + 1,
    [collection]: asked ? [...remaining, payload.properties] : remaining,
  };
}

export type SandboxControlEventQueries = {
  insertUnique(params: {
    executionId: string;
    sessionId: string;
    streamEventType: string;
    payload: string;
    timestamp: number;
    entityId: string;
  }): EventId | null;
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
  const commit =
    params.payload.type === 'autocommit_completed' && params.payload.properties.skipped !== true
      ? autoCommitRecordSchema.safeParse(params.payload.properties)
      : undefined;
  if (commit?.success) {
    const timestamp = Date.parse(commit.data.committedAt);
    const payload = JSON.stringify({
      type: params.payload.type,
      event: params.payload.type,
      properties: { ...params.payload.properties, ...commit.data },
    });
    const eventId = params.eventQueries.insertUnique({
      executionId: '',
      sessionId: params.sessionId,
      streamEventType: 'kilocode',
      payload,
      timestamp,
      entityId: `commit/${commit.data.commitHash}`,
    });
    if (eventId === null) return { applied: true };
    params.broadcast({
      id: eventId,
      execution_id: '',
      session_id: params.sessionId,
      stream_event_type: 'kilocode',
      payload,
      timestamp,
    });
    return { applied: true };
  }
  const timestamp = params.payload.timestamp ? Date.parse(params.payload.timestamp) : Date.now();
  const payload = JSON.stringify({
    type: params.payload.type,
    event: params.payload.type,
    properties: params.payload.properties,
  });
  const entityId =
    params.payload.type === 'autocommit_completed' &&
    typeof params.payload.properties.messageId === 'string'
      ? `autocommit/${params.payload.properties.messageId}`
      : extractEntityId(params.payload.type, { properties: params.payload.properties });
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
