import { describe, expect, it, vi } from 'vitest';

// eslint-disable-next-line import/no-nodejs-modules -- Use the compiler's compatible CommonJS export.
import { createRequire } from 'node:module';
import tailwindcss from '@tailwindcss/postcss';
import postcss from 'postcss';
import type * as NativeCSSCompiler from 'react-native-css/compiler';

import {
  COMPACT_CONTROL_BOX_CLASS,
  COMPACT_CONTROL_HIT_SLOP_DP,
  INLINE_LINK_BOX_CLASS,
  INLINE_LINK_CONNECTOR_CLASS,
  INLINE_LINK_FACING_HIT_SLOP_DP,
  INLINE_LINK_OUTER_HIT_SLOP_DP,
  INLINE_LINK_VERTICAL_HIT_SLOP_DP,
  inlineLinkHitSlop,
  MIN_TAP_TARGET_DP,
  tapTargetReachDp,
  TOUCH_TARGET_DP,
} from './tap-target';

// `inlineLinkHitSlop` resolves the sentence's ends through the interface
// direction, and this project has no app build, so the native module is a
// mutable stub the mirror case flips.
const rtl = vi.hoisted(() => ({ isRTL: false }));
vi.mock('react-native', () => ({ I18nManager: rtl }));

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

  it('reaches the design touch target with the compact box plus its slop', () => {
    expect(tapTargetReachDp(32, 8)).toBe(48);
    expect(tapTargetReachDp(32, COMPACT_CONTROL_HIT_SLOP_DP)).toBe(48);
    expect(tapTargetReachDp(32, COMPACT_CONTROL_HIT_SLOP_DP)).toBeGreaterThanOrEqual(
      TOUCH_TARGET_DP
    );
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
