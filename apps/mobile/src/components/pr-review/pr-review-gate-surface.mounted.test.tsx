// Mounted coverage for the keeper that holds the PR-review subtree while a gate
// arm draws above it. The subtree carries the route's Stack, and a comment
// sheet is a scene of that Stack, so replacing it would tear a presented sheet
// down. Before the subtree has ever mounted the arm must still be the only
// thing on screen, and while an arm is up the covered scene must leave touch and
// the accessibility tree.

import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act, type ReactTestRenderer, TestRenderer } from '@/test/renderer';

type MountedRenderer = ReactTestRenderer;

import { PrReviewGateSurface } from './pr-review-gate-surface';

vi.mock('react-native', () => ({ View: 'View' }));

function Arm({ name }: { name: string }) {
  return createElement('arm-mark', { name });
}

function ReviewStack() {
  return createElement('review-stack');
}

let mounted: MountedRenderer | undefined = undefined;

function update(arm: string | null): void {
  const tree = (
    <PrReviewGateSurface arm={arm === null ? null : <Arm name={arm} />}>
      <ReviewStack />
    </PrReviewGateSurface>
  );
  act(() => {
    if (mounted === undefined) {
      mounted = TestRenderer.create(tree);
      return;
    }
    mounted.update(tree);
  });
}

/** The wrapper that holds the covered subtree, found by its a11y-hiding view. */
function coveredScene() {
  const scene = mounted?.root
    .findAllByType('View')
    .find(view => view.props.collapsable === false);
  if (!scene) {
    throw new Error('missing the covered scene wrapper');
  }
  return scene;
}

function overlay() {
  return mounted?.root
    .findAllByType('View')
    .find(view => view.props.className === 'absolute inset-0');
}

beforeEach(() => {
  mounted = undefined;
});

describe('PrReviewGateSurface', () => {
  it('draws only the arm before the review subtree has mounted', () => {
    update('loading');
    const root = mounted?.root;
    expect(root?.findAllByType(ReviewStack)).toHaveLength(0);
    expect(root?.findByType('arm-mark').props.name).toBe('loading');
    // The arm replaces the subtree on entry, so it carries no overlay frame.
    expect(root?.findAllByType('View')).toHaveLength(0);
  });

  it('keeps the subtree mounted when a later arm arrives and draws the arm above it', () => {
    update(null);
    expect(mounted?.root.findAllByType(ReviewStack)).toHaveLength(1);

    update('connect');
    expect(mounted?.root.findAllByType(ReviewStack)).toHaveLength(1);
    expect(mounted?.root.findByType('arm-mark').props.name).toBe('connect');
    expect(overlay()?.findByType('arm-mark').props.name).toBe('connect');
  });

  it('takes the covered scene out of touch and the accessibility tree', () => {
    update(null);
    update('connect');
    const scene = coveredScene();
    expect(scene.props.pointerEvents).toBe('none');
    expect(scene.props.accessibilityElementsHidden).toBe(true);
    expect(scene.props.importantForAccessibility).toBe('no-hide-descendants');
    // The sheet's own native window is outside this tree, so nothing here can
    // reach it; only the covered scene is hidden.
    expect(scene.findAllByType('review-stack')).toHaveLength(1);
  });

  it('gives the covered scene back when the gate reaches its connected arm', () => {
    update(null);
    update('connect');
    update(null);
    const scene = coveredScene();
    expect(scene.props.pointerEvents).toBe('auto');
    expect(scene.props.accessibilityElementsHidden).toBe(false);
    expect(scene.props.importantForAccessibility).toBe('auto');
    expect(mounted?.root.findAllByType('arm-mark')).toHaveLength(0);
  });

  it('returns to the bare subtree when the gate reaches its connected arm again', () => {
    update(null);
    update('loading');
    update(null);
    expect(mounted?.root.findAllByType(ReviewStack)).toHaveLength(1);
    expect(mounted?.root.findAllByType('arm-mark')).toHaveLength(0);
  });
});
