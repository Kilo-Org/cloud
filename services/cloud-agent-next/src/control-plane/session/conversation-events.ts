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

/** Native transcript rows use the same cursor and retention as v1 rows. */
export function persistConversationEvent(input: {
  sessionId: string;
  event: SandboxControlSessionEventInput;
  queries: SessionEventQueries;
}): StoredEvent | null {
  const { event, queries, sessionId } = input;
  const timestamp = Date.now();
  let entityId: string | undefined;
  const liveProperties = publicEventProperties(event);
  let properties: Record<string, unknown> = liveProperties;
  let type = event.type;
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
    if (kind) {
      const text = z
        .object({
          assistantMessageID: z.string(),
          ordinal: z.number().int().nonnegative(),
          delta: z.string().optional(),
          text: z.string().optional(),
        })
        .safeParse(native.data);
      if (!text.success) return null;
      entityId = `message/${text.data.assistantMessageID}`;
      const previous = queries.findByEntityId(entityId);
      const envelope = z
        .object({ properties: kilo2ConversationMessageSchema })
        .safeParse(previous ? JSON.parse(previous.payload) : undefined);
      if (envelope.success && envelope.data.properties.sessionID === parsed.data.sessionID) {
        const prior = envelope.data.properties;
        // A database snapshot can overtake its event stream. A completed native
        // message already owns the full text; earlier deltas must not append it again.
        if (prior.message.time.completed === undefined) {
          const content = [...(prior.message.content ?? [])];
          const indices = content.flatMap((part, index) => (part.type === kind ? [index] : []));
          const index = indices[text.data.ordinal];
          const existing = index === undefined ? undefined : content[index];
          const value = native.type.endsWith('.delta')
            ? (existing?.text ?? '') + (text.data.delta ?? '')
            : (text.data.text ?? '');
          const part = { ...existing, type: kind, text: value };
          if (index === undefined) content.push(part);
          else content[index] = part;
          type = 'conversation.message.updated';
          properties = { ...prior, message: { ...prior.message, content } };
        } else entityId = undefined;
      } else entityId = undefined;
    }
  } else return null;
  const payload = (name: string, data: Record<string, unknown>) =>
    JSON.stringify({
      type: name,
      event: name,
      properties: data,
    });
  const id =
    entityId === undefined
      ? 0
      : queries.upsert({
          executionId: '',
          sessionId,
          streamEventType: 'kilocode',
          payload: payload(type, properties),
          timestamp,
          entityId,
        });
  return {
    id,
    execution_id: '',
    session_id: sessionId,
    stream_event_type: 'kilocode',
    payload: payload(event.type, liveProperties),
    timestamp,
    mutation_cursor: queries.getUpdateCursor(),
  };
}
