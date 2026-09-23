import { useTranslation } from 'react-i18next';
import { Platform, useWindowDimensions, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { openExternalUrl } from '@/lib/external-link';
import { isNarrowLayout } from '@/lib/narrow-layout';
import { cn } from '@/lib/utils';

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
  const handlePress = () => {
    if (onPress) {
      onPress();
      return;
    }
    if (url) {
      void openExternalUrl(url, { label: t('addCredits.billingPage') });
    }
  };
  return (
    <View className={cn(narrow ? 'gap-2' : 'flex-row items-center justify-between', className)}>
      <Text className={cn(narrow ? undefined : 'flex-1 pr-3', 'text-xs text-muted-foreground')}>
        {t('addCredits.description')}
      </Text>
      <Button
        size="sm"
        variant="outline"
        className={narrow ? 'w-full' : undefined}
        onPress={handlePress}
      >
        <Text className="text-xs font-semibold">{t('addCredits.cta')}</Text>
      </Button>
    </View>
  );
}
