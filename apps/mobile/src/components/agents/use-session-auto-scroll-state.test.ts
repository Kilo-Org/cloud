import { describe, expect, it } from 'vitest';
import {
  isSessionListAtBottom,
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
