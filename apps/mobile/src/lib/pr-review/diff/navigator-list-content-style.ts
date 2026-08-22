// Pure list-content style helper for the PR file navigator. Extracted from
// `pr-diff-file-navigator.tsx` so the inset-aware padding computation is
// testable without mounting the sheet.

import { Platform, type ViewStyle } from 'react-native';

/** Matches the previous ScrollView `contentContainerClassName="pb-8 pt-2"`. */
const NAVIGATOR_LIST_CONTENT_BASE_PADDING_BOTTOM = 32;
const NAVIGATOR_LIST_CONTENT_BASE_PADDING_TOP = 8;

/**
 * Returns the navigator list content style. The navigator is a formSheet whose
 * bottom edge sits on the Android system bar, so the list's bottom content
 * padding carries the system inset.
 */
export function navigatorListContentStyle(bottomInset: number): ViewStyle {
  const androidInset = Platform.OS === 'android' ? bottomInset : 0;
  return {
    paddingBottom: NAVIGATOR_LIST_CONTENT_BASE_PADDING_BOTTOM + androidInset,
    paddingTop: NAVIGATOR_LIST_CONTENT_BASE_PADDING_TOP,
  };
}
