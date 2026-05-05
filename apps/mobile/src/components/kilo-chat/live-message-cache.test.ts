import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { type Message, type MessageCreatedEvent } from '@kilocode/kilo-chat';

import {
  applyMessageCreatedEventToPages,
  applyReactionAdded,
  latestMarkReadMessageId,
  type MessageInfiniteData,
  messagesKey,
  restoreMessageInCache,
  updateMessageInPages,
} from '@kilocode/kilo-chat-hooks';

function messageData(
  pages: Message[][],
  pageParams: (string | undefined)[] = [undefined]
): MessageInfiniteData {
  return {
    pages: pages.map((messages, index) => ({
      messages,
      hasMore: index < pages.length - 1,
      nextCursor: index < pages.length - 1 ? (pageParams[index + 1] ?? null) : null,
    })),
    pageParams,
  };
}

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

function actionMessage(
  resolved?: NonNullable<Extract<Message['content'][number], { type: 'actions' }>['resolved']>
): Message {
  return {
    ...message('action-message'),
    senderId: 'bot:sandbox-1',
    content: [
      {
        type: 'actions',
        groupId: 'approval-1',
        actions: [{ label: 'Allow once', style: 'primary', value: 'allow-once' }],
        resolved,
      },
    ],
  };
}

describe('applyMessageCreatedEventToPages', () => {
  it('adds bot-created messages to the open conversation cache', () => {
    const data = messageData([[message('01HX0000000000000000000000')]]);
    const event = {
      messageId: '01HX0000000000000000000001',
      senderId: 'bot:sandbox-1',
      content: [{ type: 'text', text: 'hello from bot' }],
      inReplyToMessageId: null,
      replyTo: null,
      clientId: null,
    } satisfies MessageCreatedEvent;

    const result = applyMessageCreatedEventToPages(data, event);

    expect(result.pages[0]?.messages.map(m => m.id)).toEqual([
      '01HX0000000000000000000001',
      '01HX0000000000000000000000',
    ]);
  });

  it('keeps the newest page ordered when an older remote message arrives after a newer one', () => {
    const newerRemote = message('01HX0000000000000000000002');
    const data = messageData([[newerRemote]]);
    const event = {
      messageId: '01HX0000000000000000000001',
      senderId: 'bot:sandbox-1',
      content: [{ type: 'text', text: 'older delayed message' }],
      inReplyToMessageId: null,
      replyTo: null,
      clientId: null,
    } satisfies MessageCreatedEvent;

    const result = applyMessageCreatedEventToPages(data, event);

    expect(result.pages[0]?.messages.map(m => m.id)).toEqual([
      '01HX0000000000000000000002',
      '01HX0000000000000000000001',
    ]);
  });

  it('keeps pending messages in place while ordering delayed remote messages', () => {
    const newerRemote = message('01HX0000000000000000000002');
    const pendingLocal = message('pending-client-1');
    const data = messageData([[newerRemote, pendingLocal]]);
    const event = {
      messageId: '01HX0000000000000000000001',
      senderId: 'bot:sandbox-1',
      content: [{ type: 'text', text: 'older delayed message' }],
      inReplyToMessageId: null,
      replyTo: null,
      clientId: null,
    } satisfies MessageCreatedEvent;

    const result = applyMessageCreatedEventToPages(data, event);

    expect(result.pages[0]?.messages.map(m => m.id)).toEqual([
      '01HX0000000000000000000002',
      '01HX0000000000000000000001',
      'pending-client-1',
    ]);
  });

  it('preserves reply snapshots from created events when the parent is not loaded', () => {
    const data = messageData([[message('existing')]]);
    const replyTo = {
      messageId: 'parent-outside-loaded-pages',
      senderId: 'user:parent',
      deleted: false,
      previewText: 'Parent context from an older page',
    };
    const event = {
      messageId: 'reply-message',
      senderId: 'bot:sandbox-1',
      content: [{ type: 'text', text: 'reply body' }],
      inReplyToMessageId: replyTo.messageId,
      replyTo,
      clientId: null,
    } satisfies MessageCreatedEvent;

    const result = applyMessageCreatedEventToPages(data, event);

    expect(result.pages[0]?.messages[0]?.replyTo).toEqual(replyTo);
  });

  it('repositions resolved optimistic messages by newest server id', () => {
    const remoteOlder = message('01HX0000000000000000000000');
    const pendingLocal = message('pending-client-1');
    const data = messageData([[remoteOlder, pendingLocal]]);
    const event = {
      messageId: '01HX0000000000000000000001',
      senderId: 'user:1',
      content: [{ type: 'text', text: 'local newer' }],
      inReplyToMessageId: null,
      replyTo: null,
      clientId: 'client-1',
    } satisfies MessageCreatedEvent;

    const result = applyMessageCreatedEventToPages(data, event);

    expect(result.pages[0]?.messages.map(m => m.id)).toEqual([
      '01HX0000000000000000000001',
      '01HX0000000000000000000000',
    ]);
  });
});

describe('updateMessageInPages', () => {
  it('returns the same cache object when the target message is absent', () => {
    const data = messageData([[message('m1')], [message('m2')]], [undefined, 'm1']);

    const result = updateMessageInPages(data, 'missing', msg => ({ ...msg, deleted: true }));

    expect(result).toBe(data);
  });

  it('copies only the pages array and containing page when updating a message', () => {
    const firstPage = { messages: [message('m1')], hasMore: true, nextCursor: 'm1' };
    const secondPage = { messages: [message('m2')], hasMore: false, nextCursor: null };
    const data: MessageInfiniteData = {
      pages: [firstPage, secondPage],
      pageParams: [undefined, 'm1'],
    };

    const result = updateMessageInPages(data, 'm2', msg => ({ ...msg, deleted: true }));

    expect(result).not.toBe(data);
    expect(result.pages).not.toBe(data.pages);
    expect(result.pages[0]).toBe(firstPage);
    expect(result.pages[1]).not.toBe(secondPage);
    expect(result.pages[1]?.messages[0]?.deleted).toBe(true);
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
    queryClient.setQueryData<MessageInfiniteData>(queryKey, messageData([[optimistic]]));

    const restored = restoreMessageInCache(
      queryClient,
      queryKey,
      original,
      current => JSON.stringify(current) === JSON.stringify(optimistic)
    );

    const result = queryClient.getQueryData<MessageInfiniteData>(queryKey);
    expect(restored).toBe(true);
    expect(result?.pages[0]?.messages[0]).toEqual(original);
  });

  it('leaves server-resolved actions intact when failed rollback sees newer content', () => {
    const queryClient = new QueryClient();
    const queryKey = messagesKey('conv-action-race');
    const original = actionMessage();
    const optimisticResolution = {
      value: 'allow-once',
      resolvedBy: 'user-losing-request',
      resolvedAt: 1,
    };
    const serverResolved = actionMessage({
      value: 'deny',
      resolvedBy: 'user-winning-request',
      resolvedAt: 2,
    });
    queryClient.setQueryData<MessageInfiniteData>(queryKey, messageData([[serverResolved]]));

    const restored = restoreMessageInCache(queryClient, queryKey, original, current =>
      current.content.some(block => {
        if (block.type !== 'actions') {
          return false;
        }
        if (block.groupId !== 'approval-1') {
          return false;
        }
        return (
          block.resolved?.value === optimisticResolution.value &&
          block.resolved.resolvedBy === optimisticResolution.resolvedBy &&
          block.resolved.resolvedAt === optimisticResolution.resolvedAt
        );
      })
    );

    const result = queryClient.getQueryData<MessageInfiniteData>(queryKey);
    expect(restored).toBe(false);
    expect(result?.pages[0]?.messages[0]).toEqual(serverResolved);
  });

  it('leaves server-updated text intact when failed edit rollback sees newer content', () => {
    const queryClient = new QueryClient();
    const queryKey = messagesKey('conv-edit-race');
    const original = message('m1');
    const optimistic: Message = {
      ...original,
      content: [{ type: 'text', text: 'optimistic edit' }],
      clientUpdatedAt: 1,
    };
    const serverUpdated: Message = {
      ...original,
      content: [{ type: 'text', text: 'server edit' }],
      clientUpdatedAt: 2,
    };
    queryClient.setQueryData<MessageInfiniteData>(queryKey, messageData([[serverUpdated]]));

    const restored = restoreMessageInCache(
      queryClient,
      queryKey,
      original,
      current =>
        JSON.stringify(current.content) === JSON.stringify(optimistic.content) &&
        current.clientUpdatedAt === optimistic.clientUpdatedAt
    );

    const result = queryClient.getQueryData<MessageInfiniteData>(queryKey);
    expect(restored).toBe(false);
    expect(result?.pages[0]?.messages[0]).toEqual(serverUpdated);
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
