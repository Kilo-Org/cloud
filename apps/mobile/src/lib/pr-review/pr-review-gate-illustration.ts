import { useColorScheme } from 'react-native';

import { useThemeColors } from '@/lib/hooks/use-theme-colors';

/**
 * The illustration badge the PR-review connect gates draw above their title.
 *
 * It is the filled circular container every error state of the app draws
 * (`QueryError`), so a gate that reports a failed read and a gate that asks
 * for a connection show the same shape instead of two different ones. Every
 * gate of this family shares it, so the three connect screens cannot disagree.
 */
export const PR_REVIEW_GATE_ICON_TILE_CLASS = 'rounded-full bg-muted p-4';

/**
 * The glyph color for {@link PR_REVIEW_GATE_ICON_TILE_CLASS}. The shared
 * bubble's muted gray reads far dimmer on the near-black badge than on the
 * light one, so the dark cell takes the secondary-ink token and keeps the
 * illustration as visible as its light counterpart.
 */
export function usePrReviewGateIconColor(): string {
  const colors = useThemeColors();
  return useColorScheme() === 'dark' ? colors.ink2 : colors.mutedForeground;
}
