import { type HeaderEyebrow } from '@/components/screen-header';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * The header props a caller's eyebrow state maps to, so every screen that
 * names its eyebrow from a read decides the same thing in one place.
 *
 * `loading` reserves the line and paints the bar over it: one eyebrow line tall
 * and as wide as a short label (`h-2.5 w-20`), so the slot the arriving text
 * takes stays the height the text needs — the header paints the bar over the
 * line, which is why the bar never sizes it.
 *
 * `held` reserves the same line with nothing painted, so a read that stopped
 * (failed, not found, permission denied) leaves the title in place without an
 * animation it can never finish: nothing pulses on a screen whose label can
 * only arrive through a retry. `ready` and `none` reserve no line at all.
 */
export function eyebrowHeaderProps(eyebrow: HeaderEyebrow) {
  if (eyebrow.kind === 'ready') {
    return { eyebrow: eyebrow.text, reserveEyebrow: false, eyebrowPlaceholder: undefined };
  }
  if (eyebrow.kind === 'loading') {
    return {
      eyebrow: undefined,
      reserveEyebrow: true,
      eyebrowPlaceholder: <Skeleton className="h-2.5 w-20 rounded-full" />,
    };
  }
  if (eyebrow.kind === 'held') {
    return { eyebrow: undefined, reserveEyebrow: true, eyebrowPlaceholder: undefined };
  }
  return { eyebrow: undefined, reserveEyebrow: false, eyebrowPlaceholder: undefined };
}
