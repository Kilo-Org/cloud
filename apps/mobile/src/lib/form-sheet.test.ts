import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useFormSheetDetents } from '@/lib/form-sheet';

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

  it.each([
    { name: 'portrait cutout', height: 800, nativeTop: 47, top: 47, statusBar: 24 },
    { name: 'portrait status bar', height: 800, nativeTop: 24, top: 24, statusBar: 24 },
    { name: 'initial zero JS inset', height: 800, nativeTop: 24, top: 0, statusBar: 24 },
    { name: 'landscape without top inset', height: 400, nativeTop: 0, top: 0, statusBar: 24 },
    { name: 'hidden status bar', height: 800, nativeTop: 0, top: 0, statusBar: null },
  ])('covers the presenting header up to the native safe area ($name)', scenario => {
    mocks.dimensions.height = scenario.height;
    mocks.insets.top = scenario.top;
    mocks.statusBar.currentHeight = scenario.statusBar;

    const { fullSheetDetent } = useFormSheetDetents();
    // react-native-screens measures detents against height minus the top inset
    // by default (sheetShouldOverflowTopInset=false). A second subtraction in
    // JS exposes a strip of the presenting screen below the native safe area.
    const nativeAvailableHeight = scenario.height - scenario.nativeTop;
    const sheetTop = scenario.height - Math.trunc(fullSheetDetent * nativeAvailableHeight);

    expect(sheetTop).toBe(scenario.nativeTop);
    expect(fullSheetDetent).toBe(1);
  });

  it('keeps the full detent stable as insets arrive and the window resizes', () => {
    mocks.statusBar.currentHeight = 24;
    const initial = useFormSheetDetents();

    mocks.insets.top = 47;
    const insetReady = useFormSheetDetents();

    mocks.insets.top = 0;
    mocks.dimensions.height = 400;
    const landscape = useFormSheetDetents();

    expect(initial).toEqual({ fullSheetDetent: 1 });
    expect(insetReady).toEqual(initial);
    expect(landscape).toEqual(initial);
  });

  it('keeps the iOS detent at 1', () => {
    mocks.platform.OS = 'ios';
    mocks.insets.top = 47;

    expect(useFormSheetDetents()).toEqual({ fullSheetDetent: 1 });
  });
});
