import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { TabBarButton, type TabBarButtonProps } from './tab-bar-button';

vi.mock('react-native', () => ({ Pressable: 'Pressable' }));

/** The props expo-router's BottomTabItem passes, including Android's role `tab`. */
const TAB_ITEM_PROPS: Omit<TabBarButtonProps, 'children'> = {
  'aria-label': 'Home, tab, 1 of 3',
  'aria-selected': true,
  android_ripple: { borderless: true },
  href: '/(app)/(tabs)/(0_home)',
  onPress: () => undefined,
  pressOpacity: 1,
  role: 'tab',
  testID: 'tab-home',
};

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function renderButton(itemProps: Omit<TabBarButtonProps, 'children'> = TAB_ITEM_PROPS) {
  act(() => {
    const element = createElement(TabBarButton, itemProps, null);
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing TabBarButton renderer');
  }
  return renderer.root.findByType('Pressable');
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('TabBarButton', () => {
  // React Native maps role `tab` to `android.view.View` and role `button` to
  // `android.widget.Button`, so the override is what makes the OS and a screen
  // reader see the tab as a control instead of a bare view. expo-router hands
  // in `tab` on Android and `button` on iOS; the same component reports the
  // same control role for both.
  it.each(['tab', 'button'] as const)(
    'reports a button when expo-router passes the role %s',
    incomingRole => {
      expect(renderButton({ ...TAB_ITEM_PROPS, role: incomingRole }).props.role).toBe('button');
    }
  );

  it('keeps the tab label, selected state, ripple and test id', () => {
    const button = renderButton();
    expect(button.props['aria-label']).toBe('Home, tab, 1 of 3');
    expect(button.props['aria-selected']).toBe(true);
    expect(button.props.android_ripple).toEqual({ borderless: true });
    expect(button.props.testID).toBe('tab-home');
  });

  it('drops only the props a native Pressable does not understand', () => {
    const button = renderButton();
    expect(button.props.href).toBeUndefined();
    expect(button.props.pressOpacity).toBeUndefined();
  });
});
