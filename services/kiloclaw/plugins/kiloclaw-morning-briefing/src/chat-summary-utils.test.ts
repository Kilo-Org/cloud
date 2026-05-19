import { describe, expect, it } from 'vitest';
import {
  buildChatSummarySectionLines,
  buildChatSummaryStatus,
  buildYesterdayChatWindow,
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

  it('summarizes yesterday messages and ignores messages outside the window', () => {
    const window = buildYesterdayChatWindow(new Date('2026-05-19T12:00:00.000Z'), 'UTC');
    const conversations: ChatSummaryConversation[] = [
      {
        conversationId: 'conv-1',
        title: 'Launch plan',
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
        title: null,
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
      topConversations: [
        { title: 'Launch plan', messageCount: 3 },
        { title: 'New chat', messageCount: 1 },
      ],
    });
    expect(buildChatSummaryStatus(stats)).toBe('4 Kilo Chat message(s) across 2 conversation(s)');
    expect(buildChatSummarySectionLines(stats)).toEqual([
      '- 4 messages across 2 conversations.',
      '- 3 messages from you; 1 reply from Kilo.',
      '- 1 deleted message excluded from content summaries.',
      '',
      'Most active threads',
      '- Launch plan (3 messages)',
      '- New chat (1 message)',
    ]);
  });

  it('renders a quiet no-activity section', () => {
    const stats = summarizeChatActivity(
      [],
      buildYesterdayChatWindow(new Date('2026-05-19T12:00:00.000Z'), 'UTC')
    );

    expect(buildChatSummaryStatus(stats)).toBe('0 Kilo Chat messages yesterday');
    expect(buildChatSummarySectionLines(stats)).toEqual(['No Kilo Chat messages yesterday.']);
  });
});
