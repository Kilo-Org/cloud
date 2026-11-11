/* eslint-disable max-lines -- the coalescing cases share one probe and one task harness. */
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
};

type ScrollList = { scrollToEnd: ReturnType<typeof vi.fn> };

const layoutAt = (height: number): LayoutChangeEvent => {
  const event = { nativeEvent: { layout: { x: 0, y: 0, width: 400, height } } };
  return event as unknown as LayoutChangeEvent;
};

const mounted: ReactTestRenderer[] = [];

beforeEach(() => {
  // Mount arms an 80 ms retry on real timers; left running it adds a call to
  // the counts these cases assert.
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  for (const renderer of mounted.splice(0)) {
    renderer.unmount();
  }
});

/**
 * A keyboard slide reaches the list as a burst of layout and content-size
 * events: the viewport changes on every native keyboard step, and the composer
 * beside the transcript changes the content height in the same task. The hook
 * must turn that burst into one tail correction, not one per event.
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
  it('coalesces a viewport resize and the content change it causes into one correction', async () => {
    const probe = mountProbe();

    await act(async () => {
      probe.api.handleListLayout(layoutAt(500));
      probe.api.handleContentSizeChange(400, 900);
      await Promise.resolve();
    });

    expect(probe.list.scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it('keeps one correction for every layout step of a keyboard burst', async () => {
    const probe = mountProbe();

    await act(async () => {
      probe.api.handleListLayout(layoutAt(571));
      probe.api.handleContentSizeChange(400, 611);
      await Promise.resolve();
    });
    await act(async () => {
      probe.api.handleListLayout(layoutAt(427));
      probe.api.handleContentSizeChange(400, 467);
      await Promise.resolve();
    });
    await act(async () => {
      probe.api.handleListLayout(layoutAt(405));
      probe.api.handleContentSizeChange(400, 445);
      await Promise.resolve();
    });
    await act(async () => {
      probe.api.handleListLayout(layoutAt(394));
      probe.api.handleContentSizeChange(400, 434);
      await Promise.resolve();
    });

    expect(probe.list.scrollToEnd).toHaveBeenCalledTimes(4);
  });

  it('still corrects a streaming content growth that arrives on its own', async () => {
    const probe = mountProbe();

    await act(async () => {
      probe.api.handleContentSizeChange(400, 900);
      await Promise.resolve();
    });

    expect(probe.list.scrollToEnd).toHaveBeenCalledTimes(1);
  });
});
