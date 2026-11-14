import { createElement } from 'react';
import { TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { type DiffSelection } from './pr-review/diff-selection-bridge';
import { type ModelPickerBridge, type ModePickerBridge } from './picker-bridge';
import {
  modelPickerSlot,
  modePickerSlot,
  prDiffSelectionSlot,
  useRouteRegistry,
} from './route-registry';

function makeBridge(sessionId: string): ModelPickerBridge {
  return {
    options: [],
    currentValue: '',
    currentVariant: '',
    acceptsVariant: true,
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

function makeModeBridge(): ModePickerBridge {
  return { currentValue: 'code', onSelect: vi.fn<() => void>() };
}

function makeDiffSelection(): DiffSelection {
  return {
    owner: 'acme',
    repo: 'widgets',
    number: 7,
    path: 'src/index.ts',
    side: 'RIGHT',
    line: 12,
    selectedText: 'export const x = 1;',
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

  it('clears every slot kind when the route unmounts', () => {
    const modelBridge = makeBridge('session-b');
    const modeBridge = makeModeBridge();
    const selection = makeDiffSelection();
    const renderer = mountRegistrar('session-b');
    modelPickerSlot.set('session-b', modelBridge);
    modePickerSlot.set('session-b', modeBridge);
    prDiffSelectionSlot.set('session-b', selection);

    TestRenderer.act(() => {
      renderer.unmount();
    });

    expect(modelPickerSlot.get('session-b')).toBeUndefined();
    expect(modePickerSlot.get('session-b')).toBeUndefined();
    expect(prDiffSelectionSlot.get('session-b')).toBeUndefined();
  });

  it('clears only the unmounted route key and keeps the other key intact', () => {
    const bridgeA = makeBridge('session-a');
    const bridgeB = makeBridge('session-b');
    const selectionA = makeDiffSelection();
    const selectionB = { ...makeDiffSelection(), number: 8 };
    const rendererA = mountRegistrar('session-a');
    const rendererB = mountRegistrar('session-b');
    modelPickerSlot.set('session-a', bridgeA);
    modelPickerSlot.set('session-b', bridgeB);
    prDiffSelectionSlot.set('session-a', selectionA);
    prDiffSelectionSlot.set('session-b', selectionB);

    TestRenderer.act(() => {
      rendererA.unmount();
    });

    expect(modelPickerSlot.get('session-a')).toBeUndefined();
    expect(prDiffSelectionSlot.get('session-a')).toBeUndefined();
    expect(modelPickerSlot.get('session-b')).toBe(bridgeB);
    expect(prDiffSelectionSlot.get('session-b')).toBe(selectionB);

    TestRenderer.act(() => {
      rendererB.unmount();
    });

    expect(modelPickerSlot.get('session-b')).toBeUndefined();
    expect(prDiffSelectionSlot.get('session-b')).toBeUndefined();
  });
});
