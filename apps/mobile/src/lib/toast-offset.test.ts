// eslint-disable-next-line import/no-nodejs-modules -- vitest-only parity check, runs in node, never bundled into the app
import { readFileSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only parity check, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  getToastBottomOffset,
  MIN_BOTTOM_CHROME_HEIGHT,
  TOAST_BOTTOM_GAP,
} from '@/lib/toast-offset';

const SOURCE = readFileSync(fileURLToPath(new URL('toast-offset.ts', import.meta.url)), 'utf8');

describe('getToastBottomOffset', () => {
  it('clears the bottom chrome when the reported inset is smaller', () => {
    // One rule for both platforms: a gesture-navigation inset (~24dp) is
    // floored so the toast still clears the ~48dp of bottom chrome.
    expect(getToastBottomOffset({ safeAreaBottom: 24, keyboardHeight: 0 })).toBe(
      MIN_BOTTOM_CHROME_HEIGHT + TOAST_BOTTOM_GAP
    );
  });

  it('clears the bottom chrome when no inset is reported', () => {
    expect(getToastBottomOffset({ safeAreaBottom: 0, keyboardHeight: 0 })).toBe(
      MIN_BOTTOM_CHROME_HEIGHT + TOAST_BOTTOM_GAP
    );
  });

  it('keeps a larger reported inset, such as a taskbar', () => {
    expect(getToastBottomOffset({ safeAreaBottom: 60, keyboardHeight: 0 })).toBe(
      60 + TOAST_BOTTOM_GAP
    );
  });

  it('ignores negative insets', () => {
    expect(getToastBottomOffset({ safeAreaBottom: -10, keyboardHeight: 0 })).toBe(
      MIN_BOTTOM_CHROME_HEIGHT + TOAST_BOTTOM_GAP
    );
  });

  it('raises the toast above the software keyboard', () => {
    expect(getToastBottomOffset({ safeAreaBottom: 24, keyboardHeight: 300 })).toBe(
      300 + TOAST_BOTTOM_GAP
    );
  });

  it('clears the floating tab bar while one is on screen', () => {
    // The tab bar floats as an absolute overlay over the screen bottom, so the
    // reported inset does not include it: the toast must clear the bar's full
    // rendered height (2026-09-19 visual spot check, p1 — the error toast sat
    // over the tab icons).
    expect(getToastBottomOffset({ safeAreaBottom: 0, keyboardHeight: 0, tabBarHeight: 75 })).toBe(
      75 + TOAST_BOTTOM_GAP
    );
  });

  it('lets a tab bar taller than the bottom-chrome floor win', () => {
    expect(getToastBottomOffset({ safeAreaBottom: 24, keyboardHeight: 0, tabBarHeight: 75 })).toBe(
      75 + TOAST_BOTTOM_GAP
    );
  });

  it('lets the software keyboard win over the tab bar', () => {
    expect(
      getToastBottomOffset({ safeAreaBottom: 24, keyboardHeight: 300, tabBarHeight: 75 })
    ).toBe(300 + TOAST_BOTTOM_GAP);
  });

  it('keeps the resting offset when no tab bar is on screen', () => {
    expect(getToastBottomOffset({ safeAreaBottom: 24, keyboardHeight: 0, tabBarHeight: 0 })).toBe(
      MIN_BOTTOM_CHROME_HEIGHT + TOAST_BOTTOM_GAP
    );
  });
});

describe('one implementation for both platforms', () => {
  /**
   * The offset decides every bottom-center toast, so it must not branch on the
   * platform: iOS and Android run the same rule (the reported inset is floored,
   * never replaced). A `Platform.OS`/`Platform.select` check, a platform-suffixed
   * import, or a `'android'`/`'ios'` literal reaching the math fails here.
   */
  it('keeps no per-platform branch in the shared offset module', () => {
    expect(SOURCE).not.toMatch(/\bPlatform\.(?:OS|select|Version)\b/);
    expect(SOURCE).not.toMatch(/from '[^']+\.(?:ios|android)'/);
    expect(SOURCE).not.toMatch(/['"](?:android|ios)['"]/);
  });
});
