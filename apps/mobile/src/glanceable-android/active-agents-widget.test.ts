import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetHomeWidgetDataForTests } from '@/lib/glanceable/home-widget-data';
import { setSurfaceExtras } from '@/lib/glanceable/surface-extras';
import { lightColors } from '@/lib/hooks/theme-colors.generated';

import { type SizeClass, sizeClassFor } from './active-agents-widget';
import {
  byKey,
  CELLS,
  DESIGN,
  type Element,
  hasKey,
  nodes,
  NOW,
  placed,
  type Rect,
  rectOf,
  render,
  texts,
} from './active-agents-widget.test-helpers';
import {
  close,
  ltr,
  type State,
  stateProps,
  STATES,
  targets,
} from './active-agents-widget.test-fixtures';

vi.mock('react-native-android-widget', () => ({
  FlexWidget: () => null,
  OverlapWidget: () => null,
  TextWidget: () => null,
}));

beforeEach(() => {
  _resetHomeWidgetDataForTests();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  setSurfaceExtras({ newestSessionTitle: null, actionFeedback: null });
});

const PADDING: Record<SizeClass, number> = {
  small: 16,
  medium: 16,
  large: 16,
  row: 14,
  narrow: 14,
  landscape: 14,
};
/** The `+` target's trailing edge inset per class; Approve's target sits directly before it. */
const PLUS_INSET: Record<SizeClass, number> = {
  small: 0,
  medium: 0,
  large: 0,
  row: 2,
  narrow: 0,
  landscape: 2,
};

describe('Home widget geometry per cell and state', () => {
  it.each(CELLS)('places every element inside the %dx%d cell', (width, height) => {
    const sizeClass = sizeClassFor(width, height);
    const pad = PADDING[sizeClass];
    const slots: Record<string, Rect> = {};
    for (const [name, state] of Object.entries(STATES) as [string, State][]) {
      const props = stateProps(state);
      for (const rtl of [false, true]) {
        const { light, dark } = render(props, [width, height], rtl);
        expect(texts(light), name).toEqual(texts(dark));
        expect(light.props.clickActionData, name).toEqual({ uri: 'kiloapp:///cloud/sessions' });
        expect(light.props.accessibilityLabel, name).toBe(props.homeCopy?.accessibilityLabel);
        for (const node of placed(light)) {
          const rect = rectOf(node);
          const where = `${name} ${rtl ? 'rtl' : 'ltr'} ${String(node.key)} ${JSON.stringify(rect)}`;
          expect(rect.width, where).toBeGreaterThan(0);
          expect(rect.height, where).toBeGreaterThan(0);
          expect(rect.x, where).toBeGreaterThanOrEqual(-0.05);
          expect(rect.y, where).toBeGreaterThanOrEqual(-0.05);
          expect(rect.x + rect.width, where).toBeLessThanOrEqual(width + 0.05);
          expect(rect.y + rect.height, where).toBeLessThanOrEqual(height + 0.05);
          if (node.props.text !== undefined || node.key === 'status' || node.key === 'line') {
            // Copy stays inside the side padding.
            expect(rect.x, where).toBeGreaterThanOrEqual(pad - 0.05);
            expect(rect.x + rect.width, where).toBeLessThanOrEqual(width - pad + 0.05);
          }
        }
        for (const node of nodes(light).filter(child => child.props.text !== undefined)) {
          expect(node.props.maxLines, name).toBeGreaterThanOrEqual(1);
          if (node.props.text !== props.homeCopy?.primaryCount) {
            expect(node.props.truncate, `${name} ${node.props.text}`).toBe('END');
          }
        }
        const controls = targets(light);
        expect(controls.length, name).toBe(
          (['content', 'empty'].includes(props.home?.status ?? '') && props.home?.canCreate
            ? 1
            : 0) +
            (props.home?.status === 'content' &&
            props.home.canApprove &&
            state.feedback !== 'approving'
              ? 1
              : 0)
        );
        for (const control of controls) {
          const rect = ltr(rectOf(control), { width: width, rtl: rtl });
          expect(rect.width, name).toBeGreaterThanOrEqual(48);
          expect(rect.height, name).toBeGreaterThanOrEqual(48);
          expect(control.props.accessibilityLabel, name).toBeTruthy();
          // Action slots never move between states of one cell (the empty-state pill aside).
          const slot = `${String(control.key)}-${rtl}`;
          if (props.home?.status === 'content' && !['medium', 'large'].includes(sizeClass)) {
            slots[slot] ??= rect;
            expect(rect, `${name} ${slot}`).toEqual(slots[slot]);
          }
        }
        const [first, second] = controls.map(control =>
          ltr(rectOf(control), { width: width, rtl: rtl })
        );
        if (first !== undefined && second !== undefined) {
          const [left, right] = first.x < second.x ? [first, second] : [second, first];
          expect(left.x + left.width, name).toBeLessThanOrEqual(right.x + 0.05);
        }
      }
    }
  });

  it.each(CELLS)(
    'pins the `+` target to the trailing edge with Approve before it at %dx%d',
    (width, height) => {
      const sizeClass = sizeClassFor(width, height);
      for (const rtl of [false, true]) {
        const root = render(
          stateProps(STATES['needs input with Approve']),
          [width, height],
          rtl
        ).light;
        const plus = ltr(rectOf(byKey(root, 'create-target')), { width: width, rtl: rtl });
        const approve = ltr(rectOf(byKey(root, 'approve-target')), { width: width, rtl: rtl });
        close(plus.x + plus.width, width - PLUS_INSET[sizeClass]);
        close(approve.x + approve.width, plus.x);
      }
    }
  );

  it('maps every cell to one size class', () => {
    expect(
      CELLS.map(([width, height]) => `${width}x${height}:${sizeClassFor(width, height)}`)
    ).toEqual([
      '172x104:narrow',
      '266x104:row',
      '360x104:row',
      '172x135:narrow',
      '172x224:small',
      '266x224:medium',
      '360x224:medium',
      '172x344:small',
      '266x344:large',
      '360x344:large',
      '360x464:large',
      '307x62:landscape',
      '467x62:landscape',
      '627x62:landscape',
      '307x135:row',
      '467x135:row',
      '627x135:row',
      '307x208:medium',
      '467x208:medium',
      '627x208:medium',
      '627x281:medium',
      '170x170:small',
      '364x170:medium',
      '364x382:large',
      '360x104:row',
      '172x104:narrow',
      '627x62:landscape',
    ]);
  });
});

describe('Home widget design coordinates at the design frames', () => {
  const at = (size: readonly [number, number], state = STATES['needs input with Approve']) =>
    render(stateProps(state), size).light;
  const rect = (root: Element, key: string) => rectOf(byKey(root, key));

  it('draws Small at the round 2 coordinates', () => {
    const root = at(DESIGN.small);
    expect(rect(root, 'logo')).toEqual({ x: 16, y: 15, width: 18, height: 18 });
    expect(rect(root, 'create-glyph')).toEqual({ x: 130, y: 12, width: 24, height: 24 });
    expect(rect(root, 'approve-glyph')).toEqual({ x: 102, y: 12, width: 24, height: 24 });
    expect(rect(root, 'count').x).toBe(16);
    close(rect(root, 'count').y, 78 - 1.056 * 44);
    close(rect(root, 'footer').y, 152 - 1.056 * 11);
    close(rect(root, 'line-0').y, 117 - 1.056 * 13);
    expect(byKey(root, 'line-0').props.text).toBe('Review the release');
  });

  it('draws Medium with the Approve pill ending at the `+` slot and two rows', () => {
    const root = at(DESIGN.medium);
    expect(rect(root, 'approve-pill')).toEqual({ x: 230, y: 12, width: 86, height: 24 });
    expect(rect(root, 'create-glyph')).toEqual({ x: 324, y: 12, width: 24, height: 24 });
    expect(rect(root, 'row-0-dot')).toEqual({ x: 168, y: 66, width: 8, height: 8 });
    expect(rect(root, 'row-1-title').x).toBe(184);
    expect(hasKey(root, 'row-2-title')).toBe(false);
    close(rect(root, 'count').y, 92 - 1.056 * 44);
  });

  it('draws Large with secondary counts, the divider and three waiting rows', () => {
    const root = at(DESIGN.large);
    expect(rect(root, 'divider')).toEqual({ x: 16, y: 152, width: 332, height: 1 });
    expect(rect(root, 'count-running-dot')).toEqual({ x: 222, y: 66, width: 8, height: 8 });
    for (const index of [0, 1, 2]) {
      close(rect(root, `row-${index}-title`).y, 202 + index * 46 - 1.056 * 14);
    }
    expect(byKey(root, 'section').props.text).toBe('Waiting for you');
  });

  it('draws Row, Narrow and Landscape glyphs at their design centres', () => {
    const rowRoot = at(DESIGN.row);
    expect(rect(rowRoot, 'create-glyph')).toEqual({ x: 310, y: 34, width: 36, height: 36 });
    expect(rect(rowRoot, 'approve-glyph')).toEqual({ x: 266, y: 34, width: 36, height: 36 });
    expect(byKey(rowRoot, 'footer').props.text).toBe('· Checked 8:00 PM');
    const narrowRoot = at(DESIGN.narrow);
    expect(rect(narrowRoot, 'create-glyph')).toEqual({ x: 130, y: 8, width: 28, height: 28 });
    expect(rect(narrowRoot, 'approve-glyph')).toEqual({ x: 98, y: 8, width: 28, height: 28 });
    expect(rect(narrowRoot, 'logo')).toEqual({ x: 14, y: 14, width: 16, height: 16 });
    const land = at(DESIGN.landscape);
    expect(rect(land, 'create-glyph')).toEqual({ x: 577, y: 13, width: 36, height: 36 });
    expect(rect(land, 'approve-glyph')).toEqual({ x: 535, y: 13, width: 36, height: 36 });
    expect(texts(land)).toContain('Review the release');
    expect(texts(at([307, 62]))).not.toContain('Review the release');
  });

  it('keeps the count, dot and label in one 6dp row whose label alone ellipsizes', () => {
    for (const size of [DESIGN.row, DESIGN.narrow, DESIGN.landscape]) {
      const row = byKey(at(size), 'status');
      expect(row.props.style?.flexDirection).toBe('row');
      expect(row.props.style?.flexGap).toBe(6);
      const [count, dotNode, labelSlot] = [row.props.children].flat() as Element[];
      expect(count?.props.text).toBe('3');
      expect(count?.props.truncate).toBeUndefined();
      expect(count?.props.style?.width).toBeUndefined();
      expect(dotNode?.props.style?.backgroundColor).toBe(lightColors.warn);
      expect(labelSlot?.props.style).toMatchObject({ width: 0, flex: 1 });
      const labelNode = nodes(labelSlot).find(node => node.props.text === 'Needs input');
      expect(labelNode?.props).toMatchObject({ maxLines: 1, truncate: 'END' });
    }
  });

  it('mirrors every placed rectangle in RTL and aligns copy to the right', () => {
    for (const size of Object.values(DESIGN)) {
      const props = stateProps(STATES['needs input with Approve']);
      const left = placed(render(props, size).light);
      const right = placed(render(props, size, true).light);
      expect(right.map(node => node.key)).toEqual(left.map(node => node.key));
      expect(right.map(node => ltr(rectOf(node), { width: size[0], rtl: true }))).toEqual(
        left.map(node => rectOf(node))
      );
      for (const node of right.filter(child => child.props.text !== undefined)) {
        expect(['right', 'center'], String(node.key)).toContain(node.props.style?.textAlign);
      }
    }
  });
});
