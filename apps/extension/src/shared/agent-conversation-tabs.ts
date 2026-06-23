import type { AgentConversationEvent } from './agent-conversation';

export interface StoredAgentConversation {
  readonly events: AgentConversationEvent[];
  readonly id: string;
  readonly title: string;
}

export interface StoredAgentConversationStore {
  readonly activeConversationId: string;
  readonly conversations: StoredAgentConversation[];
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

export const createDefaultStoredConversations = (
  defaultEvents: AgentConversationEvent[] = []
): StoredAgentConversationStore => ({
  activeConversationId: createConversationId(1),
  conversations: [
    {
      events: defaultEvents,
      id: createConversationId(1),
      title: createConversationTitle(1),
    },
  ],
});

const createStoredConversation = (
  number: number,
  defaultEvents: AgentConversationEvent[] = [],
  titleNumber = number
): StoredAgentConversation => ({
  events: defaultEvents,
  id: createConversationId(number),
  title: createConversationTitle(titleNumber),
});

export const createNextStoredConversation = (
  store: StoredAgentConversationStore,
  defaultEvents: AgentConversationEvent[] = []
): StoredAgentConversationStore => {
  const nextNumber = getNextConversationNumber(store.conversations);
  const conversation = createStoredConversation(nextNumber, defaultEvents);

  return {
    activeConversationId: conversation.id,
    conversations: [...store.conversations, conversation],
  };
};

export const getActiveStoredConversation = (
  store: StoredAgentConversationStore
): StoredAgentConversation => {
  const activeConversation = store.conversations.find(
    conversation => conversation.id === store.activeConversationId
  );

  return activeConversation ?? store.conversations[0] ?? createStoredConversation(1);
};

export const setActiveStoredConversation = (
  store: StoredAgentConversationStore,
  conversationId: string
): StoredAgentConversationStore =>
  store.conversations.some(conversation => conversation.id === conversationId)
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
      ? { ...conversation, events: updateEvents(conversation.events) }
      : conversation
  ),
});

export const updateActiveStoredConversationEvents = (
  store: StoredAgentConversationStore,
  events: AgentConversationEvent[]
): StoredAgentConversationStore =>
  updateStoredConversationEvents(store, store.activeConversationId, () => events);

export const closeStoredConversation = (
  store: StoredAgentConversationStore,
  conversationId: string,
  defaultEvents: AgentConversationEvent[] = []
): StoredAgentConversationStore => {
  if (!store.conversations.some(conversation => conversation.id === conversationId)) {
    return store;
  }

  if (store.conversations.length === 1) {
    const nextNumber = getNextConversationNumber(store.conversations);
    const conversation = createStoredConversation(nextNumber, defaultEvents, 1);

    return {
      activeConversationId: conversation.id,
      conversations: [conversation],
    };
  }

  const closedIndex = store.conversations.findIndex(
    conversation => conversation.id === conversationId
  );
  const conversations = store.conversations.filter(
    conversation => conversation.id !== conversationId
  );

  if (store.activeConversationId !== conversationId) {
    return { ...store, conversations };
  }

  const nextActiveConversation =
    conversations[Math.min(closedIndex, conversations.length - 1)] ?? conversations[0];

  return {
    activeConversationId: nextActiveConversation?.id ?? conversations[0]?.id ?? '',
    conversations,
  };
};

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
    const hasActiveConversation = store.conversations.some(
      conversation => conversation.id === store.activeConversationId
    );

    return hasActiveConversation
      ? store
      : { ...store, activeConversationId: store.conversations[0]?.id ?? '' };
  }

  if (legacyEvents !== undefined) {
    return {
      activeConversationId: createConversationId(1),
      conversations: [
        {
          events: legacyEvents,
          id: createConversationId(1),
          title: createConversationTitle(1),
        },
      ],
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
