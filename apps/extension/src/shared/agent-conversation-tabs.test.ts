import { describe, expect, it } from 'vitest';
import { createAssistantMessage, createUserMessage } from './agent-conversation';
import {
  closeStoredConversation,
  createDefaultStoredConversations,
  createNextStoredConversation,
  getStoredConversationTitle,
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
      })
    ).toBe('Summarize this article');
  });
});
