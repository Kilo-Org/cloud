import { describe, expect, it, vi } from 'vitest';

import { adaptQuickChatRow, mergeQuickChatRows, type QuickChatRow } from './quick-chat-messages';

vi.mock('@/lib/utils', () => ({
  parseTimestamp: (value: string) => new Date(value),
}));

const userRow: QuickChatRow = {
  id: 'u1',
  role: 'user',
  content: 'hello',
  createdAt: '2024-01-01T00:00:00.000Z',
  clientId: 'c1',
};

const assistantRow: QuickChatRow = {
  id: 'a1',
  role: 'assistant',
  content: 'hey',
  createdAt: '2024-01-01T00:00:01.000Z',
  clientId: null,
};

describe('adaptQuickChatRow', () => {
  it('maps a user row to a StoredMessage with a single text part', () => {
    const message = adaptQuickChatRow(userRow, 'thread-1');

    expect(message.info.role).toBe('user');
    expect(message.info.id).toBe('u1');
    expect(message.info.time.created).toBe(Date.parse('2024-01-01T00:00:00.000Z'));
    expect(message.parts).toEqual([
      { id: 'u1:text', sessionID: 'thread-1', messageID: 'u1', type: 'text', text: 'hello' },
    ]);
  });

  it('maps an assistant row with the assistant role', () => {
    const message = adaptQuickChatRow(assistantRow, 'thread-1');

    expect(message.info.role).toBe('assistant');
    expect(message.parts).toEqual([
      { id: 'a1:text', sessionID: 'thread-1', messageID: 'a1', type: 'text', text: 'hey' },
    ]);
  });
});

describe('mergeQuickChatRows', () => {
  it('keeps a sent turn when a late listMessages does not include it', () => {
    const merged = mergeQuickChatRows([], [{ clientId: 'c1', rows: [userRow, assistantRow] }]);

    expect(merged).toEqual([userRow, assistantRow]);
  });

  it('drops a local turn once the server persists the user message by clientId', () => {
    const serverRows = [
      { ...userRow, id: 'server-u1' },
      { ...assistantRow, id: 'server-a1' },
    ];

    const merged = mergeQuickChatRows(serverRows, [
      { clientId: 'c1', rows: [userRow, assistantRow] },
    ]);

    expect(merged).toEqual(serverRows);
  });

  it('appends still-pending turns after the persisted rows in order', () => {
    const serverRows = [{ ...userRow, id: 'server-u1', clientId: 'c0' }];

    const merged = mergeQuickChatRows(serverRows, [
      { clientId: 'c1', rows: [userRow, assistantRow] },
      { clientId: 'c2', rows: [{ ...userRow, id: 'u2', clientId: 'c2' }] },
    ]);

    expect(merged.map(row => row.id)).toEqual(['server-u1', 'u1', 'a1', 'u2']);
  });
});
