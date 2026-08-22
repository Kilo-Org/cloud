/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/components/agents/child-session-sheet.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type KiloSessionId } from '@kilocode/cloud-agent-sdk';

import {
  type ChildSessionSheetMountState,
  closeChildSessionSheet,
  openChildSessionSheet,
  releaseChildSessionSheet,
} from './child-session-sheet-state';
import { ChildSessionDismissLayer } from './child-session-dismiss-layer';

const reactNativeMock = vi.hoisted(() => ({
  Platform: { OS: 'ios' as string },
}));

vi.mock('react-native', () => ({
  View: 'View',
  Platform: reactNativeMock.Platform,
}));

const emptyMount: ChildSessionSheetMountState = { sheet: null, visible: false };
const childA = { sessionId: 'child-a' as KiloSessionId, title: 'Subagent A' };
const childB = { sessionId: 'child-b' as KiloSessionId, title: 'Subagent B' };

// Wrap in a host View so the tree always has a non-null root: a null-returning
// root makes react-test-renderer report the renderer as unmounted.
function LayerHarness({ state }: Readonly<{ state: ChildSessionSheetMountState }>) {
  return createElement('View', null, createElement(ChildSessionDismissLayer, { state }));
}

async function renderLayer(state: ChildSessionSheetMountState) {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(createElement(LayerHarness, { state }));
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function findByTestID(
  root: TestRenderer.ReactTestInstance,
  testID: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => node.props.testID === testID);
}

beforeEach(() => {
  reactNativeMock.Platform.OS = 'ios';
});

describe('ChildSessionDismissLayer mounted', () => {
  it('renders the bg-background layer on Android while a closed sheet is held', async () => {
    reactNativeMock.Platform.OS = 'android';
    const closed = closeChildSessionSheet(openChildSessionSheet(emptyMount, childA));

    const renderer = await renderLayer(closed);
    const layers = findByTestID(renderer.root, 'child-session-sheet-dismiss-layer');

    expect(layers).toHaveLength(1);
    expect(layers[0]?.type).toBe('View');
    expect(layers[0]?.props.className).toContain('bg-background');
  });

  it('unmounts the layer on Android after the delayed release', async () => {
    reactNativeMock.Platform.OS = 'android';
    const closed = closeChildSessionSheet(openChildSessionSheet(emptyMount, childA));
    const released = releaseChildSessionSheet(closed);

    const renderer = await renderLayer(released);

    expect(findByTestID(renderer.root, 'child-session-sheet-dismiss-layer')).toHaveLength(0);
  });

  it('unmounts the layer on Android when a reopen lands before release', async () => {
    reactNativeMock.Platform.OS = 'android';
    const closed = closeChildSessionSheet(openChildSessionSheet(emptyMount, childA));
    const reopened = openChildSessionSheet(closed, childB);

    const renderer = await renderLayer(reopened);

    expect(findByTestID(renderer.root, 'child-session-sheet-dismiss-layer')).toHaveLength(0);
  });

  it('never renders the layer on iOS while a closed sheet is held', async () => {
    const closed = closeChildSessionSheet(openChildSessionSheet(emptyMount, childA));

    const renderer = await renderLayer(closed);

    expect(findByTestID(renderer.root, 'child-session-sheet-dismiss-layer')).toHaveLength(0);
  });

  it('never renders the layer on iOS while the sheet is visible', async () => {
    const open = openChildSessionSheet(emptyMount, childA);

    const renderer = await renderLayer(open);

    expect(findByTestID(renderer.root, 'child-session-sheet-dismiss-layer')).toHaveLength(0);
  });
});
