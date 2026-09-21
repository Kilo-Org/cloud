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
    probe.current = useSessionListAutoScroll<string>({ itemCount: count, resetKey: 'session-1' });
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
    });
    closeProgrammaticScrollWindow();
    scrollToEnd.mockClear();

    // A streamed row grows the content and starts a follow scroll.
    act(() => {
      api.handleContentSizeChange(400, 2000);
    });
    expect(scrollToEnd).toHaveBeenCalledTimes(1);

    scrollToEnd.mockClear();

    // Inside that window the status row mounts and the list gets shorter.
    act(() => {
      api.handleListLayout(layoutEvent(500));
    });

    expect(scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it('never yanks a reader who scrolled away from the bottom', () => {
    vi.useFakeTimers();
    const { scrollToEnd, api } = mountAutoScroll(1);

    act(() => {
      api.handleListLayout(layoutEvent(600));
    });
    closeProgrammaticScrollWindow();
    // Far from the content end: the follow is off.
    act(() => {
      api.handleScroll(scrollEvent(4000, 600, 0));
    });
    scrollToEnd.mockClear();

    act(() => {
      api.handleListLayout(layoutEvent(500));
    });

    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  it('never yanks a viewport resize during a drag', () => {
    vi.useFakeTimers();
    const { scrollToEnd, api } = mountAutoScroll(1);

    act(() => {
      api.handleListLayout(layoutEvent(600));
    });
    closeProgrammaticScrollWindow();
    act(() => {
      api.handleScrollBeginDrag();
    });
    scrollToEnd.mockClear();

    act(() => {
      api.handleListLayout(layoutEvent(500));
    });

    expect(scrollToEnd).not.toHaveBeenCalled();
  });
});
