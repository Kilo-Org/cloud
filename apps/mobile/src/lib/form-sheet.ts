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
