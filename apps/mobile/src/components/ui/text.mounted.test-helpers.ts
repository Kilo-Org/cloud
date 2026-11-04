import { type ReactElement } from 'react';

import { act, TestRenderer } from '@/test/renderer';

/**
 * The mounted harness the `Text` suites share. Each suite keeps its own
 * `vi.mock` setup and assertions; this file only owns the renderer's lifecycle
 * and reaching the host `Text` the primitive renders.
 *
 * One tree is live at a time, and mounting another unmounts it first: a suite
 * that mounts in a second case (or in a second `describe`) would otherwise leave
 * the earlier tree's effects and subscriptions running beside the new one, and
 * two duplicated copies of this file had already drifted into doing exactly
 * that. Suites call `unmountTextTree` from `afterEach`.
 */
let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

/** Mounts `element`, after unmounting whatever the harness held before, and returns its root. */
export function mountTextTree(element: ReactElement): TestRenderer.ReactTestInstance {
  act(() => {
    renderer?.unmount();
    renderer = TestRenderer.create(element);
  });
  if (!renderer) {
    throw new Error('Missing Text renderer');
  }
  return renderer.root;
}

/** The host `Text` the primitive renders, whose props and style the platform draws. */
export function hostText(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance {
  return root.find(node => Object.is(node.type, 'Text'));
}

/** Drops the live tree, if any. */
export function unmountTextTree(): void {
  act(() => renderer?.unmount());
  renderer = undefined;
}
