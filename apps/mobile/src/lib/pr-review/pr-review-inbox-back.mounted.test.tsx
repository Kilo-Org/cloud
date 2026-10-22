// The PR-review detail surfaces share one Back rule. The header callback and
// Android's hardware/gesture Back both dismiss to the PR Review inbox, so a
// deep link that renders on top of the tab anchor cannot pop out to Home, and
// the hardware event is consumed so the navigator does not also pop.

import { createElement, useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { usePrReviewInboxBack, usePrReviewInboxHardwareBack } from './pr-review-inbox-back';

const router = vi.hoisted(() => ({ dismissTo: vi.fn() }));

const backHandler = vi.hoisted(() => {
  const handlers = new Set<() => boolean>();
  return {
    handlers,
    addEventListener: (_event: string, handler: () => boolean) => {
      handlers.add(handler);
      return {
        remove: () => {
          handlers.delete(handler);
        },
      };
    },
  };
});

// Models React Navigation's focus: `useFocusEffect` runs its effect while the
// screen is focused, cleans up on blur, and runs again when focus returns.
const focus = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    focused: true,
    set(focused: boolean) {
      focus.focused = focused;
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset() {
      listeners.clear();
      focus.focused = true;
    },
  };
});

vi.mock('expo-router', () => ({
  useRouter: () => router,
  useFocusEffect: (effect: () => undefined | (() => void)) => {
    const [focused, setFocused] = useState(focus.focused);
    useEffect(
      () =>
        focus.subscribe(() => {
          setFocused(focus.focused);
        }),
      []
    );
    useEffect(() => (focused ? effect() : undefined), [effect, focused]);
  },
}));
vi.mock('react-native', () => ({ BackHandler: backHandler }));

function Screen() {
  const back = usePrReviewInboxBack();
  usePrReviewInboxHardwareBack();
  return createElement('Pressable', { onPress: back });
}

let mounted: TestRenderer.ReactTestRenderer | undefined = undefined;

function mount() {
  act(() => {
    mounted = TestRenderer.create(createElement(Screen));
  });
  if (!mounted) {
    throw new Error('screen did not mount');
  }
  return mounted;
}

function pressHardwareBack(): boolean {
  let handled = false;
  act(() => {
    for (const handler of backHandler.handlers) {
      handled = handler();
    }
  });
  return handled;
}

beforeEach(() => {
  vi.resetAllMocks();
  backHandler.handlers.clear();
  focus.reset();
});

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

describe('PR-review inbox back', () => {
  it('dismisses the header control to the PR Review inbox', () => {
    const renderer = mount();

    act(() => {
      (renderer.root.findByType('Pressable').props.onPress as () => void)();
    });

    expect(router.dismissTo).toHaveBeenCalledExactlyOnceWith('/(app)/pr-review');
  });

  it('consumes Android hardware Back and dismisses to the inbox', () => {
    mount();

    expect(pressHardwareBack()).toBe(true);
    expect(router.dismissTo).toHaveBeenCalledExactlyOnceWith('/(app)/pr-review');
  });

  it('drops the listener while the screen is blurred and restores it on focus', () => {
    mount();
    expect(backHandler.handlers.size).toBe(1);

    act(() => {
      focus.set(false);
    });
    expect(backHandler.handlers.size).toBe(0);

    act(() => {
      focus.set(true);
    });
    expect(backHandler.handlers.size).toBe(1);
  });

  it('drops the hardware listener when the screen unmounts', () => {
    const renderer = mount();
    expect(backHandler.handlers.size).toBe(1);

    act(() => {
      renderer.unmount();
    });
    mounted = undefined;

    expect(backHandler.handlers.size).toBe(0);
  });
});
