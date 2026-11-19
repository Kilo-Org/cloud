import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  sheetHeaderSettledTopClearance,
  sheetHeaderTopClearance,
  type SheetHeaderTopInset,
  useFormSheetDetents,
  useFormSheetScreenOptions,
  useSheetHeaderTopClearance,
} from '@/lib/form-sheet';

const mocks = vi.hoisted(() => {
  const platform = { OS: 'android' as string };
  const insets = { top: 0, bottom: 0, left: 0, right: 0 };
  const statusBar = { currentHeight: null as number | null };
  const dimensions = { height: 800 };
  // The native startup metrics: a frame height of 0 matches no window, which is
  // the state a runtime without them reports.
  const initial = { insets: { top: 0 }, frame: { height: 0 } };
  return {
    platform,
    insets,
    statusBar,
    dimensions,
    initial,
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
  initialWindowMetrics: mocks.initial,
}));

vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ background: '#101010' }),
}));

describe('useFormSheetDetents', () => {
  beforeEach(() => {
    mocks.platform.OS = 'android';
    mocks.insets.top = 0;
    mocks.statusBar.currentHeight = null;
    mocks.dimensions.height = 800;
    mocks.initial.insets.top = 0;
    mocks.initial.frame.height = 0;
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

  it('takes the inset the startup metrics carry while the provider answers 0', () => {
    // The provider has not measured yet and answers 0. `StatusBar.currentHeight`
    // stops at the status bar and leaves out the display cutout, which put the
    // list settings sheet 13.7 dp inside the top inset; the startup metrics are
    // the same native read the provider will report.
    mocks.dimensions.height = 914;
    mocks.statusBar.currentHeight = 24;
    mocks.initial.insets.top = 51.8;
    mocks.initial.frame.height = 914;

    expect(useFormSheetDetents()).toEqual({ fullSheetDetent: (914 - 51.8) / 914 });
  });

  it('ignores startup metrics that describe another window', () => {
    mocks.dimensions.height = 914;
    mocks.statusBar.currentHeight = 24;
    mocks.initial.insets.top = 51.8;
    mocks.initial.frame.height = 480;

    expect(useFormSheetDetents()).toEqual({ fullSheetDetent: (914 - 24) / 914 });
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
    mocks.initial.insets.top = 0;
    mocks.initial.frame.height = 0;
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
      contentStyle: { backgroundColor: '#101010' },
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
      contentStyle: { backgroundColor: '#101010' },
    });
  });
});

describe('sheetHeaderTopClearance', () => {
  const clearance = (
    topInset: SheetHeaderTopInset,
    platform: string,
    insets: { screen?: number; window?: number; statusBar?: number } = {}
  ) =>
    sheetHeaderTopClearance({
      topInset,
      platform,
      screenTopInset: insets.screen ?? 0,
      windowTopInset: insets.window ?? 0,
      statusBarHeight: insets.statusBar ?? 0,
    });

  it('clears the status bar on every platform for a surface that owns the window top', () => {
    expect(clearance('always', 'android', { screen: 51.81, window: 51.81, statusBar: 51.81 })).toBe(
      51.81
    );
    expect(clearance('always', 'ios', { screen: 59, window: 59 })).toBe(59);
  });

  it('falls back to the status-bar height while the window inset is unresolved', () => {
    expect(clearance('always', 'android', { statusBar: 51.81 })).toBe(51.81);
    // The Android surface reaches the window top, so the resolution of the
    // window inset must not change the reserve the first frame already had —
    // that change is the 51.8 dp header shift.
    expect(clearance('android-window-top', 'android', { statusBar: 51.81 })).toBe(51.81);
    expect(
      clearance('android-window-top', 'android', { screen: 51.81, window: 51.81, statusBar: 51.81 })
    ).toBe(51.81);
  });

  it('reserves nothing over the iOS sheet that presents below the status bar', () => {
    const ios = { screen: 59, window: 59 };

    expect(clearance('android-window-top', 'ios', ios)).toBe(0);
    expect(clearance('bottom-form-sheet', 'ios', ios)).toBe(0);
    expect(clearance('ios-page-sheet', 'ios', ios)).toBe(0);
    expect(clearance('never', 'ios', ios)).toBe(0);
  });

  it('leaves the detent-capped Android sheet edge to clear the status bar', () => {
    expect(
      clearance('bottom-form-sheet', 'android', {
        screen: 51.81,
        window: 51.81,
        statusBar: 51.81,
      })
    ).toBe(0);
    // A window with no inset of its own leaves the sheet edge at the window
    // top, where the header clears the status bar and the landscape corner.
    expect(clearance('bottom-form-sheet', 'android')).toBe(0);
    expect(clearance('bottom-form-sheet', 'android', { screen: 24 })).toBe(24);
  });

  it('reserves nothing for a sheet that never reaches the window top', () => {
    const android = { screen: 51.81, window: 51.81, statusBar: 51.81 };

    expect(clearance('never', 'android', android)).toBe(0);
    expect(clearance('ios-page-sheet', 'android', android)).toBe(0);
  });
});

describe('sheetHeaderSettledTopClearance', () => {
  it('covers the inset the surface edge leaves above the header', () => {
    // The list settings sheet: the platform settled its header 24 dp from the
    // window top inside a 51.81 dp inset (the status bar carries a display
    // cutout here).
    expect(
      sheetHeaderSettledTopClearance({ clearance: 0, insetTop: 51.81, headerTop: 24 })
    ).toBeCloseTo(27.81);
  });

  it('keeps the clearance the surface mode already reserved', () => {
    expect(
      sheetHeaderSettledTopClearance({ clearance: 51.81, insetTop: 51.81, headerTop: 0 })
    ).toBe(51.81);
  });

  it('adds nothing when the sheet settled below the whole inset', () => {
    expect(
      sheetHeaderSettledTopClearance({ clearance: 0, insetTop: 51.81, headerTop: 457.14 })
    ).toBe(0);
  });

  it('never reserves more than the inset the header overlaps', () => {
    expect(
      sheetHeaderSettledTopClearance({ clearance: 0, insetTop: 51.81, headerTop: -12 })
    ).toBe(51.81);
  });
});

describe('useSheetHeaderTopClearance', () => {
  beforeEach(() => {
    mocks.platform.OS = 'android';
    mocks.insets.top = 0;
    mocks.statusBar.currentHeight = null;
    vi.clearAllMocks();
  });

  it('keeps the first frame settled while the window inset is still unresolved', () => {
    mocks.statusBar.currentHeight = 51.81;

    expect(useSheetHeaderTopClearance('android-window-top')).toBe(51.81);

    mocks.insets.top = 51.81;

    expect(useSheetHeaderTopClearance('android-window-top')).toBe(51.81);
  });
});
