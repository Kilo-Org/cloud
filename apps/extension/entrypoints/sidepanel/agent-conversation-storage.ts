import { storage } from '#imports';
import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { z } from 'zod';
import { toPersistedConversationEvents } from '@/src/shared/agent-conversation-persistence';
import type { AgentConversationEvent } from '@/src/shared/agent-conversation';

const conversationStorageKey = 'local:kiloAgentConversation';
const conversationEventSchema = z.union([
  z.object({
    id: z.string(),
    role: z.enum(['assistant', 'user']),
    systemEnvironment: z.string().optional(),
    text: z.string(),
    type: z.literal('message'),
  }),
  z.object({
    id: z.string(),
    text: z.string(),
    type: z.literal('thinking'),
  }),
  z.object({
    code: z.string(),
    id: z.string(),
    name: z.literal('eval'),
    providerToolCallId: z.string().optional(),
    tabId: z.number(),
    type: z.literal('tool-call'),
  }),
  z.object({
    elementId: z.string().optional(),
    id: z.string(),
    name: z.enum([
      'find_in_page',
      'get_element_details',
      'get_page_snapshot',
      'get_viewport_screenshot',
    ]),
    providerToolCallId: z.string().optional(),
    query: z.string().optional(),
    snapshotId: z.string().optional(),
    tabId: z.number(),
    type: z.literal('tool-call'),
  }),
  z.object({
    error: z.string().optional(),
    id: z.string(),
    ok: z.boolean(),
    toolCallId: z.string(),
    type: z.literal('tool-result'),
    value: z.unknown().optional(),
  }),
]);
const conversationEventsSchema = z.array(conversationEventSchema);

const normalizeConversationEvents = (value: unknown): AgentConversationEvent[] | undefined => {
  const parsed = conversationEventsSchema.safeParse(value);

  if (!parsed.success) {
    return undefined;
  }

  const events: AgentConversationEvent[] = [];

  for (const event of parsed.data) {
    switch (event.type) {
      case 'message': {
        events.push({
          id: event.id,
          role: event.role,
          ...(event.systemEnvironment === undefined
            ? {}
            : { systemEnvironment: event.systemEnvironment }),
          text: event.text,
          type: event.type,
        });
        break;
      }
      case 'thinking': {
        events.push(event);
        break;
      }
      case 'tool-result': {
        events.push({
          ...(event.error === undefined ? {} : { error: event.error }),
          id: event.id,
          ok: event.ok,
          toolCallId: event.toolCallId,
          type: event.type,
          ...(event.value === undefined ? {} : { value: event.value }),
        });
        break;
      }
      case 'tool-call': {
        if (event.name === 'eval') {
          events.push({
            code: event.code,
            id: event.id,
            name: event.name,
            ...(event.providerToolCallId === undefined
              ? {}
              : { providerToolCallId: event.providerToolCallId }),
            tabId: event.tabId,
            type: event.type,
          });
          break;
        }

        events.push({
          ...(event.elementId === undefined ? {} : { elementId: event.elementId }),
          id: event.id,
          name: event.name,
          ...(event.providerToolCallId === undefined
            ? {}
            : { providerToolCallId: event.providerToolCallId }),
          ...(event.query === undefined ? {} : { query: event.query }),
          ...(event.snapshotId === undefined ? {} : { snapshotId: event.snapshotId }),
          tabId: event.tabId,
          type: event.type,
        });
        break;
      }
    }
  }

  return events;
};

export const useStoredAgentConversation = (
  createDefaultEvents: () => AgentConversationEvent[]
): readonly [AgentConversationEvent[], Dispatch<SetStateAction<AgentConversationEvent[]>>] => {
  const [events, setEvents] = useState<AgentConversationEvent[]>(createDefaultEvents);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    let isCurrent = true;

    void (async (): Promise<void> => {
      const storedEvents = normalizeConversationEvents(
        await storage.getItem(conversationStorageKey)
      );

      if (!isCurrent) {
        return;
      }

      setEvents(storedEvents ?? createDefaultEvents());
      setIsLoaded(true);
    })();

    return () => {
      isCurrent = false;
    };
  }, [createDefaultEvents]);

  useEffect(() => {
    if (isLoaded) {
      void storage.setItem(conversationStorageKey, toPersistedConversationEvents(events));
    }
  }, [events, isLoaded]);

  return [events, setEvents];
};
