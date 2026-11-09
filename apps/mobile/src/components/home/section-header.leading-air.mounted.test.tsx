import { createElement, type ReactElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { SectionHeader } from './section-header';

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
}));
vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));

/** The row's class list and its label box's, mounted and unmounted again. */
function row(element: ReactElement) {
  const mounted: { renderer?: TestRenderer.ReactTestRenderer } = {};
  act(() => {
    mounted.renderer = TestRenderer.create(element);
  });
  const renderer = mounted.renderer;
  if (!renderer) {
    throw new Error('Missing SectionHeader renderer');
  }
  const views = renderer.root.findAll(node => Object.is(node.type, 'View'));
  const classes = views.map(node => String(node.props.className).split(' '));
  act(() => {
    renderer.unmount();
  });
  return { row: classes[0] ?? [], labelBox: classes[1], labelBoxes: classes.length - 1 };
}

describe('SectionHeader leading air', () => {
  // Field defect (Home): an action-less row is one label line tall, so the label
  // sat directly under the block above it. Reserving a short fixed box above the
  // label keeps a gap between Home sections without the full action frame's air
  // (home-header-section-gap).
  it('reserves a short fixed box above a label whose row has no action', () => {
    const plain = row(createElement(SectionHeader, { label: 'Explore', reserveLabelAir: true }));
    expect(plain.row).toContain('pt-0');
    expect(plain.labelBox).toContain('min-h-[28px]');

    const withAction = row(
      createElement(SectionHeader, {
        label: 'Live now',
        actionLabel: 'See all',
        onActionPress: () => undefined,
        reserveLabelAir: true,
      })
    );
    expect(withAction.row).toContain('pt-0');
  });

  it('leaves a header that does not reserve the air on the shared padding', () => {
    const plain = row(createElement(SectionHeader, { label: 'Sessions' }));
    expect(plain.row).toContain('pt-2');
    // No label box: the label stays the row's own child, so every other screen
    // keeps the geometry it shipped with.
    expect(plain.labelBoxes).toBe(0);
  });
});
