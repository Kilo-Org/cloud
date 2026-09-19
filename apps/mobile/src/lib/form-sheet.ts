import { createContext, useContext } from 'react';

// Native formSheets already respect the top safe area on both platforms.
// On Android, react-native-screens defaults sheetShouldOverflowTopInset to
// false and measures detents against the inset-adjusted height. Subtracting
// the inset again exposes a strip of the presenting screen's header.
export function useFormSheetDetents() {
  return { fullSheetDetent: 1 };
}

/**
 * Whether the native stack that hosts a formSheet has completed its first
 * layout pass.
 *
 * react-native-screens measures an Android formSheet's collapsed detent
 * (BottomSheetBehavior.peekHeight) once, when the sheet's screen fragment is
 * created, from the hosting stack's height. A sheet presented in the same
 * commit that mounts its stack — a deep link opened straight into a cold tab —
 * is therefore measured before the stack has laid out: its collapsed height
 * freezes near zero and the open sheet renders as nothing but the scrim
 * (spot-check e1). A layout that hosts a formSheet provides this context,
 * flipping it true on its first layout; a sheet that mounted before that
 * re-presents itself once so the detent is measured against a laid-out stack.
 */
export const FormSheetStackLaidOutContext = createContext(false);

export function useFormSheetStackLaidOut(): boolean {
  return useContext(FormSheetStackLaidOutContext);
}
