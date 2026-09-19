import { storage } from '#imports';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { conversationEventsSchema, storedConversationsSchema } from './agent-conversation-schemas';
import { toPersistedConversationEvents } from '@/src/shared/agent-conversation-persistence';
import type { AgentConversationEvent } from '@/src/shared/agent-conversation';
import { normalizeStoredConversations } from '@/src/shared/agent-conversation-tabs';
import type { StoredAgentConversationStore } from '@/src/shared/agent-conversation-tabs';
export {
  closeStoredConversation,
  closeStoredConversationTab,
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

// The retired page tools, mapped to the Playwright MCP tool that replaced each.
const LEGACY_PAGE_TOOL_NAMES = {
  find_in_page: 'kilo_browser_find',
  get_element_details: 'kilo_browser_snapshot',
  get_page_snapshot: 'kilo_browser_snapshot',
  get_viewport_screenshot: 'kilo_browser_take_screenshot',
} as const;
type LegacyPageToolName = keyof typeof LEGACY_PAGE_TOOL_NAMES;
const isLegacyPageToolName = (name: string): name is LegacyPageToolName =>
  Object.hasOwn(LEGACY_PAGE_TOOL_NAMES, name);

// The retired call's fields are renamed to the replacement tool's arguments, so the migrated call carries names the replacement accepts.
const toMigratedBrowserArguments = (
  legacyName: LegacyPageToolName,
  event: {
    readonly elementId?: string | undefined;
    readonly query?: string | undefined;
  }
) => {
  switch (legacyName) {
    case 'find_in_page': {
      return event.query === undefined ? {} : { text: event.query };
    }
    case 'get_element_details': {
      return event.elementId === undefined ? {} : { target: event.elementId };
    }
    case 'get_page_snapshot': {
      return {};
    }
    case 'get_viewport_screenshot': {
      // `scale` is required by the vendored browser_take_screenshot contract; the retired viewport screenshot was CSS-scaled.
      return { scale: 'css' };
    }
  }
};

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
        // WebMCP events carry a webMcpOrigin field; must precede the call-shape branches.
        if ('webMcpOrigin' in event) {
          events.push({
            arguments: event.arguments,
            definitionSignature: event.definitionSignature,
            documentId: event.documentId,
            id: event.id,
            name: event.name,
            ...(event.providerToolCallId === undefined
              ? {}
              : { providerToolCallId: event.providerToolCallId }),
            ...(event.reasoningDetails === undefined
              ? {}
              : { reasoningDetails: event.reasoningDetails }),
            tabId: event.tabId,
            type: event.type,
            webMcpOrigin: event.webMcpOrigin,
          });
          break;
        }
        // A persisted eval call predates the Playwright tools; load it as the evaluate tool.
        if ('code' in event) {
          events.push({
            arguments: { function: event.code },
            id: event.id,
            name: 'kilo_browser_evaluate',
            ...(event.providerToolCallId === undefined
              ? {}
              : { providerToolCallId: event.providerToolCallId }),
            ...(event.reasoningDetails === undefined
              ? {}
              : { reasoningDetails: event.reasoningDetails }),
            tabId: event.tabId,
            type: event.type,
          });
          break;
        }
        // Remote MCP events carry a remoteToolName field.
        if ('remoteToolName' in event) {
          events.push({
            arguments: event.arguments,
            id: event.id,
            name: event.name,
            ...(event.providerToolCallId === undefined
              ? {}
              : { providerToolCallId: event.providerToolCallId }),
            ...(event.reasoningDetails === undefined
              ? {}
              : { reasoningDetails: event.reasoningDetails }),
            remoteToolName: event.remoteToolName,
            serverId: event.serverId,
            serverName: event.serverName,
            type: event.type,
          });
          break;
        }
        // Browser and workflow calls share one shape, so the parsed event is already the event to keep; the optional fields are normalized for the union's exact optional type.
        if ('arguments' in event) {
          const { providerToolCallId, reasoningDetails, ...call } = event;
          events.push({
            ...call,
            ...(providerToolCallId === undefined ? {} : { providerToolCallId }),
            ...(reasoningDetails === undefined ? {} : { reasoningDetails }),
          });
          break;
        }
        // A persisted retired page tool predates the Playwright tools; load it as its replacement.
        if (isLegacyPageToolName(event.name)) {
          events.push({
            arguments: toMigratedBrowserArguments(event.name, event),
            id: event.id,
            name: LEGACY_PAGE_TOOL_NAMES[event.name],
            ...(event.providerToolCallId === undefined
              ? {}
              : { providerToolCallId: event.providerToolCallId }),
            ...(event.reasoningDetails === undefined
              ? {}
              : { reasoningDetails: event.reasoningDetails }),
            tabId: event.tabId,
            type: event.type,
          });
          break;
        }
        events.push({
          ...(event.elementId === undefined ? {} : { elementId: event.elementId }),
          id: event.id,
          ...(event.memoryId === undefined ? {} : { memoryId: event.memoryId }),
          name: event.name,
          ...(event.providerToolCallId === undefined
            ? {}
            : { providerToolCallId: event.providerToolCallId }),
          ...(event.query === undefined ? {} : { query: event.query }),
          ...(event.reasoningDetails === undefined
            ? {}
            : { reasoningDetails: event.reasoningDetails }),
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

export const normalizeStoredConversationStore = (
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

export const toPersistedConversationStore = (
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
