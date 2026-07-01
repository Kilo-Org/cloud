/* eslint-disable max-lines */
import type { AgentConversationEvent, AgentMode } from './agent-conversation';

export interface StoredAgentConversation {
  readonly events: AgentConversationEvent[];
  readonly id: string;
  readonly mode?: AgentMode;
  readonly model?: string;
  readonly selectedTabId?: number;
  readonly thinkingEffort?: string;
  readonly title: string;
  readonly updatedAt: string;
}

export interface StoredAgentConversationStore {
  readonly activeConversationId: string;
  readonly conversations: StoredAgentConversation[];
  readonly openConversationIds: string[];
}
type StoredConversationSettings = Partial<
  Pick<StoredAgentConversation, 'mode' | 'model' | 'thinkingEffort'>
> & {
  readonly selectedTabId?: number | undefined;
};
interface CreateStoredConversationOptions {
  readonly defaultEvents?: AgentConversationEvent[];
  readonly number: number;
  readonly settings?: StoredConversationSettings;
  readonly titleNumber?: number;
}

const conversationIdPrefix = 'conversation-';
const defaultConversationTitlePrefix = 'Conversation';
const maxTitleLength = 36;

const getConversationNumber = (id: string): number => {
  if (!id.startsWith(conversationIdPrefix)) {
    return 0;
  }

  const value = Number(id.slice(conversationIdPrefix.length));

  return Number.isInteger(value) && value > 0 ? value : 0;
};

const getNextConversationNumber = (conversations: StoredAgentConversation[]): number =>
  conversations.reduce(
    (maxNumber, conversation) => Math.max(maxNumber, getConversationNumber(conversation.id)),
    0
  ) + 1;

const createConversationId = (number: number): string => `${conversationIdPrefix}${number}`;
const createConversationTitle = (number: number): string =>
  `${defaultConversationTitlePrefix} ${number}`;
const nowIso = (): string => new Date().toISOString();

const removeSelectedTabId = (conversation: StoredAgentConversation): StoredAgentConversation => ({
  events: conversation.events,
  id: conversation.id,
  ...(conversation.mode === undefined ? {} : { mode: conversation.mode }),
  ...(conversation.model === undefined ? {} : { model: conversation.model }),
  ...(conversation.thinkingEffort === undefined
    ? {}
    : { thinkingEffort: conversation.thinkingEffort }),
  title: conversation.title,
  updatedAt: conversation.updatedAt,
});

const applyStoredConversationSettings = (
  conversation: StoredAgentConversation,
  settings: StoredConversationSettings
): StoredAgentConversation => {
  const conversationWithSettings: StoredAgentConversation = {
    ...conversation,
    ...(settings.mode === undefined ? {} : { mode: settings.mode }),
    ...(settings.model === undefined ? {} : { model: settings.model }),
    ...(settings.thinkingEffort === undefined ? {} : { thinkingEffort: settings.thinkingEffort }),
  };

  if (!('selectedTabId' in settings)) {
    return conversationWithSettings;
  }

  return settings.selectedTabId === undefined
    ? removeSelectedTabId(conversationWithSettings)
    : { ...conversationWithSettings, selectedTabId: settings.selectedTabId };
};

const isUserMessage = (event: AgentConversationEvent): boolean =>
  event.type === 'message' && event.role === 'user';

const getOpenConversationIds = (store: StoredAgentConversationStore): string[] =>
  store.openConversationIds.filter(conversationId =>
    store.conversations.some(conversation => conversation.id === conversationId)
  );

export const createDefaultStoredConversations = (
  defaultEvents: AgentConversationEvent[] = []
): StoredAgentConversationStore => {
  const conversationId = createConversationId(1);

  return {
    activeConversationId: conversationId,
    conversations: [
      {
        events: defaultEvents,
        id: conversationId,
        title: createConversationTitle(1),
        updatedAt: nowIso(),
      },
    ],
    openConversationIds: [conversationId],
  };
};

const createStoredConversation = ({
  defaultEvents = [],
  number,
  settings = {},
  titleNumber = number,
}: CreateStoredConversationOptions): StoredAgentConversation =>
  applyStoredConversationSettings(
    {
      events: defaultEvents,
      id: createConversationId(number),
      title: createConversationTitle(titleNumber),
      updatedAt: nowIso(),
    },
    settings
  );

const createFallbackOpenConversation = (
  store: StoredAgentConversationStore,
  defaultEvents: AgentConversationEvent[] = []
): StoredAgentConversation => {
  const nextNumber = getNextConversationNumber(store.conversations);

  return createStoredConversation({ defaultEvents, number: nextNumber, titleNumber: 1 });
};

export const getOpenStoredConversations = (
  store: StoredAgentConversationStore
): StoredAgentConversation[] =>
  getOpenConversationIds(store)
    .map(conversationId =>
      store.conversations.find(conversation => conversation.id === conversationId)
    )
    .filter((conversation): conversation is StoredAgentConversation => conversation !== undefined);

export const getSortedStoredConversationHistory = (
  store: StoredAgentConversationStore
): StoredAgentConversation[] =>
  store.conversations.toSorted((first, second) => second.updatedAt.localeCompare(first.updatedAt));

export const isStoredConversationOpen = (
  store: StoredAgentConversationStore,
  conversationId: string
): boolean => getOpenConversationIds(store).includes(conversationId);

export const isStoredConversationEmpty = (conversation: StoredAgentConversation): boolean =>
  !conversation.events.some(isUserMessage);

const ensureOpenConversation = (
  store: StoredAgentConversationStore,
  defaultEvents: AgentConversationEvent[] = []
): StoredAgentConversationStore => {
  const openConversationIds = getOpenConversationIds(store);

  if (openConversationIds.length > 0) {
    return openConversationIds.includes(store.activeConversationId)
      ? { ...store, openConversationIds }
      : { ...store, activeConversationId: openConversationIds[0] ?? '', openConversationIds };
  }

  const conversation = createFallbackOpenConversation(store, defaultEvents);

  return {
    activeConversationId: conversation.id,
    conversations: [...store.conversations, conversation],
    openConversationIds: [conversation.id],
  };
};

export const createNextStoredConversation = (
  store: StoredAgentConversationStore,
  defaultEvents: AgentConversationEvent[] = [],
  settings: StoredConversationSettings = {}
): StoredAgentConversationStore => {
  const nextNumber = getNextConversationNumber(store.conversations);
  const conversation = createStoredConversation({ defaultEvents, number: nextNumber, settings });

  return {
    activeConversationId: conversation.id,
    conversations: [...store.conversations, conversation],
    openConversationIds: [...getOpenConversationIds(store), conversation.id],
  };
};

export const getActiveStoredConversation = (
  store: StoredAgentConversationStore
): StoredAgentConversation => {
  const activeConversation = store.conversations.find(
    conversation => conversation.id === store.activeConversationId
  );

  return (
    activeConversation ??
    getOpenStoredConversations(store)[0] ??
    createStoredConversation({ number: 1 })
  );
};

export const setActiveStoredConversation = (
  store: StoredAgentConversationStore,
  conversationId: string
): StoredAgentConversationStore =>
  isStoredConversationOpen(store, conversationId)
    ? { ...store, activeConversationId: conversationId }
    : store;

export const updateStoredConversationEvents = (
  store: StoredAgentConversationStore,
  conversationId: string,
  updateEvents: (events: AgentConversationEvent[]) => AgentConversationEvent[]
): StoredAgentConversationStore => ({
  ...store,
  conversations: store.conversations.map(conversation =>
    conversation.id === conversationId
      ? { ...conversation, events: updateEvents(conversation.events), updatedAt: nowIso() }
      : conversation
  ),
});

export const updateStoredConversationSettings = (
  store: StoredAgentConversationStore,
  conversationId: string,
  settings: StoredConversationSettings
): StoredAgentConversationStore => ({
  ...store,
  conversations: store.conversations.map(conversation =>
    conversation.id === conversationId
      ? applyStoredConversationSettings(conversation, settings)
      : conversation
  ),
});

export const updateActiveStoredConversationEvents = (
  store: StoredAgentConversationStore,
  events: AgentConversationEvent[]
): StoredAgentConversationStore =>
  updateStoredConversationEvents(store, store.activeConversationId, () => events);

export const closeStoredConversationTab = (
  store: StoredAgentConversationStore,
  conversationId: string,
  defaultEvents: AgentConversationEvent[] = []
): StoredAgentConversationStore => {
  if (!isStoredConversationOpen(store, conversationId)) {
    return store;
  }

  const openConversationIds = getOpenConversationIds(store).filter(
    currentId => currentId !== conversationId
  );
  const nextStore = {
    ...store,
    activeConversationId:
      store.activeConversationId === conversationId
        ? (openConversationIds[0] ?? '')
        : store.activeConversationId,
    openConversationIds,
  };

  return ensureOpenConversation(nextStore, defaultEvents);
};

export const deleteStoredConversation = (
  store: StoredAgentConversationStore,
  conversationId: string,
  defaultEvents: AgentConversationEvent[] = []
): StoredAgentConversationStore => {
  if (!store.conversations.some(conversation => conversation.id === conversationId)) {
    return store;
  }

  const conversations = store.conversations.filter(
    conversation => conversation.id !== conversationId
  );
  const openConversationIds = getOpenConversationIds(store).filter(
    currentId => currentId !== conversationId
  );

  if (conversations.length === 0) {
    const conversation = createFallbackOpenConversation(store, defaultEvents);

    return {
      activeConversationId: conversation.id,
      conversations: [conversation],
      openConversationIds: [conversation.id],
    };
  }

  const nextStore = {
    activeConversationId:
      store.activeConversationId === conversationId
        ? (openConversationIds[0] ?? '')
        : store.activeConversationId,
    conversations,
    openConversationIds,
  };

  return ensureOpenConversation(nextStore, defaultEvents);
};

export const openStoredConversation = ({
  conversationId,
  isActiveConversationEmpty,
  store,
}: {
  readonly conversationId: string;
  readonly isActiveConversationEmpty: boolean;
  readonly store: StoredAgentConversationStore;
}): StoredAgentConversationStore => {
  if (!store.conversations.some(conversation => conversation.id === conversationId)) {
    return store;
  }

  if (isStoredConversationOpen(store, conversationId)) {
    return { ...store, activeConversationId: conversationId };
  }

  const { activeConversationId } = store;
  const openConversationIds = getOpenConversationIds(store);

  if (isActiveConversationEmpty && activeConversationId !== conversationId) {
    return {
      activeConversationId: conversationId,
      conversations: store.conversations.filter(
        conversation => conversation.id !== activeConversationId
      ),
      openConversationIds: [
        ...openConversationIds.filter(currentId => currentId !== activeConversationId),
        conversationId,
      ],
    };
  }

  return {
    ...store,
    activeConversationId: conversationId,
    openConversationIds: [...openConversationIds, conversationId],
  };
};

export const closeStoredConversation = (
  store: StoredAgentConversationStore,
  conversationId: string,
  defaultEvents: AgentConversationEvent[] = []
): StoredAgentConversationStore => deleteStoredConversation(store, conversationId, defaultEvents);

export const normalizeStoredConversations = ({
  defaultEvents = [],
  legacyEvents,
  store,
}: {
  readonly defaultEvents?: AgentConversationEvent[];
  readonly legacyEvents?: AgentConversationEvent[] | undefined;
  readonly store?: StoredAgentConversationStore | undefined;
} = {}): StoredAgentConversationStore => {
  if (store !== undefined && store.conversations.length > 0) {
    const conversations = store.conversations.map(conversation => ({
      ...conversation,
      updatedAt: conversation.updatedAt ?? nowIso(),
    }));
    const conversationIds = new Set(conversations.map(conversation => conversation.id));
    const openConversationIds =
      store.openConversationIds.length === 0
        ? conversations.map(conversation => conversation.id)
        : store.openConversationIds.filter(conversationId => conversationIds.has(conversationId));
    const hasActiveConversation = openConversationIds.includes(store.activeConversationId);

    return ensureOpenConversation({
      activeConversationId: hasActiveConversation
        ? store.activeConversationId
        : (openConversationIds[0] ?? conversations[0]?.id ?? ''),
      conversations,
      openConversationIds,
    });
  }

  if (legacyEvents !== undefined) {
    const conversationId = createConversationId(1);

    return {
      activeConversationId: conversationId,
      conversations: [
        {
          events: legacyEvents,
          id: conversationId,
          title: createConversationTitle(1),
          updatedAt: nowIso(),
        },
      ],
      openConversationIds: [conversationId],
    };
  }

  return createDefaultStoredConversations(defaultEvents);
};

export const getStoredConversationTitle = (conversation: StoredAgentConversation): string => {
  for (const event of conversation.events) {
    if (event.type === 'message' && event.role === 'user' && event.text.trim() !== '') {
      const text = event.text.trim().replaceAll(/\s+/gu, ' ');

      return text.length <= maxTitleLength ? text : `${text.slice(0, maxTitleLength - 1)}...`;
    }
  }

  return conversation.title;
};
