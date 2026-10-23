/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native layout regression tests. */
import { createElement } from 'react';
import { type BottomTabBarButtonProps } from 'expo-router/js-tabs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { __resetTabSwitchInputForTests, isTabSwitchPending } from '@/lib/tab-switch-input-gate';

import { TabBarButton } from './tab-bar-button';

vi.mock('react-native', () => ({
  // The Android case on purpose: the cursor is one value for both platforms, so
  // the entry must not fall back to `auto` here.
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
}));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function renderButton(props: Partial<BottomTabBarButtonProps>) {
  act(() => {
    const element = createElement(TabBarButton, {
      children: null,
      ...props,
    } as unknown as BottomTabBarButtonProps);
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing TabBarButton renderer');
  }
  return renderer.root.findByType('Pressable' as unknown as React.ElementType);
}

beforeEach(() => {
  __resetTabSwitchInputForTests();
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('TabBarButton mounted layout', () => {
  // Android types a control by its native class: React Native maps the ARIA
  // `tab` role to a bare `android.view.View`, so the entry must carry the
  // button role to be a `android.widget.Button` in the accessibility tree.
  it('gives the entry the button role, not the tab role the library passes', () => {
    const button = renderButton({ role: 'tab' });
    expect(button.props.role).toBe('button');
  });

  // The label carries the tab meaning ("Home, tab, 1 of 3"); the button role
  // must not replace it.
  it('keeps the announced tab label', () => {
    const button = renderButton({ 'aria-label': 'Home, tab, 1 of 3' });
    expect(button.props['aria-label']).toBe('Home, tab, 1 of 3');
  });

  // The bar passes the entry's own ripple through; the button role must not
  // drop the press feedback.
  it('keeps the press ripple the bar passes', () => {
    const button = renderButton({ android_ripple: { borderless: true } });
    expect(button.props.android_ripple).toEqual({ borderless: true });
  });

  // The library's PlatformPressable cursors the entry on iOS pointer devices;
  // React Native's Pressable does not, so the entry must set it itself, with the
  // one value both platforms get.
  it('keeps the pointer cursor on every platform', () => {
    const button = renderButton({ style: { opacity: 1 } });
    expect(button.props.style).toEqual(expect.arrayContaining([{ cursor: 'pointer' }]));
  });
});

type PressProps = {
  onPressIn: (event: unknown) => void;
  onPress: (event: unknown) => void;
  onPressOut: (event: unknown) => void;
};

describe('TabBarButton tab switch gate', () => {
  // The outgoing tab is still hit-tested until the destination commits, so the
  // entry arms the input gate on the touch down, before the navigation starts.
  it('arms the input gate when the entry is touched', () => {
    const onPressIn = vi.fn<() => void>();
    const button = renderButton({ onPressIn });

    expect(isTabSwitchPending()).toBe(false);
    act(() => {
      (button.props as PressProps).onPressIn({});
    });

    expect(isTabSwitchPending()).toBe(true);
    expect(onPressIn).toHaveBeenCalledTimes(1);
  });

  it('leaves the gate closed before the entry is touched', () => {
    renderButton({ onPressIn: vi.fn<() => void>() });

    expect(isTabSwitchPending()).toBe(false);
  });

  // A gesture dragged off the entry never presses, so it must not hold the gate
  // open for the fallback.
  it('closes the gate when a touched entry is never pressed', async () => {
    vi.useFakeTimers();
    const button = renderButton({ onPress: vi.fn<() => void>() });
    const props = button.props as PressProps;
    act(() => {
      props.onPressIn({});
      props.onPressOut({});
    });

    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();

    expect(isTabSwitchPending()).toBe(false);
  });

  it('keeps the gate open when the press completes', async () => {
    vi.useFakeTimers();
    const onPress = vi.fn<() => void>();
    const button = renderButton({ onPress });
    const props = button.props as PressProps;
    act(() => {
      props.onPressIn({});
      props.onPressOut({});
      props.onPress({});
    });

    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(isTabSwitchPending()).toBe(true);
  });
});
