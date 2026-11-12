// The two windows in which a sheet's own window does not take touch: while it
// opens, and while it dismisses. Each must arm its own hold, so a close that
// lands while the open hold is still running keeps the gate shut, and a
// dismissal long after the open hold ended arms a fresh one.

import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isSheetTouchHeld,
  SHEET_TOUCH_HOLD_MS,
  SHEET_TOUCH_SETTLE_MS,
  useSheetTouchHold,
} from './sheet-touch-guard';
import { renderWithProviders } from '@/test/render-with-providers';
import { act } from '@/test/renderer';

vi.mock('react-native', () => ({ View: 'View' }));

/** Runs clock and microtasks inside one act, so React settles around the ticks. */
async function settle(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  });
}

type HarnessProps = Readonly<{ opening: boolean; dismissing: boolean }>;

function Harness({ opening, dismissing }: HarnessProps) {
  useSheetTouchHold({ opening, dismissing });
  return createElement('View', { testID: 'harness' });
}

const mounted: { unmount: () => void }[] = [];

type MountedHarness = Awaited<ReturnType<typeof mountHarness>>;

async function mountHarness(props: HarnessProps) {
  const ui = await renderWithProviders(createElement(Harness, props));
  mounted.push(ui);
  return ui;
}

async function update(ui: MountedHarness, props: HarnessProps) {
  await act(async () => {
    ui.renderer.update(createElement(Harness, props));
    await Promise.resolve();
  });
}

afterEach(() => {
  vi.useRealTimers();
  for (const ui of mounted.splice(0)) {
    ui.unmount();
  }
});

describe('useSheetTouchHold', () => {
  it('keeps the gate shut while the sheet opens and lets it go afterwards', async () => {
    vi.useFakeTimers();
    const ui = await mountHarness({ opening: true, dismissing: false });
    expect(isSheetTouchHeld()).toBe(true);

    // The sheet's own window takes touch after the handover, so the open hold
    // must end on its own bound.
    await settle(SHEET_TOUCH_HOLD_MS + 1);

    expect(isSheetTouchHeld()).toBe(false);
    await update(ui, { opening: false, dismissing: false });
  });

  it('keeps the gate shut from the close request until the dismissal ends', async () => {
    vi.useFakeTimers();
    const ui = await mountHarness({ opening: true, dismissing: false });
    expect(isSheetTouchHeld()).toBe(true);

    // The caller closes while the open hold is still running: the dismissal
    // lease takes over and the gate never opens in between.
    await update(ui, { opening: false, dismissing: true });
    expect(isSheetTouchHeld()).toBe(true);

    // The native sheet reports the dismissal, and the reported end ends this
    // window's hold: the sheet's own settle hold (`Sheet`) covers what follows.
    await update(ui, { opening: false, dismissing: false });
    expect(isSheetTouchHeld()).toBe(false);
  });

  it('arms a fresh hold for a dismissal long after the sheet settled', async () => {
    vi.useFakeTimers();
    const ui = await mountHarness({ opening: true, dismissing: false });
    await settle(SHEET_TOUCH_HOLD_MS + 1);
    expect(isSheetTouchHeld()).toBe(false);

    // A swipe or Back dismissal starts while `opening` is long over.
    await update(ui, { opening: false, dismissing: true });
    expect(isSheetTouchHeld()).toBe(true);
  });

  it('releases the dismissal hold on its own when the sheet never reports', async () => {
    vi.useFakeTimers();
    await mountHarness({ opening: false, dismissing: true });
    expect(isSheetTouchHeld()).toBe(true);

    // A dismissal the platform never reports must not keep the screen behind
    // the sheet dead.
    await settle(SHEET_TOUCH_HOLD_MS + 1);
    expect(isSheetTouchHeld()).toBe(false);
  });

  it('gives the settle hold a bound the close-request lease outlasts', () => {
    // `Sheet` arms the settle from the report with `holdSheetTouch`; the
    // constant it passes must stay the shorter window, so a dismissing sheet
    // never opens the gate later than the close-request lease would.
    expect(SHEET_TOUCH_SETTLE_MS).toBeLessThan(SHEET_TOUCH_HOLD_MS);
    expect(SHEET_TOUCH_SETTLE_MS).toBeGreaterThan(0);
  });

  it('lets go when the sheet unmounts mid-dismissal', async () => {
    const ui = await mountHarness({ opening: false, dismissing: true });
    expect(isSheetTouchHeld()).toBe(true);

    ui.unmount();
    mounted.splice(mounted.indexOf(ui), 1);
    expect(isSheetTouchHeld()).toBe(false);
  });
});
