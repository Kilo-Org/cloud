import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useFormSheetDetents } from '@/lib/form-sheet';

const mocks = vi.hoisted(() => {
  const platform = { OS: 'android' as string };
  const insets = { top: 0, bottom: 0, left: 0, right: 0 };
  const statusBar = { currentHeight: null as number | null };
  const dimensions = { height: 800 };
  const initialWindowMetrics = {
    insets: { top: 0, bottom: 0, left: 0, right: 0 },
    frame: { x: 0, y: 0, width: 400, height: 800 },
  };
  return {
    platform,
    insets,
    statusBar,
    dimensions,
    initialWindowMetrics,
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
  initialWindowMetrics: mocks.initialWindowMetrics,
}));

describe('useFormSheetDetents', () => {
  beforeEach(() => {
    mocks.platform.OS = 'android';
    mocks.insets.top = 0;
    mocks.statusBar.currentHeight = null;
    mocks.dimensions.height = 800;
    mocks.initialWindowMetrics.insets.top = 0;
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

  it('keeps the Android detent capped while the safe-area inset is still unknown', () => {
    // Edge-to-edge window on the first render: the provider has not reported
    // the insets yet and StatusBar.currentHeight is 0. The cap must fall back
    // to the metrics captured at app start instead of collapsing to 1, or the
    // sheet opens full-bleed and its pinned header lands under the status bar.
    mocks.insets.top = 0;
    mocks.statusBar.currentHeight = 0;
    mocks.initialWindowMetrics.insets.top = 24;

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
