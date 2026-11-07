import { z } from 'zod';
import {
  kilo2ConversationEventSchema,
  kilo2ConversationMessageSchema,
  kilo2PartId,
} from '@kilocode/session-ingest-contracts';
import { normalize, type ChatEvent, type NormalizedEvent } from './normalizer';
import type { CloudAgentEvent } from './cloud-conversation-schemas';
import {
  readKilo2ContentLayout,
  readKilo2Messages,
  type Kilo2ContentLayout,
} from './kilo2-source-messages';
import type { SessionSnapshot } from './types';

const MAX_TRACKED_MESSAGES = 2048;

/** Sets `key` as the newest entry, evicting the oldest past the bound. */
function remember<V>(map: Map<string, V>, key: string, value: V) {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_TRACKED_MESSAGES) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

export type ConversationSource = { version: 'v1' } | { version: 'v2' };

/** Select the native reader at the SDK boundary. Renderers receive display events. */
function positionFromPartId(messageId: string, partId: string): number | undefined {
  const prefix = `${messageId}_`;
  if (!partId.startsWith(prefix)) return undefined;
  const suffix = partId.slice(prefix.length);
  // Tool-result files are derivative attachments of a native content position.
  if (!/^\d{6}(?:_file_\d+)?$/.test(suffix)) return undefined;
  return Number(suffix.slice(0, 6));
}

function layoutFromProjected(
  message: SessionSnapshot['messages'][number]
): Kilo2ContentLayout | undefined {
  const located = message.parts.map(part => positionFromPartId(message.info.id, part.id));
  if (located.some(position => position === undefined)) return undefined;
  const summary = message.info.role === 'assistant' && message.info.summary === true;
  const ordinals = new Map<string, number>();
  const positions = new Map<string, number>();
  let next = 0;
  for (const [index, part] of message.parts.entries()) {
    const position = located[index];
    if (position === undefined) return undefined;
    next = Math.max(next, position + 1);
    if (summary && position === 0 && part.type === 'text') continue;
    if (part.type !== 'text' && part.type !== 'reasoning') continue;
    const ordinal = ordinals.get(part.type) ?? 0;
    ordinals.set(part.type, ordinal + 1);
    positions.set(`${part.type}:${ordinal}`, position);
  }
  return { positions, next };
}

export function createConversationSourceReader() {
  const completed = new Set<string>();
  // Native content order is array position; a text event names its part by ordinal.
  const layouts = new Map<string, Kilo2ContentLayout>();
  const reasoningStarts = new Map<string, Map<string, number>>();
  function observeReasoning(
    messageId: string,
    parts: SessionSnapshot['messages'][number]['parts']
  ) {
    const starts = reasoningStarts.get(messageId) ?? new Map<string, number>();
    for (const part of parts)
      if (part.type === 'reasoning' && !starts.has(part.id)) starts.set(part.id, part.time.start);
    if (starts.size) remember(reasoningStarts, messageId, starts);
  }
  function positionOf(messageId: string, kind: string, ordinal: number): number {
    const layout = layouts.get(messageId) ?? {
      positions: new Map<string, number>(),
      next: 0,
    };
    let position = layout.positions.get(`${kind}:${ordinal}`);
    if (position === undefined) {
      // A started item is appended, as the native message appends it.
      position = layout.next++;
      layout.positions.set(`${kind}:${ordinal}`, position);
    }
    remember(layouts, messageId, layout);
    return position;
  }
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
      remember(layouts, message.id, readKilo2ContentLayout(message));
      const display = readKilo2Messages(source.session, [message])[0];
      if (!display) return [];
      observeReasoning(message.id, display.parts);
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
    const id = kilo2PartId(
      data.data.assistantMessageID,
      positionOf(data.data.assistantMessageID, kind, data.data.ordinal)
    );
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
    let reasoningTime: { start: number; end?: number } | undefined;
    if (kind === 'reasoning') {
      const starts = reasoningStarts.get(data.data.assistantMessageID) ?? new Map<string, number>();
      const start = starts.get(id) ?? event.created ?? 0;
      starts.set(id, start);
      remember(reasoningStarts, data.data.assistantMessageID, starts);
      reasoningTime = {
        start,
        ...(event.type.endsWith('.ended') ? { end: event.created ?? start } : {}),
      };
    }
    return [
      {
        type: 'message.part.updated',
        part: {
          id,
          sessionID: parsed.data.sessionID,
          messageID: data.data.assistantMessageID,
          text: data.data.text ?? '',
          ...(reasoningTime
            ? ({ type: 'reasoning', time: reasoningTime } as const)
            : ({ type: 'text' } as const)),
        },
      },
    ];
  }
  return {
    observeProjected(messages: SessionSnapshot['messages']): void {
      for (const message of messages) {
        observeReasoning(message.info.id, message.parts);
        const layout = layoutFromProjected(message);
        if (!layout) continue;
        // A page read while the message streams can be older than the live layout.
        const live = layouts.get(message.info.id);
        if (live) {
          for (const [item, position] of live.positions)
            if (!layout.positions.has(item)) layout.positions.set(item, position);
          layout.next = Math.max(layout.next, live.next);
        }
        remember(layouts, message.info.id, layout);
      }
    },
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
