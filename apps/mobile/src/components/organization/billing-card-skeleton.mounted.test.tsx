/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native layout regression tests. */
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { BillingCardSkeleton } from './billing-card-skeleton';

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@/components/ui/row-group', () => ({ RowGroup: 'RowGroup' }));
vi.mock('@/components/ui/row-skeleton', () => ({ RowSkeleton: 'RowSkeleton' }));

function renderSkeleton(rows: number | undefined): TestRenderer.ReactTestInstance {
  let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
  act(() => {
    renderer = TestRenderer.create(
      rows === undefined
        ? createElement(BillingCardSkeleton)
        : createElement(BillingCardSkeleton, { rows })
    );
  });
  if (!renderer) {
    throw new Error('Missing BillingCardSkeleton renderer');
  }
  return renderer.root;
}

describe('BillingCardSkeleton', () => {
  // The placeholder must reserve the rows the loaded card paints: a card that
  // grows when its read answers moves every section under it, which is what the
  // held-loading gate run measured as a 48.4 dp layout shift on the billing
  // screen. Auto top-up paints three rows, so its placeholder reserves three.
  it('reserves three rows for a three-row readout', () => {
    const root = renderSkeleton(3);

    expect(root.findAllByType('RowSkeleton' as never)).toHaveLength(3);
  });

  it('reserves two rows by default', () => {
    const root = renderSkeleton(undefined);

    expect(root.findAllByType('RowSkeleton' as never)).toHaveLength(2);
  });

  it('reserves one row for the Kilo Pass readout', () => {
    const root = renderSkeleton(1);

    expect(root.findAllByType('RowSkeleton' as never)).toHaveLength(1);
  });
});
