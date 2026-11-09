import { createElement, type ReactElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import {
  SECTION_ACTION_FRAME_DP,
  SECTION_ACTION_HIT_SLOP_DP,
  SECTION_HEADER_ROW_PADDING_CLASS,
  tapTargetReachDp,
  textActionTargetClass,
  TOUCH_TARGET_DP,
} from '@/lib/a11y/tap-target';
import { SectionHeader } from './section-header';

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
}));
vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));

/** The row's, label box's and action's props, mounted and unmounted again. */
function mountHeader(element: ReactElement) {
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
  const action = renderer.root.findAll(node => Object.is(node.type, 'Pressable'))[0];
  const actionProps = action
    ? {
        classes: String(action.props.className).split(' '),
        hitSlop: action.props.hitSlop as { top: number; bottom: number } | undefined,
      }
    : undefined;
  act(() => {
    renderer.unmount();
  });
  return {
    row: classes[0] ?? [],
    labelBox: classes[1],
    labelBoxes: classes.length - 1,
    action: actionProps,
  };
}

const FRAME_CLASS = `min-h-[${String(SECTION_ACTION_FRAME_DP)}px]`;

describe('SectionHeader leading air', () => {
  // Field defect (Home): the Live now header's 48 dp See all frame held its
  // label about twice as far below the brand row as every other Home label sat
  // below its block. With `reserveLabelAir`, a row with an action and a row
  // without one now have the same height (home-header-section-gap).
  it('gives a Home header the same height with or without an action', () => {
    const plain = mountHeader(
      createElement(SectionHeader, { label: 'Explore', reserveLabelAir: true })
    );
    const withAction = mountHeader(
      createElement(SectionHeader, {
        label: 'Live now',
        actionLabel: 'See all',
        onActionPress: () => undefined,
        reserveLabelAir: true,
      })
    );

    expect(plain.labelBox).toContain(FRAME_CLASS);
    expect(withAction.labelBox).toContain(FRAME_CLASS);
    expect(withAction.action?.classes).toContain(FRAME_CLASS);
    expect(withAction.row).toEqual(plain.row);
  });

  it('keeps the compact action reach at the touch target and inside the row', () => {
    const header = mountHeader(
      createElement(SectionHeader, {
        label: 'Live now',
        actionLabel: 'See all',
        onActionPress: () => undefined,
        reserveLabelAir: true,
      })
    );

    expect(header.action?.hitSlop).toEqual({
      top: SECTION_ACTION_HIT_SLOP_DP,
      bottom: SECTION_ACTION_HIT_SLOP_DP,
    });
    expect(
      tapTargetReachDp(SECTION_ACTION_FRAME_DP, SECTION_ACTION_HIT_SLOP_DP)
    ).toBeGreaterThanOrEqual(TOUCH_TARGET_DP);
    // RN drops touches outside the parent row, so the slop must fit its padding.
    expect(header.row).toContain(SECTION_HEADER_ROW_PADDING_CLASS);
    expect(SECTION_HEADER_ROW_PADDING_CLASS).toBe(`py-[${String(SECTION_ACTION_HIT_SLOP_DP)}px]`);
  });

  it('leaves a header that does not reserve the air on the full action frame', () => {
    const plain = mountHeader(createElement(SectionHeader, { label: 'Sessions' }));
    // No label box: the label stays the row's own child.
    expect(plain.labelBoxes).toBe(0);

    const withAction = mountHeader(
      createElement(SectionHeader, {
        label: 'Notes',
        actionLabel: 'Edit',
        onActionPress: () => undefined,
      })
    );
    expect(withAction.action?.classes).toEqual(
      expect.arrayContaining(textActionTargetClass().split(' '))
    );
    expect(withAction.action?.hitSlop).toBeUndefined();
  });
});
