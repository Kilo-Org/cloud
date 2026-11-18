/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native layout regression tests. */
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetSessionListTouchGateForTests,
  holdSessionListTouch,
} from '@/lib/session-list-touch-gate';

import { SessionListTouchGate } from './session-list-touch-gate';

vi.mock('react-native', () => ({ View: 'View' }));

type GateProps = {
  onStartShouldSetResponderCapture: () => boolean;
  onResponderTerminationRequest: () => boolean;
};

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function renderGate(): GateProps {
  act(() => {
    const element = createElement(SessionListTouchGate, null, createElement('Text', null, 'rows'));
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing renderer');
  }
  return renderer.root.findByType('View' as unknown as React.ElementType).props as GateProps;
}

beforeEach(() => {
  __resetSessionListTouchGateForTests();
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  __resetSessionListTouchGateForTests();
});

describe('SessionListTouchGate mounted layout', () => {
  it('lets a touch reach the rows while no clear action is settling', () => {
    const gate = renderGate();

    expect(gate.onStartShouldSetResponderCapture()).toBe(false);
  });

  it('claims a touch that arrives right after a clear action', () => {
    const gate = renderGate();

    holdSessionListTouch();

    expect(gate.onStartShouldSetResponderCapture()).toBe(true);
  });

  it('reads the hold when the touch arrives, not when it rendered', () => {
    const gate = renderGate();
    expect(gate.onStartShouldSetResponderCapture()).toBe(false);

    holdSessionListTouch();

    expect(gate.onStartShouldSetResponderCapture()).toBe(true);
  });

  it('does not hand a claimed touch to the rows', () => {
    const gate = renderGate();
    holdSessionListTouch();

    expect(gate.onResponderTerminationRequest()).toBe(false);
  });
});
