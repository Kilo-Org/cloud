import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { HEADER_BACK_GUARD_MS } from './header-back';
import { type HeaderBackOptions, useHeaderBack } from './use-header-back';

const router = vi.hoisted(() => ({ back: vi.fn(), dismissTo: vi.fn() }));

vi.mock('expo-router', () => ({ useRouter: () => router }));

const T0 = 1_700_000_000_000;

function Probe({
  props,
  press,
}: Readonly<{ props: HeaderBackOptions; press: { current: () => void } }>) {
  press.current = useHeaderBack(props);
  return null;
}

function mountHook(initial: HeaderBackOptions) {
  const press: { current: () => void } = { current: () => undefined };
  const created: { renderer: TestRenderer.ReactTestRenderer | undefined } = { renderer: undefined };
  act(() => {
    created.renderer = TestRenderer.create(createElement(Probe, { props: initial, press }));
  });
  const renderer = created.renderer;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return {
    press: () => {
      act(() => {
        press.current();
      });
    },
    rerender: (next: HeaderBackOptions) => {
      act(() => {
        renderer.update(createElement(Probe, { props: next, press }));
      });
    },
  };
}

// The hook reads `Date.now()`, so the burst window is driven from the fake clock.
function advance(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

beforeEach(() => {
  router.back.mockClear();
  router.dismissTo.mockClear();
  vi.useFakeTimers({ now: T0 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useHeaderBack', () => {
  it('pops once for a burst on the same header', () => {
    const header = mountHook({ canGoBack: true });

    header.press();
    advance(4);
    header.press();
    advance(40);
    header.press();

    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it('pops again once the window has passed', () => {
    const header = mountHook({ canGoBack: true });

    header.press();
    advance(HEADER_BACK_GUARD_MS);
    header.press();

    expect(router.back).toHaveBeenCalledTimes(2);
  });

  it('never pops without history', () => {
    const header = mountHook({ canGoBack: false });

    header.press();
    advance(HEADER_BACK_GUARD_MS);
    header.press();

    expect(router.back).not.toHaveBeenCalled();
    expect(router.dismissTo).not.toHaveBeenCalled();
  });

  it('dismisses to the declared fallback when the container has no history', () => {
    const header = mountHook({ canGoBack: false, backFallback: '/profile' });

    header.press();

    expect(router.back).not.toHaveBeenCalled();
    expect(router.dismissTo).toHaveBeenCalledWith('/profile');
  });

  it('runs the screen handler instead of a pop, once per burst', () => {
    const onBack = vi.fn<() => void>();
    const header = mountHook({ canGoBack: true, onBack });

    header.press();
    advance(4);
    header.press();

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(router.back).not.toHaveBeenCalled();
  });

  it('leaves the window unclaimed when the press has nothing to run', () => {
    const header = mountHook({ canGoBack: false });

    header.press();
    // The navigator gained history a moment later; the dropped press must not
    // hold the new one out of the same window.
    advance(10);
    header.rerender({ canGoBack: true });
    header.press();

    expect(router.back).toHaveBeenCalledTimes(1);
  });
});
