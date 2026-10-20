/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native layout regression tests. */
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetTabSwitchInputForTests,
  isTabSwitchPending,
  markTabSwitchPending,
} from '@/lib/tab-switch-input-gate';

import { TabSwitchInputGate, TabSwitchInputSettle } from './tab-screen-input-gate';

const focus = vi.hoisted(() => ({ active: true }));

vi.mock('expo-router', () => ({
  useFocusEffect: (callback: () => void | (() => void)) => {
    if (focus.active) {
      callback();
    }
  },
}));
vi.mock('react-native', () => ({ View: 'View' }));

type GateProps = {
  onStartShouldSetResponderCapture: () => boolean;
  onResponderTerminationRequest: () => boolean;
};

type SettleProps = { onLayout: () => void };

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function render(element: React.ReactElement) {
  act(() => {
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing renderer');
  }
  return renderer;
}

function renderGate(): GateProps {
  const root = render(createElement(TabSwitchInputGate));
  return root.root.findByType('View' as unknown as React.ElementType).props as GateProps;
}

function renderSettle(): SettleProps {
  const root = render(createElement(TabSwitchInputSettle));
  return root.root.findByType('View' as unknown as React.ElementType).props as SettleProps;
}

beforeEach(() => {
  __resetTabSwitchInputForTests();
  focus.active = true;
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('TabSwitchInputGate mounted layout', () => {
  it('lets a touch through when no tab press is settling', () => {
    const gate = renderGate();

    expect(gate.onStartShouldSetResponderCapture()).toBe(false);
  });

  it('keeps a touch that starts while the pressed tab is still settling', () => {
    const gate = renderGate();

    markTabSwitchPending();

    expect(gate.onStartShouldSetResponderCapture()).toBe(true);
  });

  it('does not hand a kept touch to the tab screens', () => {
    const gate = renderGate();

    expect(gate.onResponderTerminationRequest()).toBe(false);
  });
});

describe('TabSwitchInputSettle mounted layout', () => {
  it('closes the window when the focused tab is on screen', () => {
    markTabSwitchPending();
    const settle = renderSettle();
    expect(isTabSwitchPending()).toBe(true);

    act(() => {
      settle.onLayout();
    });

    expect(isTabSwitchPending()).toBe(false);
  });

  it('keeps the window open when the tab that lays out is not the focused one', () => {
    focus.active = false;
    markTabSwitchPending();
    const settle = renderSettle();

    act(() => {
      settle.onLayout();
    });

    expect(isTabSwitchPending()).toBe(true);
  });
});
