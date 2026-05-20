import { describe, expect, it } from 'vitest';
import {
  buildChatSummarySectionLines,
  buildChatSummaryStatus,
  buildTodaySoFarChatWindow,
  buildYesterdayChatWindow,
  CHAT_EMPTY_TODAY,
  CHAT_EMPTY_YESTERDAY,
  formatChatTldr,
  summarizeChatActivity,
  ulidToTimestampMs,
  type ChatSummaryConversation,
} from './chat-summary-utils';

const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function ulidFromTimestamp(timestamp: number, suffix = '0000000000000000'): string {
  let value = timestamp;
  let encoded = '';
  for (let i = 0; i < 10; i += 1) {
    encoded = CROCKFORD_BASE32[value % 32] + encoded;
    value = Math.floor(value / 32);
  }
  return `${encoded}${suffix}`;
}

describe('chat summary utils', () => {
  it('decodes the timestamp embedded in a ULID', () => {
    const timestamp = Date.parse('2026-05-18T12:34:56.789Z');
    expect(ulidToTimestampMs(ulidFromTimestamp(timestamp))).toBe(timestamp);
    expect(ulidToTimestampMs('not-a-ulid')).toBeNull();
  });

  it('builds yesterday window in the user timezone', () => {
    const window = buildYesterdayChatWindow(
      new Date('2026-05-19T14:00:00.000Z'),
      'America/Los_Angeles'
    );

    expect(window.dateKey).toBe('2026-05-18');
    expect(new Date(window.startMs).toISOString()).toBe('2026-05-18T07:00:00.000Z');
    expect(new Date(window.endMs).toISOString()).toBe('2026-05-19T07:00:00.000Z');
  });

  it('builds a DST transition day window using local midnight boundaries', () => {
    const window = buildYesterdayChatWindow(
      new Date('2026-04-06T00:00:00.000Z'),
      'Pacific/Auckland'
    );

    expect(window.dateKey).toBe('2026-04-05');
    expect(new Date(window.startMs).toISOString()).toBe('2026-04-04T11:00:00.000Z');
    expect(new Date(window.endMs).toISOString()).toBe('2026-04-05T12:00:00.000Z');
  });

  it('builds today-so-far window in the user timezone', () => {
    const now = new Date('2026-05-19T14:00:00.000Z');
    const window = buildTodaySoFarChatWindow(now, 'America/Los_Angeles');

    expect(window.dateKey).toBe('2026-05-19');
    expect(new Date(window.startMs).toISOString()).toBe('2026-05-19T07:00:00.000Z');
    expect(new Date(window.endMs).toISOString()).toBe(now.toISOString());
  });

  it('summarizes yesterday messages and ignores messages outside the window', () => {
    const window = buildYesterdayChatWindow(new Date('2026-05-19T12:00:00.000Z'), 'UTC');
    const conversations: ChatSummaryConversation[] = [
      {
        conversationId: 'conv-1',
        lastActivityAt: Date.parse('2026-05-18T23:00:00.000Z'),
        messages: [
          {
            id: ulidFromTimestamp(Date.parse('2026-05-18T09:00:00.000Z'), '0000000000000001'),
            senderId: 'user:1',
            deleted: false,
          },
          {
            id: ulidFromTimestamp(Date.parse('2026-05-18T09:01:00.000Z'), '0000000000000002'),
            senderId: 'bot:kiloclaw:sbx',
            deleted: false,
          },
          {
            id: ulidFromTimestamp(Date.parse('2026-05-18T23:00:00.000Z'), '0000000000000003'),
            senderId: 'user:1',
            deleted: true,
          },
          {
            id: ulidFromTimestamp(Date.parse('2026-05-19T12:00:00.000Z'), '0000000000000004'),
            senderId: 'user:1',
            deleted: false,
          },
        ],
      },
      {
        conversationId: 'conv-2',
        lastActivityAt: Date.parse('2026-05-18T20:00:00.000Z'),
        messages: [
          {
            id: ulidFromTimestamp(Date.parse('2026-05-18T20:00:00.000Z'), '0000000000000005'),
            senderId: 'user:1',
            deleted: false,
          },
        ],
      },
    ];

    const stats = summarizeChatActivity(conversations, window);

    expect(stats).toEqual({
      activeConversationCount: 2,
      messageCount: 4,
      userMessageCount: 3,
      botMessageCount: 1,
      deletedMessageCount: 1,
    });
    expect(buildChatSummaryStatus(stats, 'yesterday')).toBe(
      '4 Kilo Chat messages across 2 conversations'
    );
    expect(buildChatSummarySectionLines(stats, 'No Kilo Chat messages yesterday.')).toEqual([
      '- 4 messages across 2 conversations.',
      '- 3 messages from you; 1 reply from Kilo.',
      '- 1 of those messages was later deleted; its content is excluded from summaries.',
    ]);
  });

  it('renders a quiet no-activity section', () => {
    const stats = summarizeChatActivity(
      [],
      buildYesterdayChatWindow(new Date('2026-05-19T12:00:00.000Z'), 'UTC')
    );

    expect(buildChatSummaryStatus(stats, 'so far today')).toBe('0 Kilo Chat messages so far today');
    expect(buildChatSummarySectionLines(stats, 'No Kilo Chat messages so far today.')).toEqual([
      'No Kilo Chat messages so far today.',
    ]);
  });
});

describe('formatChatTldr', () => {
  it("pluralizes yesterday's message count", () => {
    expect(
      formatChatTldr({
        activeConversationCount: 2,
        messageCount: 12,
        userMessageCount: 7,
        botMessageCount: 5,
        deletedMessageCount: 0,
      })
    ).toBe('12 chat messages yesterday');
    expect(
      formatChatTldr({
        activeConversationCount: 1,
        messageCount: 1,
        userMessageCount: 1,
        botMessageCount: 0,
        deletedMessageCount: 0,
      })
    ).toBe('1 chat message yesterday');
  });

  it('returns an empty string when there was no activity', () => {
    expect(
      formatChatTldr({
        activeConversationCount: 0,
        messageCount: 0,
        userMessageCount: 0,
        botMessageCount: 0,
        deletedMessageCount: 0,
      })
    ).toBe('');
  });
});

describe('chat empty-state constants', () => {
  it('are italic-wrapped one-liners', () => {
    for (const line of [CHAT_EMPTY_YESTERDAY, CHAT_EMPTY_TODAY]) {
      expect(line.startsWith('_')).toBe(true);
      expect(line.endsWith('_')).toBe(true);
    }
  });
});
