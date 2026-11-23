import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSettledReplace } from './settled-replace';

const replaceMock = vi.hoisted(() => vi.fn());

type Listener = () => void;

// The navigator the hook subscribes to, and the events a suite fires by hand.
const nav = vi.hoisted<{ listeners: Map<string, Set<Listener>> }>(() => ({
  listeners: new Map(),
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ replace: replaceMock }),
  useNavigation: () => ({
    addListener: (event: string, listener: Listener) => {
      const listeners = nav.listeners.get(event) ?? new Set();
      listeners.add(listener);
      nav.listeners.set(event, listeners);
      return () => {
        listeners.delete(listener);
      };
    },
  }),
}));

let latestReplace: ((href: string) => void) | undefined = undefined;

function Harness() {
  latestReplace = useSettledReplace().replace as (href: string) => void;
  return null;
}

function mount() {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(Harness));
  });
  if (!ref.current) {
    throw new Error('harness did not render');
  }
  return ref.current;
}

function fire(event: 'transitionStart' | 'transitionEnd') {
  act(() => {
    for (const listener of nav.listeners.get(event) ?? []) {
      listener();
    }
  });
}

/** One macrotask, inside `act` so a dispatch it triggers is applied. */
async function flushTask() {
  const task = Promise.withResolvers<undefined>();
  setTimeout(() => {
    task.resolve(undefined);
  }, 0);
  await task.promise;
}

/** Flush macrotasks so a scheduled dispatch would have run. */
async function flushTasks() {
  await act(async () => {
    await flushTask();
    await flushTask();
  });
}

function unmount(renderer: TestRenderer.ReactTestRenderer) {
  act(() => {
    renderer.unmount();
  });
}

describe('useSettledReplace', () => {
  beforeEach(() => {
    replaceMock.mockReset();
    nav.listeners.clear();
    latestReplace = undefined;
  });

  it('never dispatches synchronously; one macrotask later it replaces', async () => {
    const renderer = mount();

    latestReplace?.('/(app)/security-agent/personal/settings');

    // A swap committed in the same turn as a guard's disarm or a running
    // transition crashes Android Fabric.
    expect(replaceMock).not.toHaveBeenCalled();

    await flushTasks();

    expect(replaceMock).toHaveBeenCalledExactlyOnceWith('/(app)/security-agent/personal/settings');

    unmount(renderer);
  });

  it('holds the replace until a running transition ends', async () => {
    const renderer = mount();

    fire('transitionStart');
    latestReplace?.('/(app)/security-agent/personal/settings');
    await flushTasks();

    // The destination would have landed inside the running animation's commit.
    expect(replaceMock).not.toHaveBeenCalled();

    fire('transitionEnd');

    expect(replaceMock).toHaveBeenCalledExactlyOnceWith('/(app)/security-agent/personal/settings');

    unmount(renderer);
  });

  it('keeps only the latest destination queued behind one transition', async () => {
    const renderer = mount();

    fire('transitionStart');
    latestReplace?.('/(app)/security-agent/personal/settings');
    latestReplace?.('/(app)/security-agent/org-1/settings');
    await flushTasks();
    expect(replaceMock).not.toHaveBeenCalled();

    fire('transitionEnd');

    expect(replaceMock).toHaveBeenCalledExactlyOnceWith('/(app)/security-agent/org-1/settings');

    unmount(renderer);
  });

  it('dispatches once per settled bounce', async () => {
    const renderer = mount();

    latestReplace?.('/(app)/security-agent/personal/settings');
    await flushTasks();
    fire('transitionStart');
    latestReplace?.('/(app)/security-agent/personal/settings');
    fire('transitionEnd');

    expect(replaceMock).toHaveBeenCalledTimes(2);

    unmount(renderer);
  });

  it('dispatches a destination whose transition end never arrives', () => {
    vi.useFakeTimers();
    try {
      const renderer = mount();

      fire('transitionStart');
      latestReplace?.('/(app)/security-agent/personal/settings');

      // A real push or pop animates for a few hundred milliseconds: the end
      // may still be on its way, so the destination must keep waiting.
      act(() => {
        vi.advanceTimersByTime(999);
      });
      expect(replaceMock).not.toHaveBeenCalled();

      // Past the bound the end was lost, so the navigator counts as settled.
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(replaceMock).toHaveBeenCalledExactlyOnceWith(
        '/(app)/security-agent/personal/settings'
      );

      unmount(renderer);
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispatches once on a transition end and does nothing when the bound expires', () => {
    vi.useFakeTimers();
    try {
      const renderer = mount();

      fire('transitionStart');
      latestReplace?.('/(app)/security-agent/personal/settings');
      fire('transitionEnd');

      expect(replaceMock).toHaveBeenCalledExactlyOnceWith(
        '/(app)/security-agent/personal/settings'
      );

      // Nothing is queued any more, so the bound must not dispatch a second swap.
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(replaceMock).toHaveBeenCalledTimes(1);

      unmount(renderer);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the next-task dispatch with no transition running, and dispatches once', () => {
    vi.useFakeTimers();
    try {
      const renderer = mount();

      latestReplace?.('/(app)/security-agent/personal/settings');
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(replaceMock).toHaveBeenCalledExactlyOnceWith(
        '/(app)/security-agent/personal/settings'
      );

      // The bound only covers a transition that never ended; it must not add a
      // second dispatch to the plain next-task path.
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(replaceMock).toHaveBeenCalledTimes(1);

      unmount(renderer);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not dispatch after unmount', async () => {
    const renderer = mount();

    latestReplace?.('/(app)/security-agent/personal/settings');
    unmount(renderer);
    await flushTasks();
    fire('transitionEnd');

    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('does not dispatch after unmount when a transition was pending', async () => {
    const renderer = mount();

    fire('transitionStart');
    latestReplace?.('/(app)/security-agent/personal/settings');
    unmount(renderer);
    await flushTasks();

    expect(replaceMock).not.toHaveBeenCalled();
  });
});
