/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native layout regression tests. */
import { createElement } from 'react';
import { type BottomTabBarButtonProps } from 'expo-router/js-tabs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { TabBarButton } from './tab-bar-button';

vi.mock('react-native', () => ({
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
});
