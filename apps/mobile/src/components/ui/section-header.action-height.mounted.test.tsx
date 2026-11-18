import { createElement, type ReactElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import {
  MIN_TAP_TARGET_DP,
  SECTION_ACTION_BOX_CLASS,
  SECTION_ACTION_FRAME_DP,
  SECTION_ACTION_HIT_SLOP_DP,
  tapTargetReachDp,
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

/** The eyebrow's line, in dp: the band a section action cancels itself down to. */
const LABEL_LINE_DP = 12;

/** The row's and the action's props, mounted and unmounted again. */
function mountHeader(element: ReactElement) {
  const mounted: { renderer?: TestRenderer.ReactTestRenderer } = {};
  act(() => {
    mounted.renderer = TestRenderer.create(element);
  });
  const renderer = mounted.renderer;
  if (!renderer) {
    throw new Error('Missing SectionHeader renderer');
  }
  const classes = renderer.root
    .findAll(node => Object.is(node.type, 'View'))
    .map(node => String(node.props.className).split(' '));
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
  return { row: classes[0] ?? [], labelBoxes: classes.length - 1, action: actionProps };
}

describe('SectionHeader action height', () => {
  // Field defect (Home): the Live now header's 48 dp See all frame held its
  // label about twice as far below the brand row as every other Home label sat
  // below its block (home-header-section-gap). The action now holds the label's
  // own line, so its header has exactly the plain header's row, padding and
  // label position, and every section keeps one gap to the block above it.
  it("gives a header with an action the plain header's row", () => {
    const plain = mountHeader(createElement(SectionHeader, { label: 'Explore' }));
    const withAction = mountHeader(
      createElement(SectionHeader, {
        label: 'Live now',
        actionLabel: 'See all',
        onActionPress: () => undefined,
      })
    );

    expect(withAction.row).toEqual(plain.row);
    expect(plain.row).toEqual(expect.arrayContaining(['py-2', 'items-end', 'gap-2', 'flex-wrap']));
    // One vertical padding for both, and no box of the action's own: nothing can
    // hold the label further from the content it names.
    expect(plain.row.filter(name => name.startsWith('py-'))).toEqual(['py-2']);
    expect(plain.labelBoxes).toBe(0);
    expect(withAction.labelBoxes).toBe(0);
  });

  it('cancels the action box down to the label line and keeps its reach', () => {
    const header = mountHeader(
      createElement(SectionHeader, {
        label: 'Live now',
        actionLabel: 'See all',
        onActionPress: () => undefined,
      })
    );

    for (const token of SECTION_ACTION_BOX_CLASS.split(' ')) {
      expect(header.action?.classes).toContain(token);
    }
    // The box cancels `(frame - line) / 2` a side, so it lays out as the label
    // line and the row is never taller for it.
    expect(SECTION_ACTION_BOX_CLASS).toContain(
      `-my-[${String((SECTION_ACTION_FRAME_DP - LABEL_LINE_DP) / 2)}px]`
    );
    expect(header.action?.hitSlop).toEqual({
      top: SECTION_ACTION_HIT_SLOP_DP,
      bottom: SECTION_ACTION_HIT_SLOP_DP,
    });
    expect(
      tapTargetReachDp(SECTION_ACTION_FRAME_DP, SECTION_ACTION_HIT_SLOP_DP)
    ).toBeGreaterThanOrEqual(TOUCH_TARGET_DP);
    // The audit reads the box's own node, so the box itself must clear the floor
    // and fill the row that delivers its touches.
    expect(SECTION_ACTION_FRAME_DP).toBeGreaterThanOrEqual(MIN_TAP_TARGET_DP);
  });
});
