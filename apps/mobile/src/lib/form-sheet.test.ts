import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useFormSheetDetents, useFormSheetScreenOptions } from '@/lib/form-sheet';

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

describe('useFormSheetScreenOptions', () => {
  beforeEach(() => {
    mocks.platform.OS = 'android';
    mocks.insets.top = 0;
    mocks.statusBar.currentHeight = null;
    mocks.dimensions.height = 800;
    vi.clearAllMocks();
  });

  // Without this the Android sheet is measured against the top-inset-reduced
  // height and then lifted again by the bottom gesture inset, so its surface
  // stops above the window bottom and the screen behind it shows through.
  it('overflows the top inset on Android so the detent fills the window bottom', () => {
    mocks.insets.top = 47;

    expect(useFormSheetScreenOptions()).toEqual({
      presentation: 'formSheet',
      sheetAllowedDetents: [0.5, (800 - 47) / 800],
      sheetGrabberVisible: true,
      headerShown: false,
      sheetShouldOverflowTopInset: true,
    });
  });

  it('keeps the overflow flag on iOS, where the native sheet ignores it', () => {
    mocks.platform.OS = 'ios';
    mocks.insets.top = 47;

    expect(useFormSheetScreenOptions()).toEqual({
      presentation: 'formSheet',
      sheetAllowedDetents: [0.5, 1],
      sheetGrabberVisible: true,
      headerShown: false,
      sheetShouldOverflowTopInset: true,
    });
  });
});
