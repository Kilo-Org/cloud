import { type ThemeColors } from '@/lib/hooks/use-theme-colors';

/**
 * The ink of a selected row's check, in both schemes.
 *
 * A selected check is the row's only non-text affordance, so it carries the
 * row's own ink rather than the brand accent: in dark the accent is the yellow
 * that glares on the near-black page (see `components/ui/switch.tsx`). A
 * disabled row dims the check to the muted ink instead of dimming the copy the
 * user still reads.
 */
export function selectionCheckColor(colors: ThemeColors, disabled = false): string {
  return disabled ? colors.mutedForeground : colors.foreground;
}
