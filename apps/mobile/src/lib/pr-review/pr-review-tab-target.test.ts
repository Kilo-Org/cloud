// The tab row's pills render short of the design touch target, so the slop is
// what carries them to it. These guards hold the arithmetic and the slop's shape
// together, and they read the selector's own classes: a `py-1` edit that
// shortened the pill would otherwise leave the constant and the slop agreeing
// with each other and both wrong.

// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { readFileSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { tapTargetReachDp, TOUCH_TARGET_DP } from '@/lib/a11y/tap-target';
import {
  PR_REVIEW_TAB_FRAME_DP,
  PR_REVIEW_TAB_HIT_SLOP,
  PR_REVIEW_TAB_HIT_SLOP_DP,
} from '@/lib/pr-review/pr-review-tab-target';

vi.mock('react-native', () => ({ I18nManager: { isRTL: false }, Platform: { OS: 'ios' } }));

/** NativeWind's rem, in dp: the app's own `native rem is 14 points` rule. */
const REM_DP = 14;
/** `text-sm`'s line box, in rem: Tailwind's `1.25`. */
const TEXT_SM_LINE_REM = 1.25;

function stripComments(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, match => match.replaceAll(/[^\n]/g, ''))
    .replaceAll(/\/\/[^\n]*/g, '');
}

const selectorSource = stripComments(
  readFileSync(
    fileURLToPath(
      new URL('../../components/pr-review/pr-review-tab-selector.tsx', import.meta.url)
    ),
    'utf8'
  )
);

describe('PR review tab tap target', () => {
  it('reaches the design touch target with its vertical slop', () => {
    expect(
      tapTargetReachDp(PR_REVIEW_TAB_FRAME_DP, PR_REVIEW_TAB_HIT_SLOP_DP)
    ).toBeGreaterThanOrEqual(TOUCH_TARGET_DP);
  });

  it('states the frame the selector actually renders', () => {
    // The pill is `py-<n>` around one `text-sm` line. Both classes come from
    // the component, so the constant cannot drift away from what it describes.
    const padding = /'flex-1 items-center justify-center rounded-md py-(\d+)/.exec(selectorSource);
    expect(padding?.[1]).toBeDefined();
    expect(selectorSource).toContain("'text-sm'");
    const paddingDp = Number(padding?.[1]) * 0.25 * REM_DP;
    expect(PR_REVIEW_TAB_FRAME_DP).toBeCloseTo(paddingDp * 2 + TEXT_SM_LINE_REM * REM_DP, 1);
  });

  it('renders a frame the slop has to lift', () => {
    // The slop exists because the frame is short. A frame that reached the
    // target on its own would leave the slop as unused surface, and this guard
    // would fail so the file is revised rather than kept.
    expect(PR_REVIEW_TAB_FRAME_DP).toBeLessThan(TOUCH_TARGET_DP);
  });

  it('gives the tab the same slop above and below', () => {
    expect(PR_REVIEW_TAB_HIT_SLOP.top).toBe(PR_REVIEW_TAB_HIT_SLOP_DP);
    expect(PR_REVIEW_TAB_HIT_SLOP.bottom).toBe(PR_REVIEW_TAB_HIT_SLOP_DP);
  });

  it('keeps the slop off the sides the neighbour tab occupies', () => {
    // The pills sit `gap-1` (3.5pt) apart, so any horizontal slop would overlap
    // the neighbouring tab's touch area.
    expect(Object.keys(PR_REVIEW_TAB_HIT_SLOP)).toEqual(['top', 'bottom']);
  });
});