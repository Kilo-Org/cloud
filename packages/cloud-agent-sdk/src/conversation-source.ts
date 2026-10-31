import { z } from 'zod';
import {
  kilo2ConversationEventSchema,
  kilo2ConversationMessageSchema,
} from '@kilocode/session-ingest-contracts';
import { normalize, type ChatEvent, type NormalizedEvent } from './normalizer';
import type { CloudAgentEvent } from './cloud-conversation-schemas';
import { kilo2PartId, readKilo2Messages } from './kilo2-source-messages';

export type ConversationSource = { version: 'v1' } | { version: 'v2' };

/** Select the native reader at the SDK boundary. Renderers receive display events. */
export function createConversationSourceReader() {
  const completed = new Set<string>();
  function readV2(type: string, properties: unknown): NormalizedEvent[] {
    if (type === 'conversation.message.updated') {
      const parsed = kilo2ConversationMessageSchema.safeParse(properties);
      if (!parsed.success) return [];
      const { source, message, parentID } = parsed.data;
      if (message.time.completed !== undefined) {
        completed.add(message.id);
        if (completed.size > 2048) {
          const oldest = completed.values().next().value;
          if (oldest) completed.delete(oldest);
        }
      }
      const display = readKilo2Messages(source.session, [message])[0];
      if (!display) return [];
      if (display.info.role === 'assistant' && parentID !== undefined)
        display.info.parentID = parentID;
      return [
        { type: 'message.updated', info: display.info },
        ...display.parts.map((part): ChatEvent => ({ type: 'message.part.updated', part })),
      ];
    }
    if (type !== 'conversation.event') return [];
    const parsed = kilo2ConversationEventSchema.safeParse(properties);
    if (!parsed.success) return [];
    const event = parsed.data.event;
    const kind = event.type.startsWith('session.text.')
      ? 'text'
      : event.type.startsWith('session.reasoning.')
        ? 'reasoning'
        : undefined;
    if (!kind) return [];
    const data = z
      .object({
        assistantMessageID: z.string(),
        ordinal: z.number().int().nonnegative(),
        delta: z.string().optional(),
        text: z.string().optional(),
      })
      .safeParse(event.data);
    if (!data.success || completed.has(data.data.assistantMessageID)) return [];
    const id = kilo2PartId(data.data.assistantMessageID, kind, data.data.ordinal);
    if (event.type.endsWith('.delta'))
      return [
        {
          type: 'message.part.delta',
          sessionId: parsed.data.sessionID,
          messageId: data.data.assistantMessageID,
          partId: id,
          field: 'text',
          delta: data.data.delta ?? '',
        },
      ];
    return [
      {
        type: 'message.part.updated',
        part: {
          id,
          sessionID: parsed.data.sessionID,
          messageID: data.data.assistantMessageID,
          text: data.data.text ?? '',
          ...(kind === 'reasoning'
            ? ({ type: 'reasoning', time: { start: event.created ?? 0 } } as const)
            : ({ type: 'text' } as const)),
        },
      },
    ];
  }
  return {
    read(raw: CloudAgentEvent): { source: ConversationSource; events: NormalizedEvent[] } {
      const envelope = z.object({ type: z.string(), properties: z.unknown() }).safeParse(raw.data);
      if (
        raw.streamEventType === 'kilocode' &&
        envelope.success &&
        envelope.data.type.startsWith('conversation.')
      )
        return {
          source: { version: 'v2' },
          events: readV2(envelope.data.type, envelope.data.properties),
        };
      const event = normalize(raw);
      return { source: { version: 'v1' }, events: event ? [event] : [] };
    },
  };
}
