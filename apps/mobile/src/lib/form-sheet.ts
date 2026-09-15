import { Platform, StatusBar, useWindowDimensions } from 'react-native';
import { initialWindowMetrics, useSafeAreaInsets } from 'react-native-safe-area-context';

// The provider answers zero for the first render, before the native module
// reports the real insets, and `StatusBar.currentHeight` is 0 in the
// edge-to-edge window the app runs in. Without a third source the cap
// silently collapses to 1 exactly then: the sheet opens full-bleed and the
// pinned sheet header — which trusts the sheet for its top inset
// (pr-form-sheet-chrome) — draws its title under the status bar (g7/g8/g9
// spot check). `initialWindowMetrics` is captured at app start, so it is the
// synchronous fallback that keeps that first render capped.
function resolveAndroidTopInset(safeAreaTop: number): number {
  if (safeAreaTop > 0) {
    return safeAreaTop;
  }
  const statusBarTop = StatusBar.currentHeight ?? 0;
  if (statusBarTop > 0) {
    return statusBarTop;
  }
  return initialWindowMetrics?.insets.top ?? 0;
}

// Android formSheets can't hit 1.0 without clipping under the status bar, so
// the "full" detent is capped just below the top inset there; iOS can use 1.
export function useFormSheetDetents() {
  const { height } = useWindowDimensions();
  const { top } = useSafeAreaInsets();
  const androidTopInset = resolveAndroidTopInset(top);
  const androidFullSheetDetent =
    height > 0 ? Math.max(0.5, (height - androidTopInset) / height) : 1;
  const fullSheetDetent = Platform.OS === 'android' ? androidFullSheetDetent : 1;

  return { fullSheetDetent };
}
