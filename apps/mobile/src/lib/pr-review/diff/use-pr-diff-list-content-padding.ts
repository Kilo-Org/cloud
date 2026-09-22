import { useMemo } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { prDiffListContentPadding } from './pr-diff-list-bottom-padding';

/**
 * Content-container style for the diff FlashList: the bottom padding that
 * clears the floating action bar plus the landscape side insets that keep
 * rows clear of the sensor housing. Side insets are horizontal-only, so the
 * height-feeding bottom padding is untouched; at zero portrait insets the
 * style carries explicit zeros.
 */
export function usePrDiffListContentPadding(barHeight: number | null) {
  const insets = useSafeAreaInsets();
  return useMemo(() => prDiffListContentPadding(barHeight, insets), [barHeight, insets]);
}
