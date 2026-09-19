import { type BottomTabBarButtonProps } from 'expo-router/js-tabs';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { TabBarButton } from './tab-bar-button';

vi.mock('react-native', () => ({ Pressable: 'Pressable' }));

/** The props expo-router's BottomTabItem passes, including Android's role `tab`. */
const TAB_ITEM_PROPS: Omit<BottomTabBarButtonProps, 'children'> = {
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

function renderButton() {
  act(() => {
    const element = createElement(TabBarButton, TAB_ITEM_PROPS, null);
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
  // reader see the tab as a control instead of a bare view.
  it('reports the tab as a button so the OS gives the control a role', () => {
    expect(renderButton().props.role).toBe('button');
  });

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
