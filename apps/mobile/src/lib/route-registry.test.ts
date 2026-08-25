/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/components/agents/model-selector.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { type ModelPickerBridge } from './picker-bridge';
import { modelPickerSlot, useRouteRegistry } from './route-registry';

function makeBridge(sessionId: string): ModelPickerBridge {
  return {
    options: [],
    currentValue: '',
    currentVariant: '',
    selectionScope: {
      sessionId,
      ownerConnectionId: null,
      protocol: 'unknown',
      catalogGenerationIdentity: null,
    },
    isSelectionCurrent: () => true,
    onSelect: vi.fn<() => void>(),
  };
}

function RouteRegistrar({ routeKey }: Readonly<{ routeKey: string }>) {
  useRouteRegistry(routeKey);
  return null;
}

function mountRegistrar(routeKey: string): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  TestRenderer.act(() => {
    ref.current = TestRenderer.create(createElement(RouteRegistrar, { routeKey }));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

describe('route registry', () => {
  it('keeps two route keys from sharing a picker slot', () => {
    const bridgeA = makeBridge('session-a');
    const bridgeB = makeBridge('session-b');

    modelPickerSlot.set('session-a', bridgeA);
    modelPickerSlot.set('session-b', bridgeB);

    expect(modelPickerSlot.get('session-a')).toBe(bridgeA);
    expect(modelPickerSlot.get('session-b')).toBe(bridgeB);
    expect(modelPickerSlot.get('session-a')).not.toBe(modelPickerSlot.get('session-b'));
  });

  it('clears the slot when the route unmounts', () => {
    const bridge = makeBridge('session-a');
    const renderer = mountRegistrar('session-a');
    modelPickerSlot.set('session-a', bridge);

    expect(modelPickerSlot.get('session-a')).toBe(bridge);

    TestRenderer.act(() => {
      renderer.unmount();
    });

    expect(modelPickerSlot.get('session-a')).toBeUndefined();
  });
});
