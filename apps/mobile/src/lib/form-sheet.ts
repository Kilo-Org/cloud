import { Platform, StatusBar, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Android formSheets can't hit 1.0 without clipping under the status bar, so
// the "full" detent is capped just below the top inset there; iOS can use 1.
//
// Route formSheet detents keep subtracting the Android top inset; native
// page-sheet roots opt into the same inset through useAndroidSheetTopInset().
// Remove either path only when React Native guarantees both sheet types avoid
// Android system bars.
export function useAndroidSheetTopInset() {
  const { top } = useSafeAreaInsets();
  if (Platform.OS !== 'android') {
    return 0;
  }
  return top > 0 ? top : (StatusBar.currentHeight ?? 0);
}

export function useFormSheetDetents() {
  const { height } = useWindowDimensions();
  const androidTopInset = useAndroidSheetTopInset();
  const androidFullSheetDetent =
    height > 0 ? Math.max(0.5, (height - androidTopInset) / height) : 1;
  const fullSheetDetent = Platform.OS === 'android' ? androidFullSheetDetent : 1;

  return { fullSheetDetent };
}
