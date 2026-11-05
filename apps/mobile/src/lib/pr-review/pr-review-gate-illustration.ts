import { useColorScheme } from 'react-native';

import { useThemeColors } from '@/lib/hooks/use-theme-colors';

/**
 * The illustration tile the PR-review connect gates draw above their title.
 *
 * The light cell's hairline separates a white bubble from the off-white page;
 * on the near-black dark surface both the card and that 7% hairline all but
 * vanish, so the dark cell takes the surface/border pair an outlined control
 * uses (`Button`'s `outline` variant). Every gate of this family shares it, so
 * the three connect screens cannot disagree in dark mode.
 */
export const PR_REVIEW_GATE_ICON_TILE_CLASS =
  'h-14 w-14 rounded-2xl border border-border bg-card dark:border-neutral-700 dark:bg-secondary';

/**
 * The glyph color for {@link PR_REVIEW_GATE_ICON_TILE_CLASS}. The shared
 * bubble's muted gray reads far dimmer on the near-black tile than on the
 * light one, so the dark cell takes the secondary-ink token and keeps the
 * illustration as visible as its light counterpart.
 */
export function usePrReviewGateIconColor(): string {
  const colors = useThemeColors();
  return useColorScheme() === 'dark' ? colors.ink2 : colors.mutedForeground;
}
