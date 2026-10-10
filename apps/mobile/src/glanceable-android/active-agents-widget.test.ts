import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetHomeWidgetDataForTests } from '@/lib/glanceable/home-widget-data';
import { setSurfaceExtras } from '@/lib/glanceable/surface-extras';
import { lightColors } from '@/lib/hooks/theme-colors.generated';

import { sizeClassFor } from './active-agents-widget';
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
  expectInsideBand,
  ltr,
  padFor,
  type State,
  stateProps,
  STATES,
  targets,
} from './active-agents-widget.test-fixtures';

vi.mock('react-native-android-widget', () => ({
  FlexWidget: () => null,
  ImageWidget: () => null,
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

const GLYPH_GAP = 4;

/** Placement is in tenths of a dp; a mirrored read-back adds float noise below that. */
const tenths = (box: Rect) =>
  Object.fromEntries(Object.entries(box).map(([key, value]) => [key, Math.round(value * 10)]));

/** The Approve control (circle or pill) and `+`, both in LTR design coordinates. */
function controls(root: Element, frame: { width: number; rtl: boolean }) {
  const approveKey = ['approve-glyph', 'approving-glyph', 'approve-pill'].find(key =>
    hasKey(root, key)
  );
  return {
    approve: approveKey === undefined ? null : ltr(rectOf(byKey(root, approveKey)), frame),
    plus: hasKey(root, 'create-glyph') ? ltr(rectOf(byKey(root, 'create-glyph')), frame) : null,
  };
}

describe('Home widget geometry per cell and state', () => {
  it.each(CELLS)('keeps every element inside the 14dp band of the %dx%d cell', (width, height) => {
    const slots: Record<string, Rect> = {};
    const sizeClass = sizeClassFor(width, height);
    for (const [name, state] of Object.entries(STATES) as [string, State][]) {
      const props = stateProps(state);
      for (const rtl of [false, true]) {
        const label = `${name} ${rtl ? 'rtl' : 'ltr'}`;
        const { light, dark } = render(props, [width, height], rtl);
        expect(texts(light), label).toEqual(texts(dark));
        expect(light.props.clickActionData, label).toEqual({ uri: 'kiloapp:///cloud/sessions' });
        expect(light.props.accessibilityLabel, label).toBe(props.homeCopy?.accessibilityLabel);
        expect(hasKey(light, 'logo'), `${label} logo`).toBe(true);
        for (const node of placed(light)) {
          const rect = rectOf(node);
          const where = `${label} ${String(node.key)} ${JSON.stringify(rect)}`;
          expect(rect.width, where).toBeGreaterThan(0);
          expect(rect.height, where).toBeGreaterThan(0);
          expect(rect.x, where).toBeGreaterThanOrEqual(-0.05);
          expect(rect.y, where).toBeGreaterThanOrEqual(-0.05);
          expect(rect.x + rect.width, where).toBeLessThanOrEqual(width + 0.05);
          expect(rect.y + rect.height, where).toBeLessThanOrEqual(height + 0.05);
        }
        expectInsideBand(light, [width, height], label);
        for (const node of nodes(light).filter(child => child.props.text !== undefined)) {
          expect(node.props.maxLines, label).toBeGreaterThanOrEqual(1);
          if (node.props.text !== props.homeCopy?.primaryCount) {
            expect(node.props.truncate, `${label} ${node.props.text}`).toBe('END');
          }
        }
        const drawn = targets(light);
        expect(drawn.length, label).toBe(
          (['content', 'empty'].includes(props.home?.status ?? '') && props.home?.canCreate
            ? 1
            : 0) +
            (props.home?.status === 'content' &&
            props.home.canApprove &&
            state.feedback !== 'approving'
              ? 1
              : 0)
        );
        for (const control of drawn) {
          const rect = ltr(rectOf(control), { width, rtl });
          expect(rect.height, label).toBeGreaterThanOrEqual(Math.min(48, height));
          expect(control.props.accessibilityLabel, label).toBeTruthy();
          // Action slots never move between states of one cell (the empty-state pill aside).
          const slot = `${String(control.key)}-${rtl}`;
          if (props.home?.status === 'content' && !['medium', 'large'].includes(sizeClass)) {
            slots[slot] ??= rect;
            expect(rect, `${label} ${slot}`).toEqual(slots[slot]);
          }
        }
        const [first, second] = drawn.map(control => ltr(rectOf(control), { width, rtl }));
        if (first !== undefined && second !== undefined) {
          const [left, right] = first.x < second.x ? [first, second] : [second, first];
          expect(left.x + left.width, label).toBeLessThanOrEqual(right.x + 0.05);
        }
      }
    }
  });

  it.each(CELLS)(
    'keeps Approve 4dp before `+` and splits their targets at the gap at %dx%d',
    (width, height) => {
      for (const state of [STATES['needs input with Approve'], STATES.approving]) {
        for (const rtl of [false, true]) {
          const root = render(stateProps(state), [width, height], rtl).light;
          const frame = { width, rtl };
          const { approve, plus } = controls(root, frame);
          if (approve === null || plus === null) {
            throw new Error('both actions draw');
          }
          close(plus.x + plus.width, width - padFor(width, height));
          expect(plus.x - (approve.x + approve.width)).toBeCloseTo(GLYPH_GAP, 5);
          const plusTarget = ltr(rectOf(byKey(root, 'create-target')), frame);
          // `+` owns the trailing edge from the middle of the gap: the largest target
          // that cannot overlap Approve's, and 48dp wherever the glyph is large enough.
          expect(plusTarget.x).toBeCloseTo(plus.x - GLYPH_GAP / 2, 5);
          expect(plusTarget.x + plusTarget.width).toBeCloseTo(width, 5);
          if (plus.width >= 32) {
            expect(plusTarget.width).toBeGreaterThanOrEqual(48);
          }
          if (state === STATES.approving) {
            expect(hasKey(root, 'approve-target')).toBe(false);
          } else {
            const approveTarget = ltr(rectOf(byKey(root, 'approve-target')), frame);
            expect(approveTarget.x + approveTarget.width).toBeCloseTo(plusTarget.x, 5);
            expect(approveTarget.width).toBeGreaterThanOrEqual(48);
            // Each target covers its whole control.
            expect(approveTarget.x).toBeLessThanOrEqual(approve.x + 0.05);
            for (const [control, hit] of [
              [approve, approveTarget],
              [plus, plusTarget],
            ] as const) {
              expect(hit.y).toBeLessThanOrEqual(control.y + 0.05);
              expect(hit.y + hit.height).toBeGreaterThanOrEqual(control.y + control.height - 0.05);
            }
          }
        }
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

  it('draws Small with the header on the padding line', () => {
    const root = at(DESIGN.small);
    expect(rect(root, 'logo')).toEqual({ x: 16, y: 19, width: 18, height: 18 });
    expect(rect(root, 'create-glyph')).toEqual({ x: 130, y: 16, width: 24, height: 24 });
    expect(rect(root, 'approve-glyph')).toEqual({ x: 102, y: 16, width: 24, height: 24 });
    // `+` owns 16 + 24 + 2dp: the most it can take without overlapping Approve.
    expect(rect(root, 'create-target')).toMatchObject({ x: 128, width: 42 });
    expect(rect(root, 'approve-target')).toMatchObject({ x: 80, width: 48 });
    expect(rect(root, 'count').x).toBe(16);
    const footer = rect(root, 'footer');
    close(footer.y + footer.height, 170 - 16);
    expect(byKey(root, 'line-0').props.text).toBe('Review the release');
  });

  it('draws Medium with the Approve pill 4dp before `+` and two rows', () => {
    const root = at(DESIGN.medium);
    expect(rect(root, 'approve-pill')).toEqual({ x: 234, y: 16, width: 86, height: 24 });
    expect(rect(root, 'create-glyph')).toEqual({ x: 324, y: 16, width: 24, height: 24 });
    expect(rect(root, 'logo')).toEqual({ x: 16, y: 19, width: 18, height: 18 });
    expect(hasKey(root, 'row-1-title')).toBe(true);
    expect(hasKey(root, 'row-2-title')).toBe(false);
  });

  it('draws Large with secondary counts, the divider and three waiting rows', () => {
    const root = at(DESIGN.large);
    expect(rect(root, 'divider')).toMatchObject({ x: 16, width: 332, height: 1 });
    for (const index of [0, 1, 2]) {
      expect(hasKey(root, `row-${index}-title`)).toBe(true);
    }
    expect(byKey(root, 'section').props.text).toBe('Waiting for you');
  });

  it('compresses Row, Narrow and Landscape glyphs into the band', () => {
    const rowRoot = at(DESIGN.row);
    expect(rect(rowRoot, 'create-glyph')).toEqual({ x: 310, y: 34.5, width: 36, height: 36 });
    expect(rect(rowRoot, 'approve-glyph')).toEqual({ x: 270, y: 34.5, width: 36, height: 36 });
    expect(rect(rowRoot, 'logo')).toEqual({ x: 14, y: 16, width: 14, height: 14 });
    expect(byKey(rowRoot, 'footer').props.text).toBe('· Checked 8:00 PM');
    const narrowRoot = at(DESIGN.narrow);
    expect(rect(narrowRoot, 'create-glyph')).toEqual({ x: 134, y: 14, width: 24, height: 24 });
    expect(rect(narrowRoot, 'approve-glyph')).toEqual({ x: 106, y: 14, width: 24, height: 24 });
    expect(rect(narrowRoot, 'logo')).toEqual({ x: 14, y: 18, width: 16, height: 16 });
    const land = at(DESIGN.landscape);
    expect(rect(land, 'create-glyph')).toEqual({ x: 581, y: 15, width: 32, height: 32 });
    expect(rect(land, 'approve-glyph')).toEqual({ x: 545, y: 15, width: 32, height: 32 });
    expect(texts(land)).toContain('Review the release');
    expect(texts(at([307, 62]))).not.toContain('Review the release');
  });

  it('starts every Landscape line with the 18dp mark and a 6dp gap, locked too', () => {
    for (const state of [STATES['needs input with Approve'], STATES.empty, STATES.privacy]) {
      const root = at(DESIGN.landscape, state);
      expect(rect(root, 'logo')).toEqual({ x: 14, y: 22, width: 18, height: 18 });
      const lead = hasKey(root, 'lock-body') ? rect(root, 'lock-body') : rect(root, 'status');
      expect(lead.x).toBe(38);
    }
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

  it('mirrors every placed rectangle, the mark included, in RTL and aligns copy right', () => {
    for (const size of Object.values(DESIGN)) {
      for (const [name, state] of Object.entries(STATES) as [string, State][]) {
        const props = stateProps(state);
        const left = placed(render(props, size).light);
        const right = placed(render(props, size, true).light);
        expect(
          right.map(node => node.key),
          name
        ).toEqual(left.map(node => node.key));
        expect(
          right.map(node => tenths(ltr(rectOf(node), { width: size[0], rtl: true }))),
          name
        ).toEqual(left.map(node => tenths(rectOf(node))));
        expect(
          right.map(node => node.key),
          name
        ).toContain('logo');
        for (const node of right.filter(child => child.props.text !== undefined)) {
          expect(['right', 'center'], `${name} ${String(node.key)}`).toContain(
            node.props.style?.textAlign
          );
        }
      }
    }
  });
});
