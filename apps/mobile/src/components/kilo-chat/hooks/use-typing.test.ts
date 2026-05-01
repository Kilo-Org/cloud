import { kiloclawConversationContext } from '@kilocode/event-service';
import { describe, expect, it } from 'vitest';

import {
  applyTypingStarted,
  applyTypingStopped,
  pruneStaleTypingMembers,
  sendTypingPingIfDue,
} from './use-typing';

describe('mobile typing state helpers', () => {
  const expectedContext = kiloclawConversationContext('sandbox-1', 'conversation-1');

  it('tracks typing events for the active conversation and removes typing.stop members', () => {
    const typingMembers = applyTypingStarted(new Map(), {
      ctx: expectedContext,
      event: { memberId: 'user-2' },
      currentUserId: 'user-1',
      expectedContext,
      now: 10,
    });

    expect([...typingMembers.entries()]).toEqual([['user-2', 10]]);
    expect(
      applyTypingStarted(typingMembers, {
        ctx: kiloclawConversationContext('sandbox-1', 'other-conversation'),
        event: { memberId: 'user-3' },
        currentUserId: 'user-1',
        expectedContext,
        now: 20,
      })
    ).toBe(typingMembers);
    expect(
      applyTypingStarted(typingMembers, {
        ctx: expectedContext,
        event: { memberId: 'user-1' },
        currentUserId: 'user-1',
        expectedContext,
        now: 30,
      })
    ).toBe(typingMembers);

    const stopped = applyTypingStopped(typingMembers, {
      ctx: expectedContext,
      memberId: 'user-2',
      expectedContext,
    });
    expect(stopped.size).toBe(0);
  });

  it('expires stale typing members', () => {
    const typingMembers = new Map([
      ['recent-user', 4000],
      ['stale-user', 1000],
    ]);

    expect([...pruneStaleTypingMembers(typingMembers, 6000).keys()]).toEqual(['recent-user']);
  });

  it('sends typing pings at most once per cooldown window and swallows failures', async () => {
    const sent: string[] = [];
    const client = {
      sendTyping: async (conversationId: string) => {
        sent.push(conversationId);
        await Promise.resolve();
        throw new Error('offline');
      },
    };

    let lastSentAt = sendTypingPingIfDue({
      client,
      conversationId: 'conversation-1',
      lastSentAt: 0,
      now: 4000,
    });
    lastSentAt = sendTypingPingIfDue({
      client,
      conversationId: 'conversation-1',
      lastSentAt,
      now: 5000,
    });

    await Promise.resolve();
    expect(sent).toEqual(['conversation-1']);
    expect(lastSentAt).toBe(4000);
  });
});
