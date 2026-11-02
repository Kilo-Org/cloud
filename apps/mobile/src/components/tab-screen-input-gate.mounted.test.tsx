/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native layout regression tests. */
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetTabSwitchInputForTests, markTabSwitchPending } from '@/lib/tab-switch-input-gate';

import { TabSwitchInputSettle } from './tab-screen-input-gate';

vi.mock('react-native', () => ({ View: 'View' }));

type SettleProps = {
  onStartShouldSetResponderCapture: () => boolean;
  onResponderTerminationRequest: () => boolean;
};

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
let focused = true;

function renderSettle(): SettleProps {
  act(() => {
    const element = createElement(TabSwitchInputSettle, {
      navigation: { isFocused: () => focused },
    });
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing renderer');
  }
  return renderer.root.findByType('View' as unknown as React.ElementType).props as SettleProps;
}

beforeEach(() => {
  __resetTabSwitchInputForTests();
  focused = true;
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('TabSwitchInputSettle mounted layout', () => {
  it('lets a touch through when no tab press is settling', () => {
    focused = false;
    const settle = renderSettle();

    expect(settle.onStartShouldSetResponderCapture()).toBe(false);
  });

  it('lets the destination scene act while a tab switch is still settling', () => {
    const settle = renderSettle();

    markTabSwitchPending();

    expect(settle.onStartShouldSetResponderCapture()).toBe(false);
  });

  it('keeps a touch from the scene being left while a tab switch is settling', () => {
    focused = false;
    const settle = renderSettle();

    markTabSwitchPending();

    expect(settle.onStartShouldSetResponderCapture()).toBe(true);
  });

  it('keeps a touch on the focused scene for a press on the tab it shows', () => {
    const settle = renderSettle();

    markTabSwitchPending(Date.now(), { sameTab: true });

    expect(settle.onStartShouldSetResponderCapture()).toBe(true);
  });

  it('does not hand a kept touch to the tab screen', () => {
    focused = false;
    const settle = renderSettle();
    markTabSwitchPending();

    expect(settle.onResponderTerminationRequest()).toBe(false);
  });
});
