// Back from a model detail is one rule for both exits: the header control and
// Android's hardware/gesture Back dismiss to the catalog list. The list stays
// mounted when it is beneath the detail (so its scroll position survives), and
// a detail opened without it — a deep link — gets the list in its place instead
// of revealing whatever route the stack happens to hold.

import { createElement, useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { useModelCatalogBack, useModelCatalogHardwareBack } from './model-catalog-back';

const router = vi.hoisted(() => ({ dismissTo: vi.fn() }));

// Models React Native's BackHandler as a set of live subscriptions so the test
// can press Back and observe exactly what the screen registered.
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

// Models React Navigation's focus: the effect runs while the screen is
// focused, cleans up on blur, and runs again when focus returns.
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
  const back = useModelCatalogBack();
  useModelCatalogHardwareBack();
  return createElement('Pressable', { onPress: back });
}

let mounted: TestRenderer.ReactTestRenderer | undefined = undefined;

function mount() {
  act(() => {
    mounted = TestRenderer.create(createElement(Screen));
  });
  if (!mounted) {
    throw new Error('model detail back did not mount');
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

describe('model detail back', () => {
  it('dismisses the header control to the catalog list', () => {
    const renderer = mount();

    act(() => {
      (renderer.root.findByType('Pressable').props.onPress as () => void)();
    });

    expect(router.dismissTo).toHaveBeenCalledExactlyOnceWith('/model-catalog');
  });

  it('consumes Android hardware Back and dismisses to the catalog list', () => {
    mount();

    expect(pressHardwareBack()).toBe(true);
    expect(router.dismissTo).toHaveBeenCalledExactlyOnceWith('/model-catalog');
  });

  it('drops the listener while the detail is blurred and restores it on focus', () => {
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

  it('drops the hardware listener when the detail unmounts', () => {
    const renderer = mount();
    expect(backHandler.handlers.size).toBe(1);

    act(() => {
      renderer.unmount();
    });
    mounted = undefined;

    expect(backHandler.handlers.size).toBe(0);
  });
});
