/**
 * Tests for V2 tail-pagination helpers in filterMessages.ts.
 */

import type { CloudMessage } from '@/components/cloud-agent/types';
import {
  tailFromLastUserTurn,
  loadEarlierUserTurn,
  paginateMessages,
  getMessageRole,
  lastUserIndex,
} from './filterMessages';

function msg(ts: number, type: 'user' | 'assistant' | 'system', say?: string): CloudMessage {
  return {
    ts,
    type,
    say,
    text: `${type}-${ts}`,
    partial: false,
  };
}

function userMsg(ts: number, say = 'user_feedback'): CloudMessage {
  return { ts, type: 'user', say, text: `user-${ts}`, partial: false };
}

describe('tailFromLastUserTurn', () => {
  it('returns full list when there is no user message', () => {
    const messages = [msg(1, 'assistant'), msg(2, 'assistant')];
    const result = tailFromLastUserTurn(messages);
    expect(result.visibleMessages).toEqual(messages);
    expect(result.hasEarlierMessages).toBe(false);
  });

  it('returns full list when the first message is a user message', () => {
    const messages = [userMsg(1), msg(2, 'assistant')];
    const result = tailFromLastUserTurn(messages);
    expect(result.visibleMessages).toEqual(messages);
    expect(result.hasEarlierMessages).toBe(false);
  });

  it('slices from the last user message when earlier messages exist', () => {
    const messages = [
      userMsg(1),
      msg(2, 'assistant'),
      userMsg(3),
      msg(4, 'assistant'),
      msg(5, 'assistant'),
    ];
    const result = tailFromLastUserTurn(messages);
    expect(result.visibleMessages).toEqual(messages.slice(2));
    expect(result.hasEarlierMessages).toBe(true);
  });

  it('re-anchors to a newly appended user turn', () => {
    // Simulates the optimistic user message landing mid-conversation:
    // the previous turn is complete, then a brand-new user message is appended
    // before any assistant reply exists yet. The tail should be exactly that
    // new user message, not a stale mix of the previous tail.
    const messages = [
      userMsg(1),
      msg(2, 'assistant'),
      userMsg(3), // new turn (optimistic)
    ];
    const result = tailFromLastUserTurn(messages);
    expect(result.visibleMessages).toEqual([userMsg(3)]);
    expect(result.hasEarlierMessages).toBe(true);
  });

  it('treats user_feedback as a user message', () => {
    const messages = [msg(1, 'user', 'text'), msg(2, 'assistant')];
    const result = tailFromLastUserTurn(messages);
    expect(result.visibleMessages).toEqual(messages);
    expect(result.hasEarlierMessages).toBe(false);
  });
});

describe('loadEarlierUserTurn', () => {
  it('is a no-op when nothing is hidden', () => {
    const messages = [userMsg(1), msg(2, 'assistant')];
    const result = loadEarlierUserTurn(messages, messages.length);
    expect(result.visibleCount).toBe(messages.length);
    expect(result.hasEarlierMessages).toBe(false);
  });

  it('grows the visible window by exactly one prior user turn', () => {
    const messages = [
      userMsg(1),
      msg(2, 'assistant'),
      userMsg(3),
      msg(4, 'assistant'),
      userMsg(5),
      msg(6, 'assistant'),
    ];
    const initial = tailFromLastUserTurn(messages).visibleMessages.length;
    expect(initial).toBe(2);

    const step1 = loadEarlierUserTurn(messages, initial);
    expect(step1.visibleCount).toBe(4);
    expect(step1.hasEarlierMessages).toBe(true);

    const step2 = loadEarlierUserTurn(messages, step1.visibleCount);
    expect(step2.visibleCount).toBe(messages.length);
    expect(step2.hasEarlierMessages).toBe(false);
  });

  it('falls back to the full list when no prior user turn exists', () => {
    const messages = [msg(1, 'assistant'), userMsg(2), msg(3, 'assistant')];
    const result = loadEarlierUserTurn(messages, 2);
    expect(result.visibleCount).toBe(messages.length);
    expect(result.hasEarlierMessages).toBe(false);
  });
});

describe('lastUserIndex', () => {
  it('returns -1 when no user message exists', () => {
    expect(lastUserIndex([msg(1, 'assistant'), msg(2, 'system')], getMessageRole)).toBe(-1);
  });

  it('returns the index of the last user message', () => {
    const messages = [userMsg(1), msg(2, 'assistant'), userMsg(3), msg(4, 'assistant')];
    expect(lastUserIndex(messages, getMessageRole)).toBe(2);
  });

  it('treats user_feedback as user', () => {
    const messages = [
      msg(1, 'assistant'),
      { ts: 2, type: 'user', say: 'user_feedback' } as CloudMessage,
    ];
    expect(lastUserIndex(messages, getMessageRole)).toBe(1);
  });
});

describe('getMessageRole', () => {
  it('returns user for user_feedback messages', () => {
    expect(getMessageRole({ ts: 1, type: 'assistant', say: 'user_feedback' } as CloudMessage)).toBe(
      'user'
    );
  });

  it('returns the raw type otherwise', () => {
    expect(getMessageRole({ ts: 1, type: 'assistant' } as CloudMessage)).toBe('assistant');
    expect(getMessageRole({ ts: 1, type: 'system' } as CloudMessage)).toBe('system');
  });
});

describe('paginateMessages (V1 helper, regression)', () => {
  it('keeps the last N user sessions when more exist', () => {
    const messages = [
      userMsg(1),
      msg(2, 'assistant'),
      userMsg(3),
      msg(4, 'assistant'),
      userMsg(5),
      msg(6, 'assistant'),
    ];
    const result = paginateMessages(messages, 2);
    expect(result.visibleMessages).toEqual(messages.slice(2));
    expect(result.hasOlderMessages).toBe(true);
  });
});
