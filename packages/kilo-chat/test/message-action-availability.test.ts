import { describe, expect, it } from 'vitest';

import { type Message } from '../src';
import { buildMessageActionAvailability } from '../src/message-action-availability';

const baseMessage = {
  id: '01K8ZB8B3H9BRWZ6KCN39AX09G',
  senderId: 'user-1',
  content: [{ type: 'text', text: 'hello' }],
  inReplyToMessageId: null,
  replyTo: null,
  updatedAt: null,
  clientUpdatedAt: null,
  deleted: false,
  deliveryFailed: false,
  reactions: [],
} satisfies Message;

describe('buildMessageActionAvailability', () => {
  it('allows API-backed actions for persisted own messages', () => {
    expect(buildMessageActionAvailability(baseMessage, true)).toEqual({
      canReact: true,
      canEdit: true,
      canDelete: true,
      canReply: true,
      canExecuteAction: true,
    });
  });

  it('blocks owner-only actions for other users messages', () => {
    expect(buildMessageActionAvailability(baseMessage, false)).toEqual({
      canReact: true,
      canEdit: false,
      canDelete: false,
      canReply: true,
      canExecuteAction: true,
    });
  });

  it('blocks API-backed actions for pending messages', () => {
    const pendingMessage = { ...baseMessage, id: 'pending-client-1' } satisfies Message;

    expect(buildMessageActionAvailability(pendingMessage, true)).toEqual({
      canReact: false,
      canEdit: false,
      canDelete: false,
      canReply: false,
      canExecuteAction: false,
    });
  });

  it('allows deleting but not mutating delivery-failed own messages', () => {
    const failedMessage = { ...baseMessage, deliveryFailed: true } satisfies Message;

    expect(buildMessageActionAvailability(failedMessage, true)).toEqual({
      canReact: false,
      canEdit: false,
      canDelete: true,
      canReply: false,
      canExecuteAction: true,
    });
  });
});
