// The clearance arithmetic only keeps the pill's and the overflow's tap areas
// apart if the row lays them out the way this reads it. `comment-row.tsx`
// spells the trailing group's gap as a literal `gap-3` class (NativeWind reads
// the class at build time, so the component cannot import a number) and hands
// each control its shared hit-slop object. This guards those actual values by
// reading the row and the pill source and pairing them with the two slop
// objects, instead of re-deriving a helper the row never calls.

// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { readFileSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { MIN_TAP_TARGET_DP, TOUCH_TARGET_DP } from '@/lib/a11y/tap-target';
import {
  COMMENT_ACTIONS_FRAME_DP,
  COMMENT_ACTIONS_HIT_SLOP,
  COMMENT_ACTIONS_VISUAL_DP,
  COMMENT_TRAILING_CONTROLS_GAP_DP,
  FIX_WITH_KILO_HIT_SLOP,
  FIX_WITH_KILO_VISUAL_DP,
} from '@/lib/pr-review/comment-trailing-controls';

vi.mock('react-native', () => ({ I18nManager: { isRTL: false } }));

// Removes `//` line comments and `/* */` block comments, preserving line
// breaks, so a comment that merely names a class or a hit-slop object cannot
// satisfy the guards below.
function stripComments(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, match => match.replaceAll(/[^\n]/g, ''))
    .replaceAll(/\/\/[^\n]*/g, '');
}

const discussionDir = fileURLToPath(
  new URL('../../components/pr-review/discussion', import.meta.url)
);
const rowSource = stripComments(readFileSync(`${discussionDir}/comment-row.tsx`, 'utf8'));
const pillSource = stripComments(
  readFileSync(`${discussionDir}/pr-comment-fix-with-kilo.tsx`, 'utf8')
);

describe('comment trailing controls tap areas', () => {
  it('finds the row and the pill it guards', () => {
    // A renamed control or a moved file would make the assertions below pass
    // vacuously.
    expect(rowSource).toContain('PrCommentFixWithKilo');
    expect(pillSource).toContain('FIX_WITH_KILO_HIT_SLOP');
  });

  it('lays the two controls out with the gap the clearance assumes', () => {
    // The regression this guards: a change to the row's actual gap class would
    // leave COMMENT_TRAILING_CONTROLS_GAP_DP stating a spacing the row no
    // longer renders.
    const groupClassName = /className="([^"]*ml-auto[^"]*)"/.exec(rowSource)?.[1] ?? '';
    const classes = groupClassName.split(/\s+/);
    expect(classes).toContain('flex-row');
    expect(classes).toContain('items-center');
    expect(classes).toContain('gap-3');
  });

  it('wires the shared hit slop objects into the row and the pill', () => {
    expect(rowSource).toContain('hitSlop={COMMENT_ACTIONS_HIT_SLOP}');
    expect(pillSource).toContain('hitSlop={FIX_WITH_KILO_HIT_SLOP}');
  });

  it('keeps the pill and the overflow hit areas apart', () => {
    // The overflow's 3pt left slop used to reach into the pill's right edge, so
    // a tap on the pill opened the moderation sheet instead of the session. The
    // gap and both slops are measured from the frames, so the overflow frame's
    // inset around its visible circle does not enter here.
    const clearance =
      COMMENT_TRAILING_CONTROLS_GAP_DP -
      FIX_WITH_KILO_HIT_SLOP.right -
      COMMENT_ACTIONS_HIT_SLOP.left;
    expect(clearance).toBeGreaterThan(0);
    expect(clearance).toBe(5.5);
  });

  it('keeps the overflow frame at or above the 28dp the size audit measures', () => {
    // h-7 measured 24.5dp on device (NativeWind's rem is 14pt) and was
    // reported as too small to tap.
    expect(COMMENT_ACTIONS_FRAME_DP).toBeGreaterThanOrEqual(MIN_TAP_TARGET_DP);
    expect(COMMENT_ACTIONS_VISUAL_DP).toBeLessThan(COMMENT_ACTIONS_FRAME_DP);
  });

  it('keeps both controls at the 44pt minimum touch target', () => {
    // The pill renders 23pt tall (FIX_WITH_KILO_VISUAL_DP: a 1rem `text-xs`
    // line box, `py-1` per side and the border, at NativeWind's 14pt rem), so
    // the overflow reaches 44pt from its frame plus the slop on every side and
    // the pill needs its own vertical slop to get there.
    expect(
      COMMENT_ACTIONS_FRAME_DP + COMMENT_ACTIONS_HIT_SLOP.top + COMMENT_ACTIONS_HIT_SLOP.bottom
    ).toBeGreaterThanOrEqual(TOUCH_TARGET_DP);
    expect(
      FIX_WITH_KILO_HIT_SLOP.top + FIX_WITH_KILO_HIT_SLOP.bottom + FIX_WITH_KILO_VISUAL_DP
    ).toBeGreaterThanOrEqual(TOUCH_TARGET_DP);
  });
});
