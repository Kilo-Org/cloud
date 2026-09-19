// Native formSheets already respect the top safe area on both platforms.
// On Android, react-native-screens defaults sheetShouldOverflowTopInset to
// false and measures detents against the inset-adjusted height. Subtracting
// the inset again exposes a strip of the presenting screen's header.
export function useFormSheetDetents() {
  return { fullSheetDetent: 1 };
}
