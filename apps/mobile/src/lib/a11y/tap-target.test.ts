import { describe, expect, it, vi } from 'vitest';

// eslint-disable-next-line import/no-nodejs-modules -- Use the compiler's compatible CommonJS export.
import { createRequire } from 'node:module';
import tailwindcss from '@tailwindcss/postcss';
import postcss from 'postcss';
import type * as NativeCSSCompiler from 'react-native-css/compiler';

import {
  COMPACT_CONTROL_BOX_CLASS,
  COMPACT_CONTROL_HIT_SLOP_DP,
  COMPACT_H11_FRAME_DP,
  COMPACT_H11_HIT_SLOP_DP,
  compactControlTargetDp,
  COMPOSER_CONTROL_GAP_DP,
  COMPOSER_CONTROL_HIT_SLOP_DP,
  composerControlClearanceDp,
  ICON_TARGET_BOX_CLASS,
  ICON_TARGET_DP,
  INLINE_LINK_BOX_CLASS,
  INLINE_LINK_CONNECTOR_CLASS,
  INLINE_LINK_FACING_HIT_SLOP_DP,
  INLINE_LINK_OUTER_HIT_SLOP_DP,
  INLINE_LINK_VERTICAL_HIT_SLOP_DP,
  inlineLinkHitSlop,
  LEGAL_LINK_BOX_CLASS,
  LEGAL_LINK_LINE_DP,
  LEGAL_LINK_MIN_DP,
  LEGAL_LINK_ROW_CLASS,
  LEGAL_LINK_SENTENCE_BOX_CLASS,
  LEGAL_LINK_SENTENCE_CANCEL_DP,
  MIN_TAP_TARGET_DP,
  ROW_TARGET_CLASS,
  STATE_ACTION_CLASS,
  STATE_ACTION_TARGET_DP,
  tapTargetReachDp,
  textActionTargetClass,
  TOUCH_TARGET_DP,
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

  it('reaches the design touch target with the compact box plus its slop', () => {
    expect(tapTargetReachDp(32, 8)).toBe(48);
    expect(tapTargetReachDp(32, COMPACT_CONTROL_HIT_SLOP_DP)).toBe(48);
    expect(tapTargetReachDp(32, COMPACT_CONTROL_HIT_SLOP_DP)).toBeGreaterThanOrEqual(
      TOUCH_TARGET_DP
    );
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

  it('carries an inline link from the audit floor to the design target with its slop', () => {
    expect(INLINE_LINK_BOX_CLASS).toContain('min-h-[28px]');
    expect(INLINE_LINK_BOX_CLASS).toContain('min-w-[28px]');
    // The vertical reach is symmetric: 28 + 2 * 8 = 44.
    expect(tapTargetReachDp(MIN_TAP_TARGET_DP, INLINE_LINK_VERTICAL_HIT_SLOP_DP)).toBe(
      TOUCH_TARGET_DP
    );
    // The horizontal reach is asymmetric (4dp toward the neighbour, 12dp away),
    // so it is box + facing + outer rather than tapTargetReachDp's 2 * slop.
    expect(MIN_TAP_TARGET_DP + INLINE_LINK_FACING_HIT_SLOP_DP + INLINE_LINK_OUTER_HIT_SLOP_DP).toBe(
      TOUCH_TARGET_DP
    );
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

    // LTR: the link at the sentence's start sits on the left and faces right.
    rtl.isRTL = false;
    expect(inlineLinkHitSlop('start')).toEqual({
      top: vertical,
      bottom: vertical,
      left: outer,
      right: facing,
    });
    expect(inlineLinkHitSlop('end')).toEqual({
      top: vertical,
      bottom: vertical,
      left: facing,
      right: outer,
    });

    // RTL: the flex-row mirrors, so the start link sits on the right and faces
    // left; the two ends swap their physical sides.
    rtl.isRTL = true;
    expect(inlineLinkHitSlop('start')).toEqual({
      top: vertical,
      bottom: vertical,
      left: facing,
      right: outer,
    });
    expect(inlineLinkHitSlop('end')).toEqual({
      top: vertical,
      bottom: vertical,
      left: outer,
      right: facing,
    });

    rtl.isRTL = false;
  });
});

describe('standalone legal link geometry', () => {
  it('renders the 48dp box from whole dp', async () => {
    // The regression this guards: the store and consent legal links rendered as
    // bare `text-xs` Text nodes, so their whole target was the 14dp line.
    expect(LEGAL_LINK_MIN_DP).toBe(48);
    expect(await compiledDp(LEGAL_LINK_BOX_CLASS, 'minHeight')).toBe(LEGAL_LINK_MIN_DP);
    expect(await compiledDp(LEGAL_LINK_BOX_CLASS, 'minWidth')).toBe(LEGAL_LINK_MIN_DP);
    expect(await compiledDp(LEGAL_LINK_SENTENCE_BOX_CLASS, 'minHeight')).toBe(LEGAL_LINK_MIN_DP);
    // The utilities are literal in the source so the class compiler can see
    // them; these hold the literals to the dp constants beside them.
    expect(LEGAL_LINK_BOX_CLASS).toContain(`min-h-[${LEGAL_LINK_MIN_DP}px]`);
    expect(LEGAL_LINK_BOX_CLASS).toContain(`min-w-[${LEGAL_LINK_MIN_DP}px]`);
    expect(LEGAL_LINK_SENTENCE_BOX_CLASS).toContain(`-my-[${LEGAL_LINK_SENTENCE_CANCEL_DP}px]`);
  });

  it('keeps the two store boxes apart when the row wraps', async () => {
    // Each store link keeps its full 48dp height in the flow, so a wrapped row
    // stacks two 48dp lines: the boxes sit a gutter apart and cannot overlap.
    // Cancelling the height on the box instead (as the sentence's own box does)
    // would leave each box reaching 17dp into the line below, where a tap
    // between the lines would open the wrong document.
    expect(LEGAL_LINK_BOX_CLASS).not.toContain('-my-');
    // Horizontally the two boxes sit side by side with no sideways slop, so the
    // row's `gap-x-4` is the whole separation (14dp at the app's 14pt rem).
    expect(LEGAL_LINK_ROW_CLASS).toContain('gap-x-4');
    expect(LEGAL_LINK_ROW_CLASS).toContain('flex-wrap');

    // The sentence has no second link beside it, so its box cancels the
    // overflow past the `text-sm` line and the sentence keeps its own height.
    expect(LEGAL_LINK_LINE_DP).toBe(17.5);
    expect(LEGAL_LINK_SENTENCE_CANCEL_DP).toBe(
      Math.round((LEGAL_LINK_MIN_DP - LEGAL_LINK_LINE_DP) / 2)
    );
    expect(await compiledDp(LEGAL_LINK_SENTENCE_BOX_CLASS, 'marginBlock')).toBe(
      -LEGAL_LINK_SENTENCE_CANCEL_DP
    );
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
});
