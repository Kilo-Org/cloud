import { Platform, useWindowDimensions } from 'react-native';

import { isTabletFromDimensions } from '@/lib/hooks/is-tablet';

// `Platform.isPad` is a runtime constant on iOS hardware (not in the public
// TS types for cross-platform code), so we narrow at the call site.
function readIsPad(): boolean {
  if (Platform.OS !== 'ios') {
    return false;
  }
  return (Platform as { isPad?: boolean }).isPad === true;
}

/**
 * Live-recomputed tablet/phone split. Use for layouts that branch on form
 * factor (single-pane vs split-view, sheet detents, etc.). The threshold
 * itself is a pure decision in `isTabletFromDimensions` so it stays
 * unit-testable without RN's window/Platform globals.
 */
export function useIsTablet(): boolean {
  const { width, height } = useWindowDimensions();
  return isTabletFromDimensions(width, height, readIsPad());
}
