import { describe, expect, it } from 'vitest';

import {
  ANDROID_NAVIGATION_BAR_HEIGHT,
  getToastBottomOffset,
  TOAST_BOTTOM_GAP,
} from '@/lib/toast-offset';

describe('getToastBottomOffset', () => {
  it('clears the Android navigation bar even when the reported inset is smaller', () => {
    // Gesture navigation reports ~24dp while the IME navigation row is also on
    // screen; the toast must still sit above the whole ~48dp of bottom chrome.
    expect(
      getToastBottomOffset({ platform: 'android', safeAreaBottom: 24, keyboardHeight: 0 })
    ).toBe(ANDROID_NAVIGATION_BAR_HEIGHT + TOAST_BOTTOM_GAP);
  });

  it('clears the Android navigation bar when no inset is reported', () => {
    expect(
      getToastBottomOffset({ platform: 'android', safeAreaBottom: 0, keyboardHeight: 0 })
    ).toBe(ANDROID_NAVIGATION_BAR_HEIGHT + TOAST_BOTTOM_GAP);
  });

  it('keeps a larger Android inset, such as a taskbar', () => {
    expect(
      getToastBottomOffset({ platform: 'android', safeAreaBottom: 60, keyboardHeight: 0 })
    ).toBe(60 + TOAST_BOTTOM_GAP);
  });

  it('uses the safe-area inset plus the standard gap on iOS', () => {
    expect(getToastBottomOffset({ platform: 'ios', safeAreaBottom: 34, keyboardHeight: 0 })).toBe(
      34 + TOAST_BOTTOM_GAP
    );
  });

  it('falls back to sonner-native s default when no inset is known', () => {
    expect(getToastBottomOffset({ platform: 'ios', safeAreaBottom: 0, keyboardHeight: 0 })).toBe(
      16
    );
  });

  it('raises the toast above the software keyboard', () => {
    expect(
      getToastBottomOffset({ platform: 'android', safeAreaBottom: 24, keyboardHeight: 300 })
    ).toBe(300 + TOAST_BOTTOM_GAP);
  });

  it('ignores negative insets', () => {
    expect(
      getToastBottomOffset({ platform: 'android', safeAreaBottom: -10, keyboardHeight: 0 })
    ).toBe(ANDROID_NAVIGATION_BAR_HEIGHT + TOAST_BOTTOM_GAP);
  });

  it('clears the floating tab bar while one is on screen', () => {
    // The tab bar floats as an absolute overlay over the screen bottom, so the
    // reported inset does not include it: the toast must clear the bar's full
    // rendered height (2026-09-19 visual spot check, p1 — the error toast sat
    // over the tab icons).
    expect(
      getToastBottomOffset({
        platform: 'android',
        safeAreaBottom: 0,
        keyboardHeight: 0,
        tabBarHeight: 75,
      })
    ).toBe(75 + TOAST_BOTTOM_GAP);
  });

  it('lets a tab bar taller than the Android navigation bar floor win', () => {
    expect(
      getToastBottomOffset({
        platform: 'android',
        safeAreaBottom: 24,
        keyboardHeight: 0,
        tabBarHeight: 75,
      })
    ).toBe(75 + TOAST_BOTTOM_GAP);
  });

  it('lets the software keyboard win over the tab bar', () => {
    expect(
      getToastBottomOffset({
        platform: 'android',
        safeAreaBottom: 24,
        keyboardHeight: 300,
        tabBarHeight: 75,
      })
    ).toBe(300 + TOAST_BOTTOM_GAP);
  });

  it('keeps the resting offset when no tab bar is on screen', () => {
    expect(
      getToastBottomOffset({
        platform: 'android',
        safeAreaBottom: 24,
        keyboardHeight: 0,
        tabBarHeight: 0,
      })
    ).toBe(ANDROID_NAVIGATION_BAR_HEIGHT + TOAST_BOTTOM_GAP);
  });
});
