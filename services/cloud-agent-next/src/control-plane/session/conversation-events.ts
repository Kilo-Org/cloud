import { z } from 'zod';
import {
  kilo2ConversationEventSchema,
  kilo2ConversationMessageSchema,
  kilo2ConversationSourceSchema,
} from '@kilocode/session-ingest-contracts';
import {
  publicEventProperties,
  type SandboxControlSessionEventInput,
} from '../../sandbox-session/sandbox-control-event.js';
import type { StoredEvent } from '../../websocket/types.js';
import type { SessionEventQueries } from './event-queries.js';
import type { BufferedMessageText, PartTextBuffer } from './part-text-buffer.js';

const textEventSchema = z.object({
  assistantMessageID: z.string(),
  ordinal: z.number().int().nonnegative(),
  delta: z.string().optional(),
  text: z.string().optional(),
});

/** Native transcript rows use the same cursor and retention as v1 rows. */
export function persistConversationEvent(input: {
  sessionId: string;
  event: SandboxControlSessionEventInput;
  queries: SessionEventQueries;
  partText: PartTextBuffer;
}): StoredEvent | null {
  const { event, queries, sessionId } = input;
  const timestamp = Date.now();
  let entityId: string;
  const liveProperties = publicEventProperties(event);
  let properties: Record<string, unknown> = liveProperties;
  let type = event.type;
  const stored = (id: number): StoredEvent => ({
    id,
    execution_id: '',
    session_id: sessionId,
    stream_event_type: 'kilocode',
    payload: payload(event.type, liveProperties),
    timestamp,
    // An unpersisted delta has no row revision; borrowing the current cursor would make
    // clients treat later deltas for the same part as duplicates.
    ...(id === 0 ? {} : { mutation_cursor: queries.getUpdateCursor() }),
  });
  if (type === 'conversation.source') {
    const source = kilo2ConversationSourceSchema.safeParse(properties.source);
    if (!source.success || properties.sessionID !== source.data.session.id) return null;
    entityId = `conversation-source/${source.data.session.id}`;
    properties = { sessionID: source.data.session.id, source: source.data };
  } else if (type === 'conversation.message.updated') {
    const parsed = kilo2ConversationMessageSchema.safeParse(properties);
    if (!parsed.success) return null;
    properties = parsed.data;
    entityId = `message/${parsed.data.message.id}`;
  } else if (type === 'conversation.event') {
    const parsed = kilo2ConversationEventSchema.safeParse(properties);
    if (!parsed.success) return null;
    const native = parsed.data.event;
    const kind = native.type.startsWith('session.text.')
      ? 'text'
      : native.type.startsWith('session.reasoning.')
        ? 'reasoning'
        : undefined;
    // Other native events are live only and touch no row.
    if (!kind) return stored(0);
    const text = textEventSchema.safeParse(native.data);
    if (!text.success) return null;
    const delta = native.type.endsWith('.delta');
    const messageEntityId = `message/${text.data.assistantMessageID}`;
    if (!delta) input.partText.flush();
    const buffered =
      (delta ? input.partText.get(messageEntityId, 'message') : undefined) ??
      bufferFromRow(queries, messageEntityId, sessionId, timestamp);
    if (buffered === undefined || buffered.properties.sessionID !== parsed.data.sessionID)
      return stored(0);
    const content = [...(buffered.properties.message.content ?? [])];
    const indices = content.flatMap((part, index) => (part.type === kind ? [index] : []));
    const index = indices[text.data.ordinal];
    const existing = index === undefined ? undefined : content[index];
    const part = {
      ...existing,
      type: kind,
      text: delta ? (existing?.text ?? '') + (text.data.delta ?? '') : (text.data.text ?? ''),
    };
    if (index === undefined) content.push(part);
    else content[index] = part;
    const next = {
      ...buffered.properties,
      message: { ...buffered.properties.message, content },
    };
    if (delta) {
      // Take the cursor before the buffer change: a failed write must not keep the text.
      queries.advanceCursor();
      input.partText.set(messageEntityId, { ...buffered, properties: next, timestamp });
      return stored(buffered.rowId);
    }
    entityId = messageEntityId;
    type = 'conversation.message.updated';
    properties = next;
  } else return null;
  // Every row write sees, and is ordered after, the text streamed before it.
  input.partText.flush();
  return stored(
    queries.upsert({
      executionId: '',
      sessionId,
      streamEventType: 'kilocode',
      payload: payload(type, properties),
      timestamp,
      entityId,
    })
  );
}

function payload(name: string, data: Record<string, unknown>) {
  return JSON.stringify({ type: name, event: name, properties: data });
}

/**
 * The stored message that streamed text extends, as a buffer entry it owns.
 *
 * A database snapshot can overtake its event stream. A completed native message
 * already owns the full text; earlier deltas must not append it again.
 */
function bufferFromRow(
  queries: SessionEventQueries,
  entityId: string,
  sessionId: string,
  timestamp: number
): BufferedMessageText | undefined {
  const previous = queries.findByEntityId(entityId);
  if (previous === null) return undefined;
  const envelope = z
    .object({ properties: kilo2ConversationMessageSchema })
    .safeParse(JSON.parse(previous.payload));
  if (!envelope.success || envelope.data.properties.message.time.completed !== undefined)
    return undefined;
  return {
    kind: 'message',
    rowId: previous.id,
    sessionId,
    timestamp,
    properties: envelope.data.properties,
  };
}
