import { describe, expect, it } from 'vitest';
import { type InfiniteData, QueryClient } from '@tanstack/react-query';
import { type Message, type MessageCreatedEvent } from '@kilocode/kilo-chat';

import {
  applyMessageCreatedEventToPages,
  applyReactionAdded,
  latestMarkReadMessageId,
  messagesKey,
  restoreMessageInCache,
  updateMessageInPages,
} from '@kilocode/kilo-chat-hooks';

function message(id: string): Message {
  return {
    id,
    senderId: 'user:1',
    content: [{ type: 'text', text: id }],
    inReplyToMessageId: null,
    replyTo: null,
    updatedAt: null,
    clientUpdatedAt: null,
    deleted: false,
    deliveryFailed: false,
    reactions: [],
  };
}

describe('applyMessageCreatedEventToPages', () => {
  it('adds bot-created messages to the open conversation cache', () => {
    const data: InfiniteData<Message[], string | undefined> = {
      pages: [[message('existing')]],
      pageParams: [undefined],
    };
    const event = {
      messageId: 'bot-message',
      senderId: 'bot:sandbox-1',
      content: [{ type: 'text', text: 'hello from bot' }],
      inReplyToMessageId: null,
      clientId: null,
    } satisfies MessageCreatedEvent;

    const result = applyMessageCreatedEventToPages(data, event);

    expect(result.pages[0]?.map(m => m.id)).toEqual(['bot-message', 'existing']);
  });

  it('repositions resolved optimistic messages by newest server id', () => {
    const remoteOlder = message('01HX0000000000000000000000');
    const pendingLocal = message('pending-client-1');
    const data: InfiniteData<Message[], string | undefined> = {
      pages: [[remoteOlder, pendingLocal]],
      pageParams: [undefined],
    };
    const event = {
      messageId: '01HX0000000000000000000001',
      senderId: 'user:1',
      content: [{ type: 'text', text: 'local newer' }],
      inReplyToMessageId: null,
      clientId: 'client-1',
    } satisfies MessageCreatedEvent;

    const result = applyMessageCreatedEventToPages(data, event);

    expect(result.pages[0]?.map(m => m.id)).toEqual([
      '01HX0000000000000000000001',
      '01HX0000000000000000000000',
    ]);
  });
});

describe('updateMessageInPages', () => {
  it('returns the same cache object when the target message is absent', () => {
    const data: InfiniteData<Message[], string | undefined> = {
      pages: [[message('m1')], [message('m2')]],
      pageParams: [undefined, 'm1'],
    };

    const result = updateMessageInPages(data, 'missing', msg => ({ ...msg, deleted: true }));

    expect(result).toBe(data);
  });

  it('copies only the pages array and containing page when updating a message', () => {
    const firstPage = [message('m1')];
    const secondPage = [message('m2')];
    const data: InfiniteData<Message[], string | undefined> = {
      pages: [firstPage, secondPage],
      pageParams: [undefined, 'm1'],
    };

    const result = updateMessageInPages(data, 'm2', msg => ({ ...msg, deleted: true }));

    expect(result).not.toBe(data);
    expect(result.pages).not.toBe(data.pages);
    expect(result.pages[0]).toBe(firstPage);
    expect(result.pages[1]).not.toBe(secondPage);
    expect(result.pages[1]?.[0]?.deleted).toBe(true);
  });
});

describe('shared optimistic rollback helpers', () => {
  it('restores snapshotted message content for edit and delete rollbacks', () => {
    const queryClient = new QueryClient();
    const queryKey = messagesKey('conv-rollback');
    const original = message('m1');
    const optimistic = {
      ...original,
      content: [{ type: 'text' as const, text: 'edited' }],
      deleted: true,
    };
    queryClient.setQueryData<InfiniteData<Message[], string | undefined>>(queryKey, {
      pages: [[optimistic]],
      pageParams: [undefined],
    });

    restoreMessageInCache(queryClient, queryKey, original);

    const result = queryClient.getQueryData<InfiniteData<Message[], string | undefined>>(queryKey);
    expect(result?.pages[0]?.[0]).toEqual(original);
  });

  it('creates the first reaction summary when adding a new emoji', () => {
    expect(applyReactionAdded([], '👍', 'user-1')).toEqual([
      { emoji: '👍', count: 1, memberIds: ['user-1'] },
    ]);
  });
});

describe('latestMarkReadMessageId', () => {
  it('skips pending optimistic messages when selecting the newest read boundary', () => {
    expect(latestMarkReadMessageId([message('real-message'), message('pending-client-1')])).toBe(
      'real-message'
    );
    expect(latestMarkReadMessageId([message('pending-client-1')])).toBeNull();
  });
});
