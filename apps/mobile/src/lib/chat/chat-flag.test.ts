import { describe, expect, it } from 'vitest';

import { type ChatFlag, chatFlagBehind, chatFlagValueOf } from './chat-flag';
import { saved } from './chat-flag.test-helpers';

/**
 * What one chat flag draws.
 *
 * The switch, the sheet and the registry all read this table, so every phase is
 * pinned with what the switch draws and whether the row claims this chat's
 * session is behind the saved choice. The transitions themselves are pinned in
 * `chat-flag-transitions.test.ts`.
 */

describe('what a chat flag draws', () => {
  it('draws the fallback until a choice has been read, and the fallback for never chosen', () => {
    expect(chatFlagValueOf({ kind: 'reading' }, true)).toBe(true);
    expect(chatFlagValueOf({ kind: 'reading' }, false)).toBe(false);
    expect(chatFlagValueOf({ kind: 'unread' }, true)).toBe(true);
    expect(chatFlagValueOf(saved(null), false)).toBe(false);
  });

  it('draws the tap rather than the choice it is replacing', () => {
    const picking: ChatFlag = {
      kind: 'picking',
      next: false,
      was: { choice: true, application: 'current' },
    };

    expect(chatFlagValueOf(picking, true)).toBe(false);
  });

  it('draws what a refusal put back', () => {
    const refused: ChatFlag = { kind: 'refused', was: { choice: true, application: 'current' } };

    expect(chatFlagValueOf(refused, false)).toBe(true);
  });

  it('claims the session is behind only for a saved choice it has not moved onto', () => {
    expect(chatFlagBehind(saved(true, 'behind'))).toBe(true);
    expect(chatFlagBehind(saved(true, 'moving'))).toBe(false);
    expect(chatFlagBehind(saved(true))).toBe(false);
    expect(
      chatFlagBehind({ kind: 'picking', next: true, was: { choice: false, application: 'behind' } })
    ).toBe(false);
  });
});
