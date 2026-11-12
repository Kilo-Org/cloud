/* eslint-disable max-lines -- the coalescing cases share one probe and one frame harness. */
import { createElement } from 'react';
import { type LayoutChangeEvent } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, type ReactTestRenderer, TestRenderer } from '@/test/renderer';

import { useSessionListAutoScroll } from './use-session-list-auto-scroll';

vi.mock('@/lib/a11y/motion', () => ({
  useMotionPolicy: () => ({ reducedMotion: false, scrollAnimated: true }),
}));

/** The slice of the hook a keyboard burst exercises. */
type ProbeApi = {
  listRef: { current: unknown };
  handleListLayout: (event: LayoutChangeEvent) => void;
  handleContentSizeChange: (width: number, height: number) => void;
  handleScrollBeginDrag: () => void;
};

type ScrollList = { scrollToEnd: ReturnType<typeof vi.fn> };

function layoutAt(height: number): LayoutChangeEvent {
  const event = { nativeEvent: { layout: { x: 0, y: 0, width: 400, height } } };
  return event as unknown as LayoutChangeEvent;
}

/** A frame queue the cases run by hand, like the shared coalescer's tests. */
const frames: (() => void)[] = [];

function runFrame() {
  const queued = frames.splice(0);
  act(() => {
    for (const frame of queued) {
      frame();
    }
  });
}

const mounted: ReactTestRenderer[] = [];

beforeEach(() => {
  // Mount arms a real 80 ms retry; left running it adds a call to the counts.
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => {
    frames.push(() => {
      frame(0);
    });
    return frames.length;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  frames.length = 0;
  for (const renderer of mounted.splice(0)) {
    renderer.unmount();
  }
});

/**
 * A keyboard slide reaches the list as a burst of layout and content-size
 * events: the viewport changes on every native keyboard step, and the composer
 * beside the transcript changes the content height in the same frame. The hook
 * must turn that burst into one tail correction per frame, not one per event.
 */
function mountProbe() {
  const list: ScrollList = { scrollToEnd: vi.fn() };
  const captured: { api: ProbeApi | null } = { api: null };

  function Probe() {
    const hook = useSessionListAutoScroll<string>({
      itemCount: 1,
      newestItemKey: 'message-1',
      resetKey: 'session-1',
    });
    captured.api = {
      listRef: hook.listRef,
      handleListLayout: hook.handleListLayout,
      handleContentSizeChange: hook.handleContentSizeChange,
      handleScrollBeginDrag: hook.handleScrollBeginDrag,
    };
    return null;
  }

  act(() => {
    mounted.push(TestRenderer.create(createElement(Probe)));
  });
  const api = captured.api;
  if (api === null) {
    throw new Error('probe did not mount');
  }
  api.listRef.current = list;
  list.scrollToEnd.mockClear();
  return { api, list };
}

describe('useSessionListAutoScroll viewport re-pin', () => {
  it('coalesces a viewport resize and the content change it causes into one correction', () => {
    const probe = mountProbe();

    act(() => {
      probe.api.handleListLayout(layoutAt(500));
      probe.api.handleContentSizeChange(400, 900);
    });
    expect(probe.list.scrollToEnd).not.toHaveBeenCalled();

    runFrame();
    expect(probe.list.scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it('keeps one correction for every layout step of a keyboard burst', () => {
    const probe = mountProbe();

    for (const height of [571, 427, 405, 394]) {
      act(() => {
        probe.api.handleListLayout(layoutAt(height));
        probe.api.handleContentSizeChange(400, height + 40);
      });
      runFrame();
    }

    expect(probe.list.scrollToEnd).toHaveBeenCalledTimes(4);
  });

  it('still corrects a streaming content growth that arrives on its own', () => {
    const probe = mountProbe();

    act(() => {
      probe.api.handleContentSizeChange(400, 900);
    });
    runFrame();

    expect(probe.list.scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it('corrects the tail again after the list remounts', () => {
    const first = mountProbe();
    act(() => {
      first.api.handleListLayout(layoutAt(500));
    });
    for (const renderer of mounted.splice(0)) {
      act(() => {
        renderer.unmount();
      });
    }
    runFrame();
    expect(first.list.scrollToEnd).not.toHaveBeenCalled();

    const second = mountProbe();
    act(() => {
      second.api.handleListLayout(layoutAt(500));
    });
    runFrame();
    expect(second.list.scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it('does not correct when the user starts dragging before the frame', () => {
    const probe = mountProbe();

    act(() => {
      probe.api.handleListLayout(layoutAt(500));
    });
    act(() => {
      probe.api.handleScrollBeginDrag();
    });
    runFrame();

    expect(probe.list.scrollToEnd).not.toHaveBeenCalled();
  });

  it('does not correct after the list unmounts', () => {
    const probe = mountProbe();

    act(() => {
      probe.api.handleListLayout(layoutAt(500));
    });
    for (const renderer of mounted) {
      act(() => {
        renderer.unmount();
      });
    }
    runFrame();

    expect(probe.list.scrollToEnd).not.toHaveBeenCalled();
  });
});
