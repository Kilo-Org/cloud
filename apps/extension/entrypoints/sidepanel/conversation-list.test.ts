// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import {
  decideConversationScroll,
  isAtConversationBottom,
  isDifferentConversation,
} from './conversation-list';

/*
 * The virtualizer renders no rows under jsdom (see agents-session-view.test.ts),
 * so these tests cover the scroll decision itself, not the DOM scroll.
 */

const atBottom = { clientHeight: 400, scrollHeight: 2000, scrollTop: 1600 };
const scrolledUp = { clientHeight: 400, scrollHeight: 2000, scrollTop: 400 };

describe('isAtConversationBottom()', () => {
  it('accepts the exact bottom', () => {
    expect(isAtConversationBottom(atBottom)).toBe(true);
  });

  it('accepts a correction inside the 100px band', () => {
    // A late row measurement moves the offset by tens of pixels; that is not the user leaving.
    expect(isAtConversationBottom({ ...atBottom, scrollTop: 1520 })).toBe(true);
  });

  it('rejects a position past the band', () => {
    expect(isAtConversationBottom({ ...atBottom, scrollTop: 1480 })).toBe(false);
  });

  it('treats a non-scrollable list as the bottom', () => {
    expect(isAtConversationBottom({ clientHeight: 400, scrollHeight: 400, scrollTop: 0 })).toBe(
      true
    );
  });
});

describe('decideConversationScroll()', () => {
  it('keeps following through a virtualizer correction at the bottom', () => {
    expect(
      decideConversationScroll({
        lastPinnedTop: 1600,
        position: { ...atBottom, scrollTop: 1540 },
        sawDownwardIntent: false,
      })
    ).toBe('keep');
  });

  it('releases when an offset we did not write sits away from the bottom', () => {
    // A scrollbar drag: nothing else moved the list, so this is the user leaving.
    expect(
      decideConversationScroll({
        lastPinnedTop: 1600,
        position: scrolledUp,
        sawDownwardIntent: false,
      })
    ).toBe('release');
  });

  it('releases on a drag away from the bottom even without a recorded gesture', () => {
    // The upward drag and our pin write coalesce into one scroll event, so direction is unusable.
    expect(
      decideConversationScroll({
        lastPinnedTop: 1600,
        position: { ...atBottom, scrollTop: 0 },
        sawDownwardIntent: false,
      })
    ).toBe('release');
  });

  it('keeps pinning when content grew below the offset we last wrote', () => {
    // Growth raises scrollHeight without moving scrollTop: the offset is still ours.
    expect(
      decideConversationScroll({
        lastPinnedTop: 1600,
        position: { ...atBottom, scrollHeight: 3000 },
        sawDownwardIntent: false,
      })
    ).toBe('keep');
  });

  it('tolerates the sub-pixel offset a fractional device ratio reports back', () => {
    expect(
      decideConversationScroll({
        lastPinnedTop: 1600,
        position: { ...atBottom, scrollHeight: 3000, scrollTop: 1600.5 },
        sawDownwardIntent: false,
      })
    ).toBe('keep');
  });

  it('does not re-follow when a programmatic scroll lands at the bottom', () => {
    expect(
      decideConversationScroll({
        lastPinnedTop: 400,
        position: atBottom,
        sawDownwardIntent: false,
      })
    ).toBe('keep');
  });

  it('re-follows when a downward gesture reaches the bottom', () => {
    expect(
      decideConversationScroll({
        lastPinnedTop: 400,
        position: atBottom,
        sawDownwardIntent: true,
      })
    ).toBe('follow');
  });

  it('does not re-follow on a downward gesture that has not reached the bottom yet', () => {
    // Away from the bottom the decision never re-arms following, whatever it does otherwise.
    expect(
      decideConversationScroll({
        lastPinnedTop: 400,
        position: { ...atBottom, scrollTop: 1000 },
        sawDownwardIntent: true,
      })
    ).not.toBe('follow');
  });
});

describe('isDifferentConversation()', () => {
  const ends = { firstKey: 'a', lastKey: 'z' };

  it('reports a swap when both ends change', () => {
    expect(isDifferentConversation(ends, { firstKey: 'p', lastKey: 'q' })).toBe(true);
  });

  it('does not report a swap when older messages are prepended', () => {
    expect(isDifferentConversation(ends, { firstKey: 'older', lastKey: 'z' })).toBe(false);
  });

  it('does not report a swap when a new message is appended', () => {
    expect(isDifferentConversation(ends, { firstKey: 'a', lastKey: 'newer' })).toBe(false);
  });

  it('does not report a swap when nothing changed', () => {
    expect(isDifferentConversation(ends, ends)).toBe(false);
  });
});
