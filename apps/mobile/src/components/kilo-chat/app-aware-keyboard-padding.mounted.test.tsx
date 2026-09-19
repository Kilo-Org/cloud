import { createElement } from 'react';
import { type KeyboardEvent } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { AppAwareKeyboardPaddingView } from './app-aware-keyboard-padding';

const native = vi.hoisted(() => ({
  platform: 'android',
  screenHeight: 900,
  bottomInset: 24,
  keyboardListeners: new Map<string, (event: KeyboardEvent) => void>(),
  appStateListener: undefined as ((state: string) => void) | undefined,
}));

vi.mock('react-native', () => ({
  View: 'View',
  Platform: {
    get OS() {
      return native.platform;
    },
  },
  Dimensions: { get: () => ({ height: native.screenHeight }) },
  Keyboard: {
    addListener: (name: string, listener: (event: KeyboardEvent) => void) => {
      native.keyboardListeners.set(name, listener);
      return { remove: () => native.keyboardListeners.delete(name) };
    },
  },
  AppState: {
    addEventListener: (_name: string, listener: (state: string) => void) => {
      native.appStateListener = listener;
      return {
        remove: () => {
          native.appStateListener = undefined;
        },
      };
    },
  },
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: native.bottomInset, left: 0, right: 0 }),
}));

function showKeyboard(height: number, screenY: number) {
  const name = native.platform === 'android' ? 'keyboardDidShow' : 'keyboardWillShow';
  const listener = native.keyboardListeners.get(name);
  expect(listener).toBeDefined();
  act(() =>
    listener?.({
      duration: 0,
      easing: 'keyboard',
      endCoordinates: { height, screenY, screenX: 0, width: 400 },
    })
  );
}

function mountPadding(keyboardOffset = 0) {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(AppAwareKeyboardPaddingView, { keyboardOffset })
    );
  });
  const mounted = ref.current;
  if (!mounted) {
    throw new Error('Keyboard padding view did not mount');
  }
  return {
    padding: () => {
      const view = mounted.root.find(node => String(node.type) === 'View');
      const { style } = view.props as { style: [unknown, { paddingBottom: number }] };
      return style[1].paddingBottom;
    },
    unmount: () =>
      act(() => {
        mounted.unmount();
      }),
  };
}

describe.each(['android', 'ios'])('keyboard clearance on %s', platform => {
  beforeEach(() => {
    native.platform = platform;
    native.screenHeight = 900;
    native.keyboardListeners.clear();
    native.appStateListener = undefined;
  });

  it.each([300, 324])('adds the Android system-bar inset to the reported height %i', height => {
    const view = mountPadding();
    expect(view.padding()).toBe(0);
    // Android edge-to-edge reports the nav-bar-excluded height, not the IME top.
    showKeyboard(height, platform === 'android' ? 876 : 576);
    expect(view.padding()).toBe(platform === 'android' ? height + native.bottomInset : 324);
    view.unmount();
  });

  it('tracks a short keyboard and a changed screen size', () => {
    const view = mountPadding();
    showKeyboard(24, platform === 'android' ? 876 : 852);
    expect(view.padding()).toBe(platform === 'android' ? 24 + native.bottomInset : 48);
    native.screenHeight = 600;
    showKeyboard(200, platform === 'android' ? 576 : 400);
    expect(view.padding()).toBe(platform === 'android' ? 200 + native.bottomInset : 200);
    view.unmount();
  });

  it('clears on dismissal and app background, and removes listeners on unmount', () => {
    const view = mountPadding();
    showKeyboard(324, 576);
    const hide = platform === 'android' ? 'keyboardDidHide' : 'keyboardWillHide';
    act(() =>
      native.keyboardListeners.get(hide)?.({
        duration: 0,
        easing: 'keyboard',
        endCoordinates: { height: 0, screenY: 900, screenX: 0, width: 400 },
      })
    );
    expect(view.padding()).toBe(0);
    showKeyboard(324, 576);
    act(() => native.appStateListener?.('background'));
    expect(view.padding()).toBe(0);
    view.unmount();
    expect(native.keyboardListeners.size).toBe(0);
    expect(native.appStateListener).toBeUndefined();
  });

  it('applies a caller offset only while the keyboard has positive overlap', () => {
    const view = mountPadding(24);
    expect(view.padding()).toBe(0);
    showKeyboard(300, platform === 'android' ? 876 : 600);
    expect(view.padding()).toBe(platform === 'android' ? 300 + 24 + native.bottomInset : 324);
    showKeyboard(0, platform === 'android' ? 876 : 900);
    expect(view.padding()).toBe(0);
    showKeyboard(-50, platform === 'android' ? 876 : 950);
    expect(view.padding()).toBe(0);
    view.unmount();
  });
});
