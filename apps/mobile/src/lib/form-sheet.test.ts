import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAndroidSheetTopInset, useFormSheetDetents } from '@/lib/form-sheet';

const mocks = vi.hoisted(() => {
  const platform = { OS: 'android' as string };
  const insets = { top: 0, bottom: 0, left: 0, right: 0 };
  const statusBar = { currentHeight: null as number | null };
  const dimensions = { height: 800 };
  return {
    platform,
    insets,
    statusBar,
    dimensions,
    useSafeAreaInsets: vi.fn(() => insets),
    useWindowDimensions: vi.fn(() => dimensions),
  };
});

vi.mock('react-native', () => ({
  Platform: mocks.platform,
  StatusBar: mocks.statusBar,
  useWindowDimensions: mocks.useWindowDimensions,
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: mocks.useSafeAreaInsets,
}));

describe('useAndroidSheetTopInset', () => {
  beforeEach(() => {
    mocks.platform.OS = 'android';
    mocks.insets.top = 0;
    mocks.statusBar.currentHeight = null;
    vi.clearAllMocks();
  });

  it('prefers a positive Android safe-area top over StatusBar.currentHeight', () => {
    mocks.insets.top = 47;
    mocks.statusBar.currentHeight = 24;

    expect(useAndroidSheetTopInset()).toBe(47);
  });

  it('falls back to StatusBar.currentHeight when the Android safe-area top is zero', () => {
    mocks.insets.top = 0;
    mocks.statusBar.currentHeight = 24;

    expect(useAndroidSheetTopInset()).toBe(24);
  });

  it('returns 0 when the Android safe-area top is zero and StatusBar.currentHeight is null', () => {
    mocks.insets.top = 0;
    mocks.statusBar.currentHeight = null;

    expect(useAndroidSheetTopInset()).toBe(0);
  });

  it('returns 0 on iOS regardless of insets', () => {
    mocks.platform.OS = 'ios';
    mocks.insets.top = 47;
    mocks.statusBar.currentHeight = 24;

    expect(useAndroidSheetTopInset()).toBe(0);
  });
});

describe('useFormSheetDetents', () => {
  beforeEach(() => {
    mocks.platform.OS = 'android';
    mocks.insets.top = 0;
    mocks.statusBar.currentHeight = null;
    mocks.dimensions.height = 800;
    vi.clearAllMocks();
  });

  it('keeps the Android detent that subtracts the safe-area top', () => {
    mocks.insets.top = 47;

    expect(useFormSheetDetents()).toEqual({
      fullSheetDetent: (800 - 47) / 800,
    });
  });

  it('keeps the Android detent that subtracts the StatusBar fallback', () => {
    mocks.insets.top = 0;
    mocks.statusBar.currentHeight = 24;

    expect(useFormSheetDetents()).toEqual({
      fullSheetDetent: (800 - 24) / 800,
    });
  });

  it('keeps the iOS detent at 1', () => {
    mocks.platform.OS = 'ios';
    mocks.insets.top = 47;

    expect(useFormSheetDetents()).toEqual({ fullSheetDetent: 1 });
  });
});
