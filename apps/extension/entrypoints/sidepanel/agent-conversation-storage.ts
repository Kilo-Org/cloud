import { storage } from '#imports';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { z } from 'zod';
import { toPersistedConversationEvents } from '@/src/shared/agent-conversation-persistence';
import type { AgentConversationEvent } from '@/src/shared/agent-conversation';
import { normalizeStoredConversations } from '@/src/shared/agent-conversation-tabs';
import type { StoredAgentConversationStore } from '@/src/shared/agent-conversation-tabs';
export {
  closeStoredConversationTab,
  closeStoredConversation,
  createNextStoredConversation,
  deleteStoredConversation,
  getActiveStoredConversation,
  getOpenStoredConversations,
  getSortedStoredConversationHistory,
  getStoredConversationTitle,
  isStoredConversationEmpty,
  isStoredConversationOpen,
  openStoredConversation,
  setActiveStoredConversation,
  updateStoredConversationEvents,
  updateStoredConversationSettings,
} from '@/src/shared/agent-conversation-tabs';
export type { StoredAgentConversation } from '@/src/shared/agent-conversation-tabs';

const legacyConversationStorageKey = 'local:kiloAgentConversation';
const conversationStorageKey = 'local:kiloAgentConversations';
const conversationStoreQueryKey = ['side-panel', 'agent-conversations'] as const;
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
const storedConversationSchema = z.object({
  events: conversationEventsSchema,
  id: z.string(),
  mode: z.enum(['dangerous', 'safe']).optional(),
  model: z.string().optional(),
  selectedTabId: z.number().optional(),
  thinkingEffort: z.string().optional(),
  title: z.string(),
  updatedAt: z.string().optional(),
});
const storedConversationsSchema = z.object({
  activeConversationId: z.string(),
  conversations: z.array(storedConversationSchema),
  openConversationIds: z.array(z.string()).optional(),
});

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

const normalizeStoredConversationStore = (
  value: unknown
): StoredAgentConversationStore | undefined => {
  const parsed = storedConversationsSchema.safeParse(value);

  if (!parsed.success) {
    return undefined;
  }

  return normalizeStoredConversations({
    store: {
      activeConversationId: parsed.data.activeConversationId,
      conversations: parsed.data.conversations.map(conversation => ({
        events: normalizeConversationEvents(conversation.events) ?? [],
        id: conversation.id,
        ...(conversation.mode === undefined ? {} : { mode: conversation.mode }),
        ...(conversation.model === undefined ? {} : { model: conversation.model }),
        ...(conversation.selectedTabId === undefined
          ? {}
          : { selectedTabId: conversation.selectedTabId }),
        ...(conversation.thinkingEffort === undefined
          ? {}
          : { thinkingEffort: conversation.thinkingEffort }),
        title: conversation.title,
        updatedAt: conversation.updatedAt ?? new Date().toISOString(),
      })),
      openConversationIds: parsed.data.openConversationIds ?? [],
    },
  });
};

const toPersistedConversationStore = (
  store: StoredAgentConversationStore
): StoredAgentConversationStore => ({
  ...store,
  conversations: store.conversations.map(conversation => ({
    ...conversation,
    events: toPersistedConversationEvents(conversation.events),
  })),
});

const loadStoredConversationStore = async (
  createDefaultEvents: () => AgentConversationEvent[]
): Promise<StoredAgentConversationStore> => {
  const storedConversations = normalizeStoredConversationStore(
    await storage.getItem(conversationStorageKey)
  );
  const legacyEvents = normalizeConversationEvents(
    await storage.getItem(legacyConversationStorageKey)
  );

  return normalizeStoredConversations({
    defaultEvents: createDefaultEvents(),
    legacyEvents,
    store: storedConversations,
  });
};

export const useStoredAgentConversations = (
  createDefaultEvents: () => AgentConversationEvent[]
): readonly [
  StoredAgentConversationStore,
  Dispatch<SetStateAction<StoredAgentConversationStore>>,
  boolean,
] => {
  const [store, setStore] = useState<StoredAgentConversationStore>(() =>
    normalizeStoredConversations({ defaultEvents: createDefaultEvents() })
  );
  const [isLoaded, setIsLoaded] = useState(false);
  const { data: loadedStore, isSuccess } = useQuery({
    gcTime: 0,
    queryFn: () => loadStoredConversationStore(createDefaultEvents),
    queryKey: conversationStoreQueryKey,
  });

  useEffect(() => {
    if (isSuccess && loadedStore !== undefined) {
      setStore(loadedStore);
      setIsLoaded(true);
    }
  }, [isSuccess, loadedStore]);

  useEffect(() => {
    if (isLoaded) {
      void storage.setItem(conversationStorageKey, toPersistedConversationStore(store));
      void storage.removeItem(legacyConversationStorageKey);
    }
  }, [isLoaded, store]);

  return [store, setStore, isLoaded];
};
