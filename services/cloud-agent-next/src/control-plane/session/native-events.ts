import { autoCommitRecordSchema } from '@kilocode/worker-utils/cloud-agent-commits';
import { z } from 'zod';
import type { SandboxControlSessionEventInput } from '../../sandbox-session/sandbox-control-event.js';
import { slimPersistedKilocodeEvent } from '../../shared/ingest-frame.js';
import type { StoredEvent } from '../../websocket/types.js';
import type { SessionEventQueries } from './event-queries.js';

const record = z.record(z.string(), z.unknown());
const infoSchema = z
  .object({ id: z.string().min(1).max(256), sessionID: z.string().min(1) })
  .passthrough();
const partSchema = z
  .object({
    id: z.string().min(1).max(256),
    messageID: z.string().min(1).max(256),
    sessionID: z.string().min(1),
    type: z.string(),
  })
  .passthrough();
const removalSchema = z.object({
  messageID: z.string().min(1),
  sessionID: z.string().min(1),
  partID: z.string().optional(),
});
const deltaSchema = z.object({
  messageID: z.string(),
  sessionID: z.string(),
  partID: z.string(),
  field: z.literal('text'),
  delta: z.string(),
});
const sessionSchema = z.object({ id: z.string().min(1) }).passthrough();
const persistedNames = new Set([
  'session.error',
  'session.idle',
  'session.turn.close',
  'question.asked',
  'question.replied',
  'question.rejected',
  'permission.asked',
  'permission.replied',
]);

export const nativeEventPayloadSchema = z.object({
  type: z.string(),
  event: z.string(),
  properties: record,
});

export function readNativeEventPayload(payload: string) {
  try {
    return nativeEventPayloadSchema.safeParse(JSON.parse(payload)).data;
  } catch {
    return undefined;
  }
}

export function persistSessionEvent(input: {
  sessionId: string;
  event: SandboxControlSessionEventInput;
  queries: SessionEventQueries;
  seed?: boolean;
}): StoredEvent | null {
  const { queries, seed = false } = input;
  let type = input.event.type;
  let properties = input.event.properties;
  let entityId: string | undefined;
  let unique = seed;
  let timestamp =
    input.event.timestamp === undefined ? Date.now() : Date.parse(input.event.timestamp);
  if (!Number.isFinite(timestamp)) timestamp = Date.now();

  if (type === 'message.updated') {
    const parsed = infoSchema.safeParse(properties.info);
    if (!parsed.success) return null;
    entityId = `message/${parsed.data.id}`;
    const previous = queries.findByEntityId(entityId);
    const createdSchema = z.object({ time: z.object({ created: z.number().finite() }) });
    const created = createdSchema.safeParse(parsed.data);
    if (!created.success && previous !== null) {
      const prior = createdSchema.safeParse(
        readNativeEventPayload(previous.payload)?.properties.info
      );
      const time = record.safeParse(parsed.data.time);
      if (prior.success)
        properties = {
          ...properties,
          info: {
            ...parsed.data,
            time: { ...(time.success ? time.data : {}), created: prior.data.time.created },
          },
        };
    }
  } else if (type === 'message.part.updated') {
    const parsed = partSchema.safeParse(properties.part);
    if (!parsed.success) return null;
    entityId = `part/${parsed.data.messageID}/${parsed.data.id}`;
    if (
      (parsed.data.type === 'text' || parsed.data.type === 'reasoning') &&
      parsed.data.text === undefined
    ) {
      const previous = queries.findByEntityId(entityId);
      const prior =
        previous === null
          ? undefined
          : partSchema.safeParse(readNativeEventPayload(previous.payload)?.properties.part);
      if (
        prior?.success &&
        prior.data.sessionID === parsed.data.sessionID &&
        typeof prior.data.text === 'string'
      ) {
        properties = { ...properties, part: { ...parsed.data, text: prior.data.text } };
      }
    }
  } else if (type === 'message.part.delta') {
    const parsed = deltaSchema.safeParse(properties);
    if (!parsed.success) return null;
    entityId = `part/${parsed.data.messageID}/${parsed.data.partID}`;
    const previous = queries.findByEntityId(entityId);
    const priorPayload = previous === null ? undefined : readNativeEventPayload(previous.payload);
    if (priorPayload?.type === 'message.part.removed') return null;
    const prior = partSchema.safeParse(priorPayload?.properties.part);
    if (prior.success && prior.data.sessionID !== parsed.data.sessionID) return null;
    type = 'message.part.updated';
    properties = {
      part: {
        ...(prior.success
          ? prior.data
          : {
              id: parsed.data.partID,
              sessionID: parsed.data.sessionID,
              messageID: parsed.data.messageID,
              type: 'text',
            }),
        text:
          (prior.success && typeof prior.data.text === 'string' ? prior.data.text : '') +
          parsed.data.delta,
      },
    };
  } else if (type === 'message.removed' || type === 'message.part.removed') {
    const parsed = removalSchema.safeParse(properties);
    if (!parsed.success || (type === 'message.part.removed' && parsed.data.partID === undefined))
      return null;
    entityId =
      type === 'message.removed'
        ? `message/${parsed.data.messageID}`
        : `part/${parsed.data.messageID}/${parsed.data.partID}`;
  } else if (type === 'session.created' || type === 'session.updated') {
    const parsed = sessionSchema.safeParse(properties.info);
    if (!parsed.success) return null;
    entityId = `session/${parsed.data.id}`;
  } else if (type === 'session.status') {
    const parsed = z
      .object({ sessionID: z.string(), status: z.object({ type: z.string() }).passthrough() })
      .safeParse(properties);
    if (!parsed.success) return null;
    entityId = `status/${parsed.data.sessionID}`;
  } else if (type === 'autocommit_completed') {
    const commit =
      properties.skipped === true ? undefined : autoCommitRecordSchema.safeParse(properties);
    if (commit?.success) {
      entityId = `commit/${commit.data.commitHash}`;
      properties = { ...properties, ...commit.data };
      timestamp = Date.parse(commit.data.committedAt);
      unique = true;
    } else if (typeof properties.messageId === 'string') {
      entityId = `autocommit/${properties.messageId}`;
    }
  }

  const payload = JSON.stringify(slimPersistedKilocodeEvent({ type, event: type, properties }));
  const params = {
    executionId: '',
    sessionId: input.sessionId,
    streamEventType: 'kilocode',
    payload,
    timestamp,
  };
  const id =
    entityId === undefined
      ? persistedNames.has(type)
        ? queries.insert(params)
        : 0
      : unique
        ? queries.insertUnique({ ...params, entityId })
        : queries.upsert({ ...params, entityId });
  if (id === null) return null;
  return {
    id,
    execution_id: '',
    session_id: input.sessionId,
    stream_event_type: 'kilocode',
    payload: JSON.stringify({
      type: input.event.type,
      event: input.event.type,
      properties: input.event.properties,
    }),
    timestamp,
    ...(id === 0 ? {} : { mutation_cursor: queries.getUpdateCursor() }),
  };
}
