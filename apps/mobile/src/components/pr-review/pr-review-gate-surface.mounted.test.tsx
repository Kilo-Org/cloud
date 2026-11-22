// Mounted coverage for the PR-review gate surface. The behaviour under test is
// what keeps a presented comment sheet alive: an arm must not replace the Stack
// below while one of the stack's sheets is presented, and before the subtree
// has ever mounted the arm must still be the only thing on screen.

import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act, type ReactTestRenderer, TestRenderer } from '@/test/renderer';

import { PrReviewGateSurface } from './pr-review-gate-surface';

vi.mock('react-native', () => ({ View: 'View' }));

const BASE_SEGMENTS = ['(app)', 'pr-review', 'gitlab', 'acme', 'sample', '7'] as const;
const SHEET_SEGMENTS = [...BASE_SEGMENTS, 'conversation-comment'] as const;

function Arm({ name }: { name: string }) {
  return createElement('arm-mark', { name });
}

function ReviewStack() {
  return createElement('review-stack');
}

let mounted: ReactTestRenderer | undefined = undefined;

function update(arm: string | null, segments: readonly string[]): void {
  const tree = (
    <PrReviewGateSurface arm={arm === null ? null : <Arm name={arm} />} segments={segments}>
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

beforeEach(() => {
  mounted = undefined;
});

describe('PrReviewGateSurface', () => {
  it('draws only the arm before the review subtree has mounted', () => {
    update('loading', BASE_SEGMENTS);
    const root = mounted?.root;
    expect(root?.findAllByType(ReviewStack)).toHaveLength(0);
    expect(root?.findByType('arm-mark').props.name).toBe('loading');
  });

  it('draws only the arm on entry even when the link names a sheet route', () => {
    // A deep link straight to a sheet still gets the gate: a disconnected
    // reader must never mount the authenticated review queries.
    update('loading', SHEET_SEGMENTS);
    const root = mounted?.root;
    expect(root?.findAllByType(ReviewStack)).toHaveLength(0);
    expect(root?.findByType('arm-mark').props.name).toBe('loading');
  });

  it('keeps the subtree mounted when a later arm arrives over its overview', () => {
    update(null, BASE_SEGMENTS);
    expect(mounted?.root.findAllByType(ReviewStack)).toHaveLength(1);

    update('connect', BASE_SEGMENTS);
    expect(mounted?.root.findAllByType(ReviewStack)).toHaveLength(0);
    expect(mounted?.root.findByType('arm-mark').props.name).toBe('connect');
  });

  it('holds the arm back while one of the stack sheets is presented', () => {
    // The presented sheet is a scene of the Stack below, so replacing the
    // subtree would tear its content down and leave an empty dimmed panel.
    update(null, BASE_SEGMENTS);
    update(null, SHEET_SEGMENTS);
    update('connect', SHEET_SEGMENTS);

    expect(mounted?.root.findAllByType(ReviewStack)).toHaveLength(1);
    expect(mounted?.root.findAllByType('arm-mark')).toHaveLength(0);
  });

  it('draws the held arm once the sheet is dismissed', () => {
    update(null, SHEET_SEGMENTS);
    update('connect', SHEET_SEGMENTS);
    update('connect', BASE_SEGMENTS);
    expect(mounted?.root.findAllByType(ReviewStack)).toHaveLength(0);
    expect(mounted?.root.findByType('arm-mark').props.name).toBe('connect');
  });

  it('returns to the bare subtree when the gate reaches its connected arm again', () => {
    update(null, BASE_SEGMENTS);
    update('loading', BASE_SEGMENTS);
    update(null, BASE_SEGMENTS);
    expect(mounted?.root.findAllByType(ReviewStack)).toHaveLength(1);
    expect(mounted?.root.findAllByType('arm-mark')).toHaveLength(0);
  });
});
