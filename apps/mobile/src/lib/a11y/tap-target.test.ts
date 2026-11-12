/* eslint-disable max-lines -- one suite holds the shared tap-target geometry: the audit floor, every reach, and the wrapped-sentence rules that keep two inline links apart */
import { describe, expect, it, vi } from 'vitest';

// eslint-disable-next-line import/no-nodejs-modules -- Use the compiler's compatible CommonJS export.
import { createRequire } from 'node:module';
import tailwindcss from '@tailwindcss/postcss';
import postcss from 'postcss';
import type * as NativeCSSCompiler from 'react-native-css/compiler';

import {
  CHIP_FRAME_DP,
  CHIP_HIT_SLOP,
  CHIP_HIT_SLOP_DP,
  COMPACT_BUTTON_HIT_SLOP,
  COMPACT_CONTROL_BOX_CLASS,
  COMPACT_CONTROL_HIT_SLOP_DP,
  COMPACT_H11_FRAME_DP,
  COMPACT_H11_HIT_SLOP_DP,
  compactControlTargetDp,
  COMPOSER_CONTROL_GAP_DP,
  COMPOSER_CONTROL_HIT_SLOP_DP,
  COMPOSER_VOICE_SEND_GAP_CLASS,
  composerControlClearanceDp,
  composerFacingHitSlop,
  DENSE_ROW_FRAME_DP,
  DENSE_ROW_HIT_SLOP,
  DENSE_ROW_HIT_SLOP_DP,
  HEADER_TITLE_TARGET_CLASS,
  ICON_TARGET_BOX_CLASS,
  ICON_TARGET_DP,
  INLINE_LINK_BOX_CLASS,
  INLINE_LINK_CONNECTOR_CLASS,
  INLINE_LINK_FACING_HIT_SLOP_DP,
  INLINE_LINK_FACING_VERTICAL_HIT_SLOP_DP,
  INLINE_LINK_LINE_GAP_CLASS,
  INLINE_LINK_LINE_GAP_DP,
  INLINE_LINK_OUTER_HIT_SLOP_DP,
  INLINE_LINK_OUTER_VERTICAL_HIT_SLOP_DP,
  INLINE_LINK_ROW_CLASS,
  INLINE_LINK_ROW_MARGIN_DP,
  INLINE_LINK_SENTENCE_LINE_DP,
  INLINE_LINK_VERTICAL_HIT_SLOP_DP,
  inlineLinkHitSlop,
  LEGAL_LINK_BOX_CLASS,
  LEGAL_LINK_MIN_DP,
  LEGAL_LINK_ROW_CLASS,
  LINE_ACTION_BOX_CLASS,
  LINE_ACTION_HIT_SLOP,
  MIN_TAP_TARGET_DP,
  ROW_TARGET_CLASS,
  STATE_ACTION_CLASS,
  STATE_ACTION_TARGET_DP,
  tapTargetReachDp,
  textActionTargetClass,
  TOUCH_TARGET_DP,
  UNDER_COPY_ACTION_BOX_CLASS,
  UNDER_COPY_ACTION_HIT_SLOP,
  VOICE_INPUT_LG_HIT_SLOP_DP,
} from './tap-target';

// `inlineLinkHitSlop` resolves the sentence's ends through the interface
// direction, and this project has no app build, so the native module is a
// mutable stub the mirror case flips. `textActionTargetClass` reads the
// platform at call time, so the stub carries it mutably too.
const rtl = vi.hoisted(() => ({ isRTL: false }));
const platform = vi.hoisted(() => ({ OS: 'ios' as string }));
vi.mock('react-native', () => ({ I18nManager: rtl, Platform: platform }));

const { compile } = createRequire(import.meta.url)(
  'react-native-css/compiler'
) as typeof NativeCSSCompiler;

/** The value a compiled style declaration holds for one property. */
function declarationValue(declaration: unknown, property: string): unknown {
  // A static declaration compiles to a plain object; a variable one to a
  // [descriptor, property] tuple; `min-width` is static.
  if (Array.isArray(declaration)) {
    const [descriptor, name] = declaration as [unknown, string];
    return name === property ? descriptor : undefined;
  }
  return (declaration as Record<string, unknown>)[property];
}

/** The dp one utility class resolves to, through the app's own pipeline. */
async function compiledDp(className: string, property: string): Promise<number> {
  const { css } = await postcss([tailwindcss()]).process(
    `@reference "../../global.css"; .target { @apply ${className}; }`,
    { from: import.meta.filename }
  );
  const rules = compile(css, { inlineVariables: false }).stylesheet().s;
  const declarations =
    rules?.find(([name]) => name === 'target')?.[1].flatMap(rule => rule.d ?? []) ?? [];
  for (const declaration of declarations) {
    const value = declarationValue(declaration, property);
    if (typeof value === 'number') {
      return value;
    }
  }
  throw new Error(`no compiled ${property} in "${className}"`);
}

describe('shared tap-target geometry', () => {
  it('keeps the control-size audit floor below the design touch target', () => {
    expect(MIN_TAP_TARGET_DP).toBe(28);
    expect(TOUCH_TARGET_DP).toBe(44);
    expect(COMPACT_CONTROL_HIT_SLOP_DP).toBe(8);
    expect(INLINE_LINK_FACING_HIT_SLOP_DP).toBe(4);
    expect(INLINE_LINK_OUTER_HIT_SLOP_DP).toBe(12);
    expect(INLINE_LINK_VERTICAL_HIT_SLOP_DP).toBe(8);
  });

  it('renders the compact control box from whole pixels that clear the audit floor', () => {
    expect(COMPACT_CONTROL_BOX_CLASS).toContain('h-[32px]');
    expect(COMPACT_CONTROL_BOX_CLASS).toContain('w-[32px]');
    expect(COMPACT_CONTROL_BOX_CLASS).toContain('items-center');
  });

  it('renders the icon target box at Android 48dp minimum from whole pixels', () => {
    expect(ICON_TARGET_DP).toBe(48);
    expect(ICON_TARGET_BOX_CLASS).toContain('h-[48px]');
    expect(ICON_TARGET_BOX_CLASS).toContain('w-[48px]');
    expect(ICON_TARGET_BOX_CLASS).toContain('items-center');
    expect(ICON_TARGET_BOX_CLASS).toContain('justify-center');
  });

  it('renders a text-only action frame at the platform minimum on both axes', async () => {
    // The regression this guards: a text link whose only child is one label
    // line reports that line's height as its own rect, and `hitSlop` never
    // lifts the rect an audit reads. `min-h-11` would be 38.5pt on device. The
    // width floor is needed because the caller drops its hit slop: a short
    // label is only a couple of glyphs wide.
    platform.OS = 'ios';
    const ios = textActionTargetClass();
    expect(ios).toContain('min-h-[44px]');
    expect(await compiledDp(ios, 'minHeight')).toBeGreaterThanOrEqual(TOUCH_TARGET_DP);
    expect(await compiledDp(ios, 'minWidth')).toBeGreaterThanOrEqual(TOUCH_TARGET_DP);

    platform.OS = 'android';
    const android = textActionTargetClass();
    expect(android).toContain('min-h-[48px]');
    expect(await compiledDp(android, 'minHeight')).toBeGreaterThanOrEqual(ICON_TARGET_DP);
    expect(await compiledDp(android, 'minWidth')).toBeGreaterThanOrEqual(ICON_TARGET_DP);

    platform.OS = 'ios';
  });

  it('cancels the action box slack under the copy it sits below', async () => {
    // The regression this guards: the box centres one label line, so a tile
    // that pads its edges evenly showed a wider gap under its action than above
    // its copy. The margin removes that slack from the layout, so the tile pads
    // the same on both edges while the box stays above the audit floor and
    // never reaches the message above it.
    const height = await compiledDp(UNDER_COPY_ACTION_BOX_CLASS, 'minHeight');
    expect(height).toBe(32);
    expect(height).toBeGreaterThanOrEqual(MIN_TAP_TARGET_DP);
    // A short label in another language keeps the audit floor on both axes.
    expect(await compiledDp(UNDER_COPY_ACTION_BOX_CLASS, 'minWidth')).toBe(48);
    const margin = await compiledDp(UNDER_COPY_ACTION_BOX_CLASS, 'marginBlock');
    expect(margin).toBe(-7);
    // What is left is the label line itself, so the box adds no room of its own
    // above the copy or below the label.
    expect(Math.abs(height - 2 * Math.abs(margin) - INLINE_LINK_SENTENCE_LINE_DP)).toBeLessThan(1);
    // The slop carries the reach the shortened box gives up on its own node.
    expect(tapTargetReachDp(height - 0.2, UNDER_COPY_ACTION_HIT_SLOP.top)).toBeGreaterThanOrEqual(
      TOUCH_TARGET_DP
    );
    expect(UNDER_COPY_ACTION_HIT_SLOP.top).toBe(UNDER_COPY_ACTION_HIT_SLOP.bottom);
  });

  it('renders a state surface action on the Android 48dp minimum', async () => {
    // Android's `<Button>` rule is 48dp on the pressed node's own rect, and the
    // shared `Button` default frame is `min-h-[44px]`. `hitSlop` would widen
    // the touch region without moving that rect, so the floor is the class.
    expect(STATE_ACTION_TARGET_DP).toBe(48);
    expect(STATE_ACTION_TARGET_DP).toBeGreaterThanOrEqual(TOUCH_TARGET_DP);
    expect(STATE_ACTION_CLASS).toContain('min-h-[48px]');
    // The compiled value is what the layout uses, through the app's pipeline.
    expect(await compiledDp(STATE_ACTION_CLASS, 'minHeight')).toBe(STATE_ACTION_TARGET_DP);
  });

  it('renders an interactive row frame tall enough for both platforms', async () => {
    // The regression this guards: a selection or menu row whose only child is
    // one label line reports that line's height plus its padding as its own
    // rect, and a row sized that way landed under the target on device.
    // `min-h-11` is under the floor here; `hitSlop` would widen the touch region
    // without moving the rect an audit reads, so the floor has to be the row's
    // own class.
    const height = await compiledDp(ROW_TARGET_CLASS, 'minHeight');
    expect(height).toBe(ICON_TARGET_DP);
    expect(height).toBeGreaterThanOrEqual(TOUCH_TARGET_DP);
  });

  it('renders a screen header title control on its own 48dp node', async () => {
    // The regression this guards: a header title composed of its own content
    // (the chat title's rename pressable) reported its text line's 24.8dp as
    // its own rect, and `hitSlop` never lifts the rect a control-size audit
    // reads. The header row is already 48dp tall, so the frame grows only the
    // control's own node.
    const height = await compiledDp(HEADER_TITLE_TARGET_CLASS, 'minHeight');
    expect(height).toBe(ICON_TARGET_DP);
    expect(height).toBeGreaterThanOrEqual(TOUCH_TARGET_DP);
  });

  it('reaches the design touch target with the compact box plus its slop', () => {
    expect(tapTargetReachDp(32, 8)).toBe(48);
    expect(tapTargetReachDp(32, COMPACT_CONTROL_HIT_SLOP_DP)).toBe(48);
    expect(tapTargetReachDp(32, COMPACT_CONTROL_HIT_SLOP_DP)).toBeGreaterThanOrEqual(
      TOUCH_TARGET_DP
    );
  });

  it('carries the compact button frame past the design target with its slop', () => {
    // The regression this guards: the 36dp `sm` frame renders 35.81dp at
    // density 420, so 4 per side measured 43.81dp — under `DESIGN.md`'s 44pt.
    expect(COMPACT_BUTTON_HIT_SLOP.top).toBe(5);
    expect(COMPACT_BUTTON_HIT_SLOP.top).toBe(COMPACT_BUTTON_HIT_SLOP.bottom);
    expect(COMPACT_BUTTON_HIT_SLOP.left).toBe(COMPACT_BUTTON_HIT_SLOP.top);
    expect(COMPACT_BUTTON_HIT_SLOP.right).toBe(COMPACT_BUTTON_HIT_SLOP.top);
    const measuredFrameDp = 35.81;
    expect(
      measuredFrameDp + COMPACT_BUTTON_HIT_SLOP.top + COMPACT_BUTTON_HIT_SLOP.bottom
    ).toBeGreaterThan(TOUCH_TARGET_DP);
    expect(
      measuredFrameDp + COMPACT_BUTTON_HIT_SLOP.left + COMPACT_BUTTON_HIT_SLOP.right
    ).toBeGreaterThan(TOUCH_TARGET_DP);
  });

  it('keeps the measured h-11 frame at or above the audit floor and reaches the design target', () => {
    // The regression this guards: a control sized to its glyph (or to a
    // rem-scaled `h-7`, which measures 24.5dp) is reported as too small to tap.
    expect(COMPACT_H11_FRAME_DP).toBeGreaterThanOrEqual(MIN_TAP_TARGET_DP);
    expect(COMPACT_H11_HIT_SLOP_DP).toBeGreaterThan(0);
    expect(compactControlTargetDp()).toBe(
      tapTargetReachDp(COMPACT_H11_FRAME_DP, COMPACT_H11_HIT_SLOP_DP)
    );
    expect(compactControlTargetDp()).toBeGreaterThanOrEqual(TOUCH_TARGET_DP);
  });

  it('carries a dense row from its own rhythm to the design target with its slop', () => {
    // The regression this guards: a count row that keeps the group's `py-3`
    // rhythm measures under 40 dp on its own rect, under the design target, so
    // the slop is what has to reach 44 dp.
    expect(DENSE_ROW_FRAME_DP).toBeGreaterThanOrEqual(MIN_TAP_TARGET_DP);
    expect(DENSE_ROW_FRAME_DP).toBeLessThan(TOUCH_TARGET_DP);
    expect(DENSE_ROW_HIT_SLOP).toEqual({
      top: DENSE_ROW_HIT_SLOP_DP,
      bottom: DENSE_ROW_HIT_SLOP_DP,
    });
    expect(tapTargetReachDp(DENSE_ROW_FRAME_DP, DENSE_ROW_HIT_SLOP_DP)).toBeGreaterThanOrEqual(
      TOUCH_TARGET_DP
    );
  });

  it('carries a composer chip from its compact frame past the design target', () => {
    // The regression this guards: the chips' `px-3 py-1.5` line measures 27.81pt
    // on Android, under the design target, so the vertical slop is what has to
    // lift the touch region clear of 44pt — 8pt per side lands on 43.81pt.
    expect(CHIP_FRAME_DP).toBeLessThan(TOUCH_TARGET_DP);
    expect(CHIP_HIT_SLOP).toEqual({ top: CHIP_HIT_SLOP_DP, bottom: CHIP_HIT_SLOP_DP });
    // Past the half point the control-size audit allows for pixel rounding, so
    // the reach still clears the target when Android truncates each fractional
    // inset to a whole pixel.
    expect(tapTargetReachDp(CHIP_FRAME_DP, CHIP_HIT_SLOP_DP)).toBeGreaterThanOrEqual(
      TOUCH_TARGET_DP + 0.5
    );
    // Vertical only: the chip is wider than the target on its own, and a
    // horizontal reach would land on the chip beside it and the paste button.
    expect(CHIP_HIT_SLOP).not.toHaveProperty('left');
    expect(CHIP_HIT_SLOP).not.toHaveProperty('right');
  });

  it('carries an inline link from the audit floor to the design target with its slop', () => {
    expect(INLINE_LINK_BOX_CLASS).toContain('min-h-[28px]');
    expect(INLINE_LINK_BOX_CLASS).toContain('min-w-[28px]');
    // The vertical reach is symmetric: 28 + 2 * 8 = 44.
    expect(tapTargetReachDp(MIN_TAP_TARGET_DP, INLINE_LINK_VERTICAL_HIT_SLOP_DP)).toBe(
      TOUCH_TARGET_DP
    );
    // A link with an inline neighbour splits the same vertical reach by side:
    // the facing side gives up its half, the far side carries all of it, and the
    // height is still 28 + 16 = 44.
    expect(INLINE_LINK_FACING_VERTICAL_HIT_SLOP_DP + INLINE_LINK_OUTER_VERTICAL_HIT_SLOP_DP).toBe(
      2 * INLINE_LINK_VERTICAL_HIT_SLOP_DP
    );
    expect(MIN_TAP_TARGET_DP + INLINE_LINK_OUTER_VERTICAL_HIT_SLOP_DP).toBe(TOUCH_TARGET_DP);
    // The horizontal reach is asymmetric (4dp toward the neighbour, 12dp away),
    // so it is box + facing + outer rather than tapTargetReachDp's 2 * slop.
    expect(MIN_TAP_TARGET_DP + INLINE_LINK_FACING_HIT_SLOP_DP + INLINE_LINK_OUTER_HIT_SLOP_DP).toBe(
      TOUCH_TARGET_DP
    );
  });

  it('keeps two wrapped link boxes and their touch regions apart', async () => {
    // The regression this guards: the legal sentence wraps, its two link boxes
    // land on adjacent lines, and each box's rect overflows its own flex line by
    // (28 - line) / 2 on each side. With a 7dp gap the two rects still met by
    // 3.5dp, and a tap in that strip opened the later link instead of the one
    // under the finger.
    const overflowDp = (MIN_TAP_TARGET_DP - INLINE_LINK_SENTENCE_LINE_DP) / 2;
    expect(INLINE_LINK_SENTENCE_LINE_DP).toBe(17.5);
    expect(overflowDp).toBe(5.25);
    // The rects: the gap has to exceed both overflows together.
    expect(INLINE_LINK_LINE_GAP_DP).toBeGreaterThan(2 * overflowDp);
    // The touch regions: a facing slop sits on top of each of those overflows,
    // and the two still stop short of each other inside the same gap.
    expect(INLINE_LINK_FACING_VERTICAL_HIT_SLOP_DP).toBe(0);
    const facingReachDp = overflowDp + INLINE_LINK_FACING_VERTICAL_HIT_SLOP_DP;
    expect(2 * facingReachDp).toBeLessThan(INLINE_LINK_LINE_GAP_DP);
    expect(INLINE_LINK_LINE_GAP_CLASS).toBe(`gap-y-[${INLINE_LINK_LINE_GAP_DP}px]`);
    expect(INLINE_LINK_ROW_CLASS).toContain(INLINE_LINK_LINE_GAP_CLASS);
    // The far reach is what the row's own margin has to hold clear of the
    // neighbouring buttons (the screen's 10.5dp gutter plus that margin), so the
    // two move together rather than on their own.
    expect(overflowDp + INLINE_LINK_OUTER_VERTICAL_HIT_SLOP_DP).toBeLessThanOrEqual(
      10.5 + INLINE_LINK_ROW_MARGIN_DP
    );
    expect(INLINE_LINK_ROW_CLASS).toContain(`my-[${INLINE_LINK_ROW_MARGIN_DP}px]`);
    // The compiled row gap is what the layout applies, not the constant.
    expect(await compiledDp(INLINE_LINK_ROW_CLASS, 'rowGap')).toBe(INLINE_LINK_LINE_GAP_DP);
  });

  it('reserves both facing inline-link reaches on the connector between the links', async () => {
    expect(INLINE_LINK_CONNECTOR_CLASS).toContain('min-w-[10px]');
    // Two inline links separated only by the connector: each reaches
    // INLINE_LINK_FACING_HIT_SLOP_DP toward the other, so a connector narrower
    // than their sum lets the two touch regions meet and the later link claims
    // a tap meant for the first. The compiled width is what the layout uses.
    expect(await compiledDp(INLINE_LINK_CONNECTOR_CLASS, 'minWidth')).toBeGreaterThanOrEqual(
      2 * INLINE_LINK_FACING_HIT_SLOP_DP
    );
  });

  it('resolves each link end to the side that faces the connector', () => {
    const vertical = INLINE_LINK_VERTICAL_HIT_SLOP_DP;
    const facing = INLINE_LINK_FACING_HIT_SLOP_DP;
    const outer = INLINE_LINK_OUTER_HIT_SLOP_DP;
    const facingVertical = INLINE_LINK_FACING_VERTICAL_HIT_SLOP_DP;
    const outerVertical = INLINE_LINK_OUTER_VERTICAL_HIT_SLOP_DP;

    // The vertical split follows the sentence's own order in both directions:
    // wrapped lines stack downward, so the start link's neighbour is on the same
    // line or the next one and only the end link can sit below the start one.
    expect(facingVertical + outerVertical).toBe(2 * vertical);

    // LTR: the link at the sentence's start sits on the left and faces right.
    rtl.isRTL = false;
    expect(inlineLinkHitSlop('start')).toEqual({
      top: outerVertical,
      bottom: facingVertical,
      left: outer,
      right: facing,
    });
    expect(inlineLinkHitSlop('end')).toEqual({
      top: facingVertical,
      bottom: outerVertical,
      left: facing,
      right: outer,
    });

    // RTL: the flex-row mirrors, so the start link sits on the right and faces
    // left; the two ends swap their physical sides. The vertical sides do not
    // move, because a wrapped line always sits below the one before it.
    rtl.isRTL = true;
    expect(inlineLinkHitSlop('start')).toEqual({
      top: outerVertical,
      bottom: facingVertical,
      left: facing,
      right: outer,
    });
    expect(inlineLinkHitSlop('end')).toEqual({
      top: facingVertical,
      bottom: outerVertical,
      left: outer,
      right: facing,
    });

    rtl.isRTL = false;
  });
});

describe('standalone legal link geometry', () => {
  it('renders the 48dp box from whole dp', async () => {
    // The regression this guards: the store legal links rendered as bare
    // `text-xs` Text nodes, so their whole target was the 14dp line.
    expect(LEGAL_LINK_MIN_DP).toBe(48);
    expect(await compiledDp(LEGAL_LINK_BOX_CLASS, 'minHeight')).toBe(LEGAL_LINK_MIN_DP);
    expect(await compiledDp(LEGAL_LINK_BOX_CLASS, 'minWidth')).toBe(LEGAL_LINK_MIN_DP);
    // The utilities are literal in the source so the class compiler can see
    // them; these hold the literals to the dp constants beside them.
    expect(LEGAL_LINK_BOX_CLASS).toContain(`min-h-[${LEGAL_LINK_MIN_DP}px]`);
    expect(LEGAL_LINK_BOX_CLASS).toContain(`min-w-[${LEGAL_LINK_MIN_DP}px]`);
  });

  it('keeps the two store boxes apart when the row wraps', () => {
    // Each store link keeps its full 48dp height in the flow, so a wrapped row
    // stacks two 48dp lines: the boxes sit a gutter apart and cannot overlap.
    // Cancelling the height on the box instead would leave each box reaching
    // 17dp into the line below, where a tap between the lines would open the
    // wrong document.
    expect(LEGAL_LINK_BOX_CLASS).not.toContain('-my-');
    // Horizontally the two boxes sit side by side with no sideways slop, so the
    // row's `gap-x-4` is the whole separation (14dp at the app's 14pt rem).
    expect(LEGAL_LINK_ROW_CLASS).toContain('gap-x-4');
    expect(LEGAL_LINK_ROW_CLASS).toContain('flex-wrap');
  });
});

describe('code-reviewer line-action geometry', () => {
  it('renders the audit floor box and carries it to the design touch target', async () => {
    // The regression this guards: the action rendered at `sm`'s 36dp frame,
    // which overflowed the text line it ends by 11dp and collided with the
    // copy above it. The class compiler only sees the literal, so the literal
    // is held to the audit floor beside it.
    expect(LINE_ACTION_BOX_CLASS).toContain(`min-h-[${MIN_TAP_TARGET_DP}px]`);
    expect(await compiledDp(LINE_ACTION_BOX_CLASS, 'minHeight')).toBe(MIN_TAP_TARGET_DP);
    // The box floats over the line it ends: its vertical margin cancels the
    // half that overflows the `text-xs` line, so it neither grows the row nor
    // reaches into the copy above it. Losing the margin leaves the 28dp
    // height intact and still collides.
    const textLineDp = 14;
    expect(await compiledDp(LINE_ACTION_BOX_CLASS, 'marginBlock')).toBe(
      -(MIN_TAP_TARGET_DP - textLineDp) / 2
    );
    // A `min-h-[28px]` box measures 27.8dp on Android: 27.8 + 2 * 9 = 45.8dp
    // holds, while the inline link's 8dp a side would land at 43.8dp.
    expect(
      tapTargetReachDp(MIN_TAP_TARGET_DP - 0.2, LINE_ACTION_HIT_SLOP.top)
    ).toBeGreaterThanOrEqual(TOUCH_TARGET_DP);
    // A short label's 36dp width floor at the call site measures 35.81dp on
    // Android, so the horizontal reach is checked at that width too:
    // 35.81 + 5 + 5 = 45.81dp holds, while 4dp a side would land at 43.81dp.
    expect(tapTargetReachDp(35.81, LINE_ACTION_HIT_SLOP.left)).toBeGreaterThanOrEqual(
      TOUCH_TARGET_DP
    );
    // The box floats over one line, so neither axis has a shorter side.
    expect(LINE_ACTION_HIT_SLOP.top).toBe(LINE_ACTION_HIT_SLOP.bottom);
    expect(LINE_ACTION_HIT_SLOP.left).toBe(LINE_ACTION_HIT_SLOP.right);
  });
});

describe('composer input row control separation', () => {
  it('spells the row gap as the rem width of the class the row applies', () => {
    // `ms-3` is 0.75rem, and NativeWind's rem measures 14pt on device, so the
    // constant and the class have to move together.
    expect(COMPOSER_CONTROL_GAP_DP).toBe(0.75 * 14);
  });

  it('leaves positive clearance between two adjacent controls tap areas', () => {
    // The regression this guards: the send/stop control carried no gap, so it
    // rendered flush against the microphone and the two tap areas overlapped.
    expect(composerControlClearanceDp()).toBeGreaterThan(0);
    expect(COMPOSER_CONTROL_GAP_DP).toBeGreaterThan(
      VOICE_INPUT_LG_HIT_SLOP_DP + COMPOSER_CONTROL_HIT_SLOP_DP
    );
  });

  it('zeroes the slop on the side the nearer control sits on', () => {
    const slop = COMPOSER_CONTROL_HIT_SLOP_DP;
    const facing = (left: number, right: number) => ({ top: slop, bottom: slop, left, right });
    try {
      // LTR: `start` is the left edge, so the control whose neighbour lies
      // toward the row's start zeroes its left side. A swapped branch would
      // let the two tap areas meet across the gap, and a tap at the
      // microphone's edge would send the message instead.
      rtl.isRTL = false;
      expect(composerFacingHitSlop(slop, 'start')).toEqual(facing(0, slop));
      expect(composerFacingHitSlop(slop, 'end')).toEqual(facing(slop, 0));
      // RTL: the row mirrors, and the two logical sides swap edges with it.
      rtl.isRTL = true;
      expect(composerFacingHitSlop(slop, 'start')).toEqual(facing(slop, 0));
      expect(composerFacingHitSlop(slop, 'end')).toEqual(facing(0, slop));
    } finally {
      rtl.isRTL = false;
    }
  });

  it('gaps the voice toggle from the send control below the two facing slops', () => {
    // `ms-1` is 0.25rem at NativeWind's 14pt rem: 3.5dp, narrower than the
    // two facing slops, which is why both controls zero their facing side.
    expect(COMPOSER_VOICE_SEND_GAP_CLASS).toBe('ms-1');
    const voiceSendGapDp = Number(COMPOSER_VOICE_SEND_GAP_CLASS.slice('ms-'.length)) * 0.25 * 14;
    expect(voiceSendGapDp).toBe(3.5);
    expect(voiceSendGapDp).toBeLessThan(VOICE_INPUT_LG_HIT_SLOP_DP + COMPOSER_CONTROL_HIT_SLOP_DP);
  });
});
