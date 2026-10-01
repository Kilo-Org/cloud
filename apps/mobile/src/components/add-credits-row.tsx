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
 * It is always an in-app CTA and therefore always safe to show on iOS. The
 * external billing-page variant lives in `AddCreditsRow`, which owns the App
 * Store gate.
 */
export function AddCreditsButton({ onPress, className }: AddCreditsButtonProps) {
  const { t } = useTranslation();
  return (
    <Button size="sm" variant="outline" className={className} onPress={onPress}>
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
}>;

/**
 * Muted copy + an "Add credits" button. With `onPress` the button is an in-app
 * CTA on every platform. With `url` it opens the external web billing page,
 * which only Android has: iOS has no in-app link to an external purchase
 * (App Store review forbids it), so the gate here keeps that variant off iOS
 * whichever call site renders it. That is the whole platform fork: the row's
 * copy, layout and in-app CTA are identical on both.
 */
export function AddCreditsRow({ url, onPress, className }: AddCreditsRowProps) {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  // The button keeps its natural width, so in a narrow window the description
  // beside it collapses to a column of single letters ("A", 160 dp, e1,
  // 2026-09-21). Stacking gives the copy the row's full width.
  const narrow = isNarrowLayout(width);
  // App Store review: iOS must not show an in-app CTA that opens an external
  // purchase/billing page, so the external `url` variant stays Android-only —
  // gate it here so no call site can surface it on iOS. An in-app `onPress`
  // CTA is platform-agnostic and shows on both platforms.
  if (!onPress && Platform.OS === 'ios') {
    return null;
  }
  return (
    <View className={cn(narrow ? 'gap-2' : 'flex-row items-center justify-between', className)}>
      <Text className={cn(narrow ? undefined : 'flex-1 pr-3', 'text-xs text-muted-foreground')}>
        {t('addCredits.description')}
      </Text>
      <AddCreditsButton
        onPress={
          onPress ??
          (() => {
            if (url) {
              void openExternalUrl(url, { label: t('addCredits.billingPage') });
            }
          })
        }
        className={narrow ? 'w-full' : undefined}
      />
    </View>
  );
}
