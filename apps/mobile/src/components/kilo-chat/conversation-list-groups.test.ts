import { type ConversationListItem } from '@kilocode/kilo-chat';
import { describe, expect, it } from 'vitest';

import { groupConversationsByActivity } from './conversation-list-groups';

function conversation(
  conversationId: string,
  timestamp: number,
  overrides: Partial<ConversationListItem> = {}
): ConversationListItem {
  return {
    conversationId,
    title: conversationId,
    lastActivityAt: timestamp,
    lastReadAt: null,
    joinedAt: timestamp - 1000,
    ...overrides,
  };
}

describe('groupConversationsByActivity', () => {
  it('groups conversations by local activity day', () => {
    const todayStart = new Date(2026, 4, 4).getTime();
    const nowMs = todayStart + 12 * 60 * 60 * 1000;
    const yesterday = todayStart - 60 * 60 * 1000;
    const thisWeek = todayStart - 3 * 24 * 60 * 60 * 1000;
    const older = todayStart - 8 * 24 * 60 * 60 * 1000;

    expect(
      groupConversationsByActivity(
        [
          conversation('today', nowMs),
          conversation('yesterday', yesterday),
          conversation('this-week', thisWeek),
          conversation('older', older),
        ],
        nowMs
      )
    ).toEqual([
      { label: 'Today', items: [conversation('today', nowMs)] },
      { label: 'Yesterday', items: [conversation('yesterday', yesterday)] },
      { label: 'This Week', items: [conversation('this-week', thisWeek)] },
      { label: 'Older', items: [conversation('older', older)] },
    ]);
  });

  it('uses joined time when last activity is missing', () => {
    const todayStart = new Date(2026, 4, 4).getTime();
    const nowMs = todayStart + 12 * 60 * 60 * 1000;
    const joinedAt = todayStart - 2 * 24 * 60 * 60 * 1000;

    expect(
      groupConversationsByActivity(
        [conversation('joined-only', nowMs, { lastActivityAt: null, joinedAt })],
        nowMs
      )
    ).toEqual([
      {
        label: 'This Week',
        items: [conversation('joined-only', nowMs, { lastActivityAt: null, joinedAt })],
      },
    ]);
  });
});
