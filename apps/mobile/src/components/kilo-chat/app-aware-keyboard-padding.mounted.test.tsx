import { createElement } from 'react';
import { type KeyboardEvent } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { AppAwareKeyboardPaddingView } from './app-aware-keyboard-padding';

const native = vi.hoisted(() => ({
  platform: 'android',
  screenHeight: 900,
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

  it.each([300, 324])('uses the visible top, not the reported height (%i)', height => {
    const view = mountPadding();
    expect(view.padding()).toBe(0);
    // The same top edge can carry a height excluding system bars or including them.
    showKeyboard(height, 576);
    expect(view.padding()).toBe(324);
    view.unmount();
  });

  it('tracks a short keyboard and a changed screen size', () => {
    const view = mountPadding();
    showKeyboard(24, 852);
    expect(view.padding()).toBe(48);
    native.screenHeight = 600;
    showKeyboard(200, 400);
    expect(view.padding()).toBe(200);
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

  it('clamps offscreen keyboards and applies a caller offset only while visible', () => {
    const view = mountPadding(16);
    expect(view.padding()).toBe(0);
    showKeyboard(324, 576);
    expect(view.padding()).toBe(340);
    showKeyboard(0, 900);
    expect(view.padding()).toBe(0);
    showKeyboard(0, 950);
    expect(view.padding()).toBe(0);
    view.unmount();
  });
});
