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

type SceneNavigation = {
  addListener: (event: string, listener: () => void) => () => void;
  emit: (event: string) => void;
  listeners: () => number;
};

/** The scene navigation the gate subscribes to, with the events a test fires. */
function sceneNavigation(): SceneNavigation {
  const byEvent = new Map<string, Set<() => void>>();
  return {
    addListener: (event, listener) => {
      const forEvent = byEvent.get(event) ?? new Set();
      forEvent.add(listener);
      byEvent.set(event, forEvent);
      return () => {
        forEvent.delete(listener);
      };
    },
    emit: event => {
      for (const listener of byEvent.get(event) ?? []) {
        listener();
      }
    },
    listeners: () => [...byEvent.values()].reduce((total, set) => total + set.size, 0),
  };
}

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
let navigation = sceneNavigation();

function renderSettle(): SettleProps {
  act(() => {
    const element = createElement(TabSwitchInputSettle, { navigation });
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
  navigation = sceneNavigation();
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('TabSwitchInputSettle mounted layout', () => {
  it('lets a touch through when no tab press is settling', () => {
    const settle = renderSettle();

    expect(settle.onStartShouldSetResponderCapture()).toBe(false);
  });

  it('keeps a touch that starts while the pressed tab is still settling', () => {
    const settle = renderSettle();

    markTabSwitchPending();

    expect(settle.onStartShouldSetResponderCapture()).toBe(true);
  });

  it('does not hand a kept touch to the tab screen', () => {
    const settle = renderSettle();

    expect(settle.onResponderTerminationRequest()).toBe(false);
  });

  it('lets touches through once the destination scene reports focus', () => {
    const settle = renderSettle();
    markTabSwitchPending();
    expect(settle.onStartShouldSetResponderCapture()).toBe(true);

    act(() => {
      navigation.emit('focus');
    });

    expect(settle.onStartShouldSetResponderCapture()).toBe(false);
  });

  it('keeps the window while only a blur arrives', () => {
    const settle = renderSettle();
    markTabSwitchPending();

    act(() => {
      navigation.emit('blur');
    });

    expect(settle.onStartShouldSetResponderCapture()).toBe(true);
  });

  it('drops the focus subscription when the scene unmounts', () => {
    renderSettle();
    expect(navigation.listeners()).toBe(1);

    act(() => renderer?.unmount());
    renderer = undefined;

    expect(navigation.listeners()).toBe(0);
  });
});
