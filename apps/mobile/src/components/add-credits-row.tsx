import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { openExternalUrl } from '@/lib/external-link';
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
 * which App Store review forbids from an in-app CTA, so that variant stays
 * Android-only — gate it here so no call site can surface it on iOS.
 */
export function AddCreditsRow({ url, onPress, className }: AddCreditsRowProps) {
  const { t } = useTranslation();
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
    <View className={cn('flex-row items-center justify-between', className)}>
      <Text className="flex-1 pr-3 text-xs text-muted-foreground">
        {t('addCredits.description')}
      </Text>
      <Button size="sm" variant="outline" onPress={handlePress}>
        <Text className="text-xs font-semibold">{t('addCredits.cta')}</Text>
      </Button>
    </View>
  );
}
