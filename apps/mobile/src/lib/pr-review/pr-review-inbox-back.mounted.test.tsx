// The PR-review detail surfaces share one Back rule. The header callback and
// Android's hardware/gesture Back both dismiss to the PR Review inbox, so a
// deep link that renders on top of the tab anchor cannot pop out to Home, and
// the hardware event is consumed so the navigator does not also pop.

import { createElement, useEffect } from 'react';
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

const focus = vi.hoisted(() => ({ focused: true }));

vi.mock('expo-router', () => ({
  useRouter: () => router,
  // The real hook binds the effect to the screen's focus; the test drives the
  // bound effect directly so it can observe registration and cleanup.
  useFocusEffect: (effect: () => () => void) => {
    useEffect(() => (focus.focused ? effect() : undefined), [effect]);
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
  focus.focused = true;
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
