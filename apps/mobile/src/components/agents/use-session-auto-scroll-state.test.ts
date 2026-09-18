import { describe, expect, it } from 'vitest';
import {
  classifySessionTranscriptGrowth,
  getInitialSessionListAutoScrollVisibility,
  isSessionListAtBottom,
  SESSION_LIST_BOTTOM_THRESHOLD_PX,
  shouldFollowSessionContentSize,
  shouldRetrySessionAutoScroll,
  shouldScheduleSessionAutoScroll,
} from '@/components/agents/use-session-auto-scroll-state';

describe('classifySessionTranscriptGrowth', () => {
  it('classifies a page of older messages prepended above the first key', () => {
    // The transcript is chronological and older pages are inserted before
    // the existing first item: the first key changes while the last key
    // (the newest message) stays put. That is a prepend, not new messages.
    expect(
      classifySessionTranscriptGrowth({
        previousCount: 10,
        nextCount: 20,
        previousFirstKey: 'm10',
        nextFirstKey: 'm0',
        previousLastKey: 'm19',
        nextLastKey: 'm19',
      })
    ).toBe('prepend');
  });

  it('classifies a streaming insertion at the bottom as an append', () => {
    expect(
      classifySessionTranscriptGrowth({
        previousCount: 10,
        nextCount: 11,
        previousFirstKey: 'm0',
        nextFirstKey: 'm0',
        previousLastKey: 'm9',
        nextLastKey: 'm10',
      })
    ).toBe('append');
  });

  it('classifies equal counts as no growth even when keys change', () => {
    expect(
      classifySessionTranscriptGrowth({
        previousCount: 10,
        nextCount: 10,
        previousFirstKey: 'm0',
        nextFirstKey: 'x0',
        previousLastKey: 'm9',
        nextLastKey: 'x9',
      })
    ).toBe('none');
  });

  it('classifies a wholesale transcript swap as replace', () => {
    expect(
      classifySessionTranscriptGrowth({
        previousCount: 10,
        nextCount: 20,
        previousFirstKey: 'm0',
        nextFirstKey: 'x0',
        previousLastKey: 'm9',
        nextLastKey: 'x19',
      })
    ).toBe('replace');
  });

  it('classifies a first render (no previous keys) as replace', () => {
    expect(
      classifySessionTranscriptGrowth({
        previousCount: 0,
        nextCount: 5,
        previousFirstKey: null,
        nextFirstKey: 'm0',
        previousLastKey: null,
        nextLastKey: 'm4',
      })
    ).toBe('replace');
  });
});

describe('isSessionListAtBottom', () => {
  it('returns true when the viewport bottom is within the bottom threshold', () => {
    expect(
      isSessionListAtBottom({
        contentHeight: 1000,
        viewportHeight: 600,
        offsetY: 350,
      })
    ).toBe(true);
  });

  it('returns true when the viewport bottom touches the end of the content', () => {
    expect(
      isSessionListAtBottom({
        contentHeight: 1000,
        viewportHeight: 600,
        offsetY: 400,
      })
    ).toBe(true);
  });

  it('returns false when the user has scrolled past the bottom threshold', () => {
    expect(
      isSessionListAtBottom({
        contentHeight: 2000,
        viewportHeight: 600,
        offsetY: 900,
      })
    ).toBe(false);
  });

  it('returns true at the very top of a short list whose content fits the viewport', () => {
    // A short list is fully visible: there is no "below the fold" content
    // and the viewport bottom equals the content bottom.
    expect(
      isSessionListAtBottom({
        contentHeight: 300,
        viewportHeight: 600,
        offsetY: 0,
      })
    ).toBe(true);
  });

  it('returns true for any offset when the content is shorter than the viewport', () => {
    // The scroll-to-bottom button must never show on short/empty
    // conversations: a content height smaller than the viewport height
    // means the entire transcript is already visible, so the user is
    // at the bottom by definition. Cover both the no-scroll case and
    // a non-zero (but still-fully-visible) offset to lock the
    // "content < viewport" branch.
    expect(
      isSessionListAtBottom({
        contentHeight: 200,
        viewportHeight: 600,
        offsetY: 0,
      })
    ).toBe(true);
    expect(
      isSessionListAtBottom({
        contentHeight: 400,
        viewportHeight: 600,
        offsetY: 50,
      })
    ).toBe(true);
    expect(SESSION_LIST_BOTTOM_THRESHOLD_PX).toBe(100);
  });

  it('respects a custom threshold for the bottom-stickiness band', () => {
    expect(
      isSessionListAtBottom({
        contentHeight: 1000,
        viewportHeight: 600,
        offsetY: 350,
        thresholdPx: 50,
      })
    ).toBe(false);
    expect(
      isSessionListAtBottom({
        contentHeight: 1000,
        viewportHeight: 600,
        offsetY: 360,
        thresholdPx: 50,
      })
    ).toBe(true);
  });
});

describe('getInitialSessionListAutoScrollVisibility', () => {
  it('starts at-bottom so the scroll-to-bottom button is hidden on first render', () => {
    // A fresh transcript is rendered anchored to the latest message, so
    // the floating "scroll to bottom" button must never be visible until
    // the user has actually scrolled away.
    expect(getInitialSessionListAutoScrollVisibility()).toEqual({
      shouldAutoScroll: true,
      isAtBottom: true,
    });
  });

  it('is the reset target used when the session changes', () => {
    // The hook's `resetKey` effect calls this helper to restore both the
    // auto-follow ref and the at-bottom React state. A new/empty session
    // must therefore never open with the button visible.
    const reset = getInitialSessionListAutoScrollVisibility();
    expect(reset.isAtBottom).toBe(true);
    expect(reset.shouldAutoScroll).toBe(true);
  });
});

describe('shouldScheduleSessionAutoScroll', () => {
  it('schedules when the user is at the bottom, not auto-scrolling, and not actively dragging', () => {
    expect(
      shouldScheduleSessionAutoScroll({
        isAutoScrolling: false,
        isUserScrolling: false,
        shouldAutoScroll: true,
      })
    ).toBe(true);
  });

  it('does not schedule while the user is actively dragging or in momentum fling', () => {
    // Programmatic scroll during a drag yanks the viewport and the user's
    // drag appears to "bounce back".
    expect(
      shouldScheduleSessionAutoScroll({
        isAutoScrolling: false,
        isUserScrolling: true,
        shouldAutoScroll: true,
      })
    ).toBe(false);
  });

  it('does not schedule when the hook believes it just issued a programmatic scroll', () => {
    expect(
      shouldScheduleSessionAutoScroll({
        isAutoScrolling: true,
        isUserScrolling: false,
        shouldAutoScroll: true,
      })
    ).toBe(false);
  });

  it('does not schedule when the user has scrolled away from the bottom', () => {
    expect(
      shouldScheduleSessionAutoScroll({
        isAutoScrolling: false,
        isUserScrolling: false,
        shouldAutoScroll: false,
      })
    ).toBe(false);
  });
});

describe('shouldRetrySessionAutoScroll', () => {
  it('permits the 80ms safety-net retry while a programmatic scroll is still in flight', () => {
    // The whole point of the 80ms retry is to recover when the first
    // scroll didn't reach the bottom. A programmatic scroll that's still
    // within its 150ms `isAutoScrolling` window must not suppress the
    // retry: that would make the retry dead during the highest-frequency
    // streaming window.
    expect(
      shouldRetrySessionAutoScroll({
        isUserScrolling: false,
        shouldAutoScroll: true,
      })
    ).toBe(true);
  });

  it('blocks the retry while the user is actively dragging or in momentum fling', () => {
    // A retry during a drag would yank the viewport and the user's drag
    // appears to "bounce back".
    expect(
      shouldRetrySessionAutoScroll({
        isUserScrolling: true,
        shouldAutoScroll: true,
      })
    ).toBe(false);
  });

  it('blocks the retry when the user has scrolled away from the bottom', () => {
    expect(
      shouldRetrySessionAutoScroll({
        isUserScrolling: false,
        shouldAutoScroll: false,
      })
    ).toBe(false);
  });
});

describe('shouldFollowSessionContentSize', () => {
  it('permits a content-size follow scroll while a programmatic scroll is still in flight', () => {
    // Rapid streaming content-size changes that arrive during the 150ms
    // programmatic-scroll window must still keep the viewport pinned to
    // the bottom. Gating on `!isAutoScrolling` here would silently drop
    // every streaming update that lands inside the debounce window.
    expect(
      shouldFollowSessionContentSize({
        isUserScrolling: false,
        shouldAutoScroll: true,
        didContentHeightChange: true,
      })
    ).toBe(true);
  });

  it('blocks the follow when the content height has not actually changed', () => {
    // A redundant measurement (e.g. layout pass with the same height)
    // must not trigger another programmatic scroll.
    expect(
      shouldFollowSessionContentSize({
        isUserScrolling: false,
        shouldAutoScroll: true,
        didContentHeightChange: false,
      })
    ).toBe(false);
  });

  it('blocks the follow when the growth is a prepend even while at the bottom', () => {
    // Older messages land above the viewport. Following the content-size
    // growth would yank the user back to the bottom mid-read; the stale
    // `shouldAutoScroll` ref (still true inside the 150ms programmatic
    // window) must not be able to force it.
    expect(
      shouldFollowSessionContentSize({
        isUserScrolling: false,
        shouldAutoScroll: true,
        didContentHeightChange: true,
        isPrepend: true,
      })
    ).toBe(false);
    expect(
      shouldFollowSessionContentSize({
        isUserScrolling: false,
        shouldAutoScroll: false,
        didContentHeightChange: true,
        isPrepend: true,
      })
    ).toBe(false);
  });

  it('blocks the follow while the user is actively dragging or in momentum fling', () => {
    expect(
      shouldFollowSessionContentSize({
        isUserScrolling: true,
        shouldAutoScroll: true,
        didContentHeightChange: true,
      })
    ).toBe(false);
  });

  it('blocks the follow when the user has scrolled away from the bottom', () => {
    expect(
      shouldFollowSessionContentSize({
        isUserScrolling: false,
        shouldAutoScroll: false,
        didContentHeightChange: true,
      })
    ).toBe(false);
  });
});
