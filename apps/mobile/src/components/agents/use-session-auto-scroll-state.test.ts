import { describe, expect, it } from 'vitest';
import {
  getInitialSessionListAutoScrollVisibility,
  isSessionListAtBottom,
  SESSION_LIST_BOTTOM_THRESHOLD_PX,
  shouldFollowSessionContentSize,
  shouldFollowSessionViewportResize,
  shouldRetrySessionAutoScroll,
  shouldScheduleSessionAutoScroll,
} from '@/components/agents/use-session-auto-scroll-state';

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

  it('opens without following the tail when a resume anchor is set', () => {
    // A `?at=` resume lands on an older row: the mount-time scroll to the
    // newest message would discard the resume position. The button state is
    // unchanged — the first real scroll event decides it.
    expect(getInitialSessionListAutoScrollVisibility({ followTail: false })).toEqual({
      shouldAutoScroll: false,
      isAtBottom: true,
    });
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

  it('does not schedule when only an older page was prepended (newest key unchanged)', () => {
    // The item count grew, but the tail of the list did not move: an older
    // page landed. Scheduling a scroll here would yank the viewport back to
    // the newest message while the user is reading history.
    expect(
      shouldScheduleSessionAutoScroll({
        isAutoScrolling: false,
        isUserScrolling: false,
        shouldAutoScroll: true,
        newestKeyChanged: false,
      })
    ).toBe(false);
  });

  it('schedules when the newest item key changed', () => {
    expect(
      shouldScheduleSessionAutoScroll({
        isAutoScrolling: false,
        isUserScrolling: false,
        shouldAutoScroll: true,
        newestKeyChanged: true,
      })
    ).toBe(true);
  });

  it('keeps scheduling for callers that do not track the newest key', () => {
    // Layout and keyboard triggers have no item identity; omitting the new
    // guard must preserve the previous behavior.
    expect(
      shouldScheduleSessionAutoScroll({
        isAutoScrolling: false,
        isUserScrolling: false,
        shouldAutoScroll: true,
      })
    ).toBe(true);
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

describe('shouldFollowSessionViewportResize', () => {
  it('permits a viewport-resize follow scroll while a programmatic scroll is still in flight', () => {
    // The fixed status row (working indicator / session status indicator)
    // mounts outside the list, so the viewport shrinks while the offset stays
    // put. During streaming that resize lands inside the 150ms programmatic
    // window, and gating on `!isAutoScrolling` would leave the newest row
    // below the fold — drawn over the status row, because the list does not
    // clip.
    expect(
      shouldFollowSessionViewportResize({
        isUserScrolling: false,
        shouldAutoScroll: true,
        didViewportHeightChange: true,
      })
    ).toBe(true);
  });

  it('blocks the follow when the viewport height has not actually changed', () => {
    // A redundant layout pass (same height) must keep the guarded scheduler
    // instead of taking the bypass, so it cannot stack scrolls on top of a
    // programmatic scroll already in flight.
    expect(
      shouldFollowSessionViewportResize({
        isUserScrolling: false,
        shouldAutoScroll: true,
        didViewportHeightChange: false,
      })
    ).toBe(false);
  });

  it('blocks the follow while the user is actively dragging or in momentum fling', () => {
    expect(
      shouldFollowSessionViewportResize({
        isUserScrolling: true,
        shouldAutoScroll: true,
        didViewportHeightChange: true,
      })
    ).toBe(false);
  });

  it('blocks the follow when the user has scrolled away from the bottom', () => {
    // A keyboard or row resize must never yank a reader who scrolled back.
    expect(
      shouldFollowSessionViewportResize({
        isUserScrolling: false,
        shouldAutoScroll: false,
        didViewportHeightChange: true,
      })
    ).toBe(false);
  });
});
