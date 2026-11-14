import { useTranslation } from 'react-i18next';
import { useWindowDimensions, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import {
  LINE_ACTION_BOX_CLASS,
  LINE_ACTION_HIT_SLOP,
  STATE_ACTION_CLASS,
} from '@/lib/a11y/tap-target';
import { canOpenExternalBilling } from '@/lib/credits/external-billing-link';
import { openExternalUrl } from '@/lib/external-link';
import { isNarrowLayout } from '@/lib/narrow-layout';
import { cn } from '@/lib/utils';

/**
 * How prominent the control reads where it sits. `quiet` is the balance line's
 * outline control. `primary` fills with the accent surface, which is how a
 * transcript marks the one action that settles a refused send.
 */
export type AddCreditsEmphasis = 'quiet' | 'primary';

type AddCreditsButtonProps = Readonly<{
  /** In-app destination (the credit purchase screen); platform-agnostic. */
  onPress: () => void;
  emphasis?: AddCreditsEmphasis;
  className?: string;
  /**
   * Paint the line-action box's 28 dp floor instead of growing the line to a
   * control's touch size, with `hitSlop` carrying the rest of the 44 pt target.
   * The button carries no vertical margin of its own: `AddCreditsRow` puts the
   * inline control inside the box that cancels the height, so the caller's line
   * stays one text line tall (`apps/mobile/AGENTS.md`).
   */
  lineAction?: boolean;
}>;

/**
 * The "Add credits" call to action on its own, so a call site can place it
 * inside another surface — the balance card puts it on the right — instead of
 * rendering the whole row.
 *
 * The outline variant paints the elevated card surface in dark mode, which is
 * the fill of the card this control sits on: the button then reads as a faint
 * outline instead of the raised white control light mode shows. `--secondary-fill`
 * is the palette's own step above that surface, so the dark fill stands off the
 * card the way the light fill does.
 *
 * It is always an in-app CTA and therefore always safe to show on iOS. The
 * external billing-page variant lives in `AddCreditsRow`, which owns the App
 * Store gate.
 */
export function AddCreditsButton({
  onPress,
  emphasis = 'quiet',
  className,
  lineAction = false,
}: AddCreditsButtonProps) {
  const { t } = useTranslation();
  const primary = emphasis === 'primary';
  return (
    <Button
      size="sm"
      variant={primary ? 'default' : 'outline'}
      className={cn(
        // The theme's `--primary` is olive in light, which reads as one more
        // secondary action in a transcript, so the primary emphasis fills with
        // the surface the person's own bubble uses instead.
        primary ? 'bg-accent-soft' : 'dark:bg-secondary-fill',
        className,
        // A line action fills the box `AddCreditsRow` wraps around it: the frame
        // is the box's floor with no vertical margin, so the box alone cancels
        // the height and the caller's line stays one text line tall.
        lineAction ? 'min-h-[28px]' : STATE_ACTION_CLASS
      )}
      // Undefined keeps the shared `Button`'s own `sm` default; a line action
      // draws a smaller frame, so it carries the flush-to-44pt slop itself.
      hitSlop={lineAction ? LINE_ACTION_HIT_SLOP : undefined}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={t('addCredits.cta')}
    >
      <Text className={primary ? 'text-accent-soft-foreground' : 'text-xs font-semibold'}>
        {t('addCredits.cta')}
      </Text>
    </Button>
  );
}

type AddCreditsRowProps = Readonly<{
  /** External billing page to open. App Store review forbids this on iOS. */
  url?: string;
  /** In-app destination (the credit purchase screen); platform-agnostic. */
  onPress?: () => void;
  className?: string;
  /** How prominent the control reads where it sits; see `AddCreditsButton`. */
  emphasis?: AddCreditsEmphasis;
  /**
   * Hand the button to the caller's own row — the balance line it tops up —
   * with no wrapper and no full-width branch. The row and its padding belong to
   * that caller, so the button sits at its natural size beside the amount.
   */
  inline?: boolean;
  /** Keep the caller's line one text line tall; see `AddCreditsButton`. */
  lineAction?: boolean;
}>;

/**
 * An "Add credits" button in its call site's block. With `onPress` the button
 * is an in-app CTA on every platform. With `url` it opens the external web
 * billing page, which only Android has: iOS has no in-app link to an external
 * purchase (App Store review forbids it), so the gate here keeps that variant
 * off iOS whichever call site renders it. That is the whole platform fork: the
 * button and its in-app CTA are identical on both.
 *
 * The button carries its own label, so the block needs no copy beside it; a
 * sentence restating it is the redundancy `apps/mobile/AGENTS.md` rules out.
 * In a wide row it keeps its trailing position inside the caller's padding; in
 * a window under `NARROW_LAYOUT_WIDTH` it spans the row, which is the tap
 * target width it had before. With `inline` the caller's row is the row: the
 * button is returned at its natural size, so it can sit on the balance line
 * instead of filling a block of its own. With `lineAction` too, the button
 * comes wrapped in the line-action box: the box is the 28 dp frame the control
 * fills and its negative margin cancels that height, so the caller's line stays
 * one text line tall and the control's frame fits the box it belongs to.
 */
export function AddCreditsRow({
  url,
  onPress,
  className,
  emphasis,
  inline,
  lineAction,
}: AddCreditsRowProps) {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  const narrow = isNarrowLayout(width);
  // App Store review: iOS must not show an in-app CTA that opens an external
  // purchase/billing page, so the external `url` variant stays Android-only —
  // the shared gate keeps it here so no call site can surface it on iOS. An
  // in-app `onPress` CTA is platform-agnostic and shows on both platforms.
  if (!onPress && !canOpenExternalBilling()) {
    return null;
  }
  const button = (
    <AddCreditsButton
      onPress={
        onPress ??
        (() => {
          if (url) {
            void openExternalUrl(url, { label: t('addCredits.billingPage') });
          }
        })
      }
      emphasis={emphasis}
      lineAction={lineAction}
      className={inline || !narrow ? undefined : 'w-full'}
    />
  );
  if (inline) {
    // The box is the control's whole frame in this row: it is 28 dp tall and its
    // negative margin cancels that height, so the caller's line keeps its own
    // height. The box paints nothing, so the button — not the box — is what the
    // gate measures against the caller's row, and the row no longer has to grow
    // its trailing group to hold the control's frame.
    return lineAction ? <View className={LINE_ACTION_BOX_CLASS}>{button}</View> : button;
  }
  return (
    <View className={cn(narrow ? undefined : 'flex-row items-center justify-end', className)}>
      {button}
    </View>
  );
}
