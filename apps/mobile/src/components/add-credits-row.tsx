import { useTranslation } from 'react-i18next';
import { Platform, useWindowDimensions, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { openExternalUrl } from '@/lib/external-link';
import { isNarrowLayout } from '@/lib/narrow-layout';
import { cn } from '@/lib/utils';

type AddCreditsButtonProps = Readonly<{
  /** In-app destination (the credit purchase screen); platform-agnostic. */
  onPress: () => void;
  className?: string;
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
export function AddCreditsButton({ onPress, className }: AddCreditsButtonProps) {
  const { t } = useTranslation();
  return (
    <Button
      size="sm"
      variant="outline"
      className={cn('dark:bg-secondary-fill', className)}
      onPress={onPress}
    >
      <Text className="text-xs font-semibold">{t('addCredits.cta')}</Text>
    </Button>
  );
}

type AddCreditsRowProps = Readonly<{
  /** External billing page to open. App Store review forbids this on iOS. */
  url?: string;
  /** In-app destination (the credit purchase screen); platform-agnostic. */
  onPress?: () => void;
  className?: string;
  /**
   * Hand the button to the caller's own row — the balance line it tops up —
   * with no wrapper and no full-width branch. The row and its padding belong to
   * that caller, so the button sits at its natural size beside the amount.
   */
  inline?: boolean;
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
 * button is returned alone, at its natural size, so it can sit on the balance
 * line instead of filling a block of its own.
 */
export function AddCreditsRow({ url, onPress, className, inline }: AddCreditsRowProps) {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  const narrow = isNarrowLayout(width);
  // App Store review: iOS must not show an in-app CTA that opens an external
  // purchase/billing page, so the external `url` variant stays Android-only —
  // gate it here so no call site can surface it on iOS. An in-app `onPress`
  // CTA is platform-agnostic and shows on both platforms.
  if (!onPress && Platform.OS === 'ios') {
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
      className={inline || !narrow ? undefined : 'w-full'}
    />
  );
  if (inline) {
    return button;
  }
  return (
    <View className={cn(narrow ? undefined : 'flex-row items-center justify-end', className)}>
      {button}
    </View>
  );
}
