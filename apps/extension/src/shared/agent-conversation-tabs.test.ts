import { describe, expect, it } from 'vitest';
import { createAssistantMessage, createUserMessage } from './agent-conversation';
import {
  closeStoredConversationTab,
  closeStoredConversation,
  createDefaultStoredConversations,
  createNextStoredConversation,
  deleteStoredConversation,
  getSortedStoredConversationHistory,
  getStoredConversationTitle,
  openStoredConversation,
  normalizeStoredConversations,
  updateActiveStoredConversationEvents,
} from './agent-conversation-tabs';

describe('agent conversation tabs', () => {
  it('migrates the previous single conversation into one active tab', () => {
    const legacyEvents = [createAssistantMessage('Existing reply')];

    expect(normalizeStoredConversations({ legacyEvents })).toMatchObject({
      activeConversationId: 'conversation-1',
      conversations: [
        {
          events: legacyEvents,
          id: 'conversation-1',
          title: 'Conversation 1',
        },
      ],
    });
  });

  it('keeps separate persisted histories for each tab', () => {
    const firstEvents = [createAssistantMessage('First tab')];
    const secondEvents = [createAssistantMessage('Second tab')];
    const store = createNextStoredConversation(
      updateActiveStoredConversationEvents(createDefaultStoredConversations(), firstEvents)
    );

    const updatedStore = updateActiveStoredConversationEvents(store, secondEvents);

    expect(updatedStore.conversations).toMatchObject([
      { events: firstEvents, title: 'Conversation 1' },
      { events: secondEvents, title: 'Conversation 2' },
    ]);
  });

  it('keeps one default tab after closing the last conversation', () => {
    const defaultStore = createDefaultStoredConversations();

    expect(closeStoredConversation(defaultStore, defaultStore.activeConversationId)).toMatchObject({
      activeConversationId: 'conversation-2',
      conversations: [
        {
          title: 'Conversation 1',
        },
      ],
    });
  });

  it('labels a tab from the first user message when available', () => {
    expect(
      getStoredConversationTitle({
        events: [createAssistantMessage('Hello'), createUserMessage('Summarize this article')],
        id: 'conversation-1',
        title: 'Conversation 1',
        updatedAt: '2026-06-24T10:00:00.000Z',
      })
    ).toBe('Summarize this article');
  });

  it('closes a conversation tab without deleting it from history', () => {
    const store = createNextStoredConversation(createDefaultStoredConversations());

    const updatedStore = closeStoredConversationTab(store, 'conversation-2');

    expect(updatedStore.conversations.map(conversation => conversation.id)).toStrictEqual([
      'conversation-1',
      'conversation-2',
    ]);
    expect(updatedStore.openConversationIds).toStrictEqual(['conversation-1']);
  });

  it('deletes a conversation from history', () => {
    const store = createNextStoredConversation(createDefaultStoredConversations());

    const updatedStore = deleteStoredConversation(store, 'conversation-2');

    expect(updatedStore.conversations.map(conversation => conversation.id)).toStrictEqual([
      'conversation-1',
    ]);
    expect(updatedStore.openConversationIds).toStrictEqual(['conversation-1']);
  });

  it('sorts history by updated time', () => {
    const store = normalizeStoredConversations({
      store: {
        activeConversationId: 'conversation-1',
        conversations: [
          {
            events: [],
            id: 'conversation-1',
            title: 'Older',
            updatedAt: '2026-06-24T10:00:00.000Z',
          },
          {
            events: [],
            id: 'conversation-2',
            title: 'Newer',
            updatedAt: '2026-06-24T11:00:00.000Z',
          },
        ],
        openConversationIds: ['conversation-1'],
      },
    });

    expect(
      getSortedStoredConversationHistory(store).map(conversation => conversation.id)
    ).toStrictEqual(['conversation-2', 'conversation-1']);
  });

  it('reuses an empty active tab when opening a closed history conversation', () => {
    const store = normalizeStoredConversations({
      store: {
        activeConversationId: 'conversation-1',
        conversations: [
          {
            events: [createAssistantMessage('Pick a tab and ask Kilo to inspect it.')],
            id: 'conversation-1',
            title: 'Conversation 1',
            updatedAt: '2026-06-24T10:00:00.000Z',
          },
          {
            events: [createUserMessage('Restore this')],
            id: 'conversation-2',
            title: 'Conversation 2',
            updatedAt: '2026-06-24T11:00:00.000Z',
          },
        ],
        openConversationIds: ['conversation-1'],
      },
    });

    const updatedStore = openStoredConversation({
      conversationId: 'conversation-2',
      isActiveConversationEmpty: true,
      store,
    });

    expect(updatedStore.activeConversationId).toBe('conversation-2');
    expect(updatedStore.openConversationIds).toStrictEqual(['conversation-2']);
    expect(updatedStore.conversations.map(conversation => conversation.id)).toStrictEqual([
      'conversation-2',
    ]);
  });
});
