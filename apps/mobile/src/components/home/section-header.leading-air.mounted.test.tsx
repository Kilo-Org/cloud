import { createElement, type ReactElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { SectionHeader } from './section-header';

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
}));
vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));

/** The row's own class list, mounted and unmounted again. */
function rowClasses(element: ReactElement) {
  const mounted: { renderer?: TestRenderer.ReactTestRenderer } = {};
  act(() => {
    mounted.renderer = TestRenderer.create(element);
  });
  const renderer = mounted.renderer;
  if (!renderer) {
    throw new Error('Missing SectionHeader renderer');
  }
  const classes = String(
    renderer.root.find(node => Object.is(node.type, 'View')).props.className
  ).split(' ');
  act(() => {
    renderer.unmount();
  });
  return classes;
}

describe('SectionHeader leading air', () => {
  // Field defect (Home): a row with an action is as tall as that action's 48 dp
  // frame while an action-less row is one label line tall, so a single `pt-2`
  // held the first section's label ~44 dp below the Home header row and every
  // later label ~14 dp below its block. The frame already holds the label ~34 dp
  // below the row's top edge, so the action row keeps no leading padding and the
  // action-less row pads the same air minus the sections column's 7 dp gap
  // (home-header-section-gap).
  it('lets the frame hold the label, and pads the same air without one', () => {
    expect(
      rowClasses(
        createElement(SectionHeader, {
          label: 'Live now',
          actionLabel: 'See all',
          onActionPress: () => undefined,
        })
      )
    ).toContain('pt-0');
    const plain = rowClasses(createElement(SectionHeader, { label: 'Explore' }));
    expect(plain).toContain('pt-[27px]');
    expect(plain).not.toContain('pt-0');
  });
});
