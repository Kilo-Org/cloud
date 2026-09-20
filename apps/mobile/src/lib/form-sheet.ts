import { Platform, StatusBar, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Android formSheets can't hit 1.0 without clipping under the status bar, so
// the "full" detent is capped just below the top inset there; iOS can use 1.
export function useFormSheetDetents() {
  const { height } = useWindowDimensions();
  const { top } = useSafeAreaInsets();
  const androidTopInset = top > 0 ? top : (StatusBar.currentHeight ?? 0);
  const androidFullSheetDetent =
    height > 0 ? Math.max(0.5, (height - androidTopInset) / height) : 1;
  const fullSheetDetent = Platform.OS === 'android' ? androidFullSheetDetent : 1;

  return { fullSheetDetent };
}

/**
 * The options every formSheet route in the app registers.
 *
 * `sheetShouldOverflowTopInset` makes Android measure `sheetAllowedDetents`
 * against the full stack height, the way iOS does, and stops the sheet being
 * lifted by the bottom system gesture inset. Without it Android subtracts the
 * top inset a second time at the bottom — the sheet surface ends above the
 * window bottom and the screen behind it shows through the strip under the
 * sheet (the new-session screen's olive "Start session" button under the repo
 * picker). `fullSheetDetent` keeps the top edge below the status bar in that
 * full-height measure.
 */
export function useFormSheetScreenOptions() {
  const { fullSheetDetent } = useFormSheetDetents();

  return {
    presentation: 'formSheet' as const,
    sheetAllowedDetents: [0.5, fullSheetDetent] as [number, number],
    sheetGrabberVisible: true,
    headerShown: false,
    sheetShouldOverflowTopInset: true,
  };
}
