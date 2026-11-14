import { createElement } from 'react';
import { type FlashListRef } from '@shopify/flash-list';
import {
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useSessionListAutoScroll } from './use-session-list-auto-scroll';
import { MOMENTUM_BOUND_MS } from './use-session-list-scroll-timeouts';

// The follow policy only needs the scroll-animation preference; the battery and
// OS hooks behind the real policy are irrelevant here.
vi.mock('@/lib/a11y/motion', () => ({
  useMotionPolicy: () => ({ reducedMotion: false, scrollAnimated: false }),
}));

type AutoScrollApi = ReturnType<typeof useSessionListAutoScroll<string>>;

function layoutEvent(height: number): LayoutChangeEvent {
  const event = { nativeEvent: { layout: { x: 0, y: 0, width: 400, height } } };
  return event as unknown as LayoutChangeEvent;
}

function scrollEvent(
  contentHeight: number,
  viewportHeight: number,
  offsetY: number
): NativeSyntheticEvent<NativeScrollEvent> {
  const event = {
    nativeEvent: {
      contentOffset: { x: 0, y: offsetY },
      contentSize: { width: 400, height: contentHeight },
      layoutMeasurement: { width: 400, height: viewportHeight },
    },
  };
  return event as unknown as NativeSyntheticEvent<NativeScrollEvent>;
}

function mountAutoScroll(itemCount: number) {
  const probe: { current: AutoScrollApi | null } = { current: null };

  function Probe({ count }: Readonly<{ count: number }>) {
    probe.current = useSessionListAutoScroll<string>({
      itemCount: count,
      // The hook gates the item-count follow on the newest key changing. This
      // test only exercises viewport resize, but the param is required and a
      // constant list has a constant newest key.
      newestItemKey: `item-${count}`,
      resetKey: 'session-1',
    });
    return createElement('View', null);
  }

  act(() => {
    TestRenderer.create(createElement(Probe, { count: itemCount }));
  });

  const api = probe.current;
  if (api === null) {
    throw new Error('the auto-scroll probe did not mount');
  }

  const scrollToEnd = vi.fn();
  const handle: { scrollToEnd: typeof scrollToEnd } = { scrollToEnd };
  api.listRef.current = handle as unknown as FlashListRef<string>;
  return { scrollToEnd, api };
}

function closeProgrammaticScrollWindow() {
  // The mount follow arms a 150ms reset window and an 80ms safety-net retry;
  // the retry re-arms the reset, so the window only closes after both.
  act(() => {
    vi.advanceTimersByTime(500);
  });
}

describe('useSessionListAutoScroll viewport resize', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-pins the tail when the fixed status row shrinks the list inside the streaming follow window', () => {
    // Reproduces the session-answered defect: the working indicator / session
    // status row lives outside the list, so mounting it shrinks the viewport
    // while the offset stays put. The resize lands inside the 150ms
    // programmatic-scroll window a streaming content-size follow just opened;
    // the guarded scheduler drops it, the newest row is left below the fold,
    // and the list (which does not clip) draws it over the status row.
    vi.useFakeTimers();
    const { scrollToEnd, api } = mountAutoScroll(1);

    // The first layout records the pre-resize viewport height.
    act(() => {
      api.handleListLayout(layoutEvent(600));
      vi.advanceTimersByTime(1);
    });
    closeProgrammaticScrollWindow();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    scrollToEnd.mockClear();

    // A streamed row grows the content and starts a follow scroll.
    act(() => {
      api.handleContentSizeChange(400, 2000);
      vi.advanceTimersByTime(1);
    });
    expect(scrollToEnd).toHaveBeenCalledTimes(1);

    scrollToEnd.mockClear();

    // Inside that window the status row mounts and the list gets shorter.
    // The correction is coalesced to the task, so the resize and any content
    // change it carries land as one scroll.
    act(() => {
      api.handleListLayout(layoutEvent(500));
      vi.advanceTimersByTime(1);
    });

    expect(scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it('never yanks a reader who scrolled away from the bottom', () => {
    vi.useFakeTimers();
    const { scrollToEnd, api } = mountAutoScroll(1);

    act(() => {
      api.handleListLayout(layoutEvent(600));
      vi.advanceTimersByTime(1);
    });
    closeProgrammaticScrollWindow();
    // Far from the content end: the follow is off.
    act(() => {
      api.handleScroll(scrollEvent(4000, 600, 0));
    });
    scrollToEnd.mockClear();

    act(() => {
      api.handleListLayout(layoutEvent(500));
      vi.advanceTimersByTime(1);
    });

    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  it('never yanks a viewport resize during a drag', () => {
    vi.useFakeTimers();
    const { scrollToEnd, api } = mountAutoScroll(1);

    act(() => {
      api.handleListLayout(layoutEvent(600));
      vi.advanceTimersByTime(1);
    });
    closeProgrammaticScrollWindow();
    act(() => {
      api.handleScrollBeginDrag();
    });
    scrollToEnd.mockClear();

    act(() => {
      api.handleListLayout(layoutEvent(500));
      vi.advanceTimersByTime(1);
    });

    expect(scrollToEnd).not.toHaveBeenCalled();
  });
});

describe('useSessionListAutoScroll send during a fling', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('follows a content change after a send during a fling', () => {
    // Regression: the send set its take-over without clearing the live drag
    // claim, so the content-size follow refused to run and the reply streamed
    // in off-screen.
    vi.useFakeTimers();
    const { scrollToEnd, api } = mountAutoScroll(1);
    closeProgrammaticScrollWindow();

    act(() => {
      api.handleScrollBeginDrag();
      api.handleMomentumScrollBegin();
      api.followTailFromSend();
    });
    // The send scrolls directly; only the content follow is under test.
    scrollToEnd.mockClear();

    act(() => {
      api.handleContentSizeChange(400, 2000);
      vi.advanceTimersByTime(1);
    });

    expect(scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it('follows the tail again after the fling bound settles the claim', () => {
    // Regression: the bound ended motion but left the drag claim live, so the
    // content-size follow refused for the rest of the screen.
    vi.useFakeTimers();
    const { scrollToEnd, api } = mountAutoScroll(1);
    closeProgrammaticScrollWindow();

    act(() => {
      api.handleScrollBeginDrag();
      api.handleMomentumScrollBegin();
      // No momentum end ever arrives; the bound is the only thing that fires.
      vi.advanceTimersByTime(MOMENTUM_BOUND_MS + 1);
    });
    scrollToEnd.mockClear();

    act(() => {
      api.handleContentSizeChange(400, 2000);
      vi.advanceTimersByTime(1);
    });

    expect(scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it('keeps following after the fling ends with the send still claimed', () => {
    // The late momentum end is the drag's trailing motion: it must leave the
    // send's follow alone instead of turning it off from a stale offset.
    vi.useFakeTimers();
    const { scrollToEnd, api } = mountAutoScroll(1);
    closeProgrammaticScrollWindow();

    act(() => {
      api.handleScrollBeginDrag();
      api.handleMomentumScrollBegin();
      api.followTailFromSend();
      // Far from the content end: this event would turn the follow off.
      api.handleMomentumScrollEnd(scrollEvent(4000, 600, 0));
    });
    scrollToEnd.mockClear();

    act(() => {
      api.handleContentSizeChange(400, 2200);
      vi.advanceTimersByTime(1);
    });

    expect(scrollToEnd).toHaveBeenCalledTimes(1);
  });
});
