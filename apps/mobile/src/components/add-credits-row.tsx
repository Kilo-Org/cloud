import { useTranslation } from 'react-i18next';
import { Platform, useWindowDimensions, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { openExternalUrl } from '@/lib/external-link';
import { isNarrowLayout } from '@/lib/narrow-layout';
import { cn } from '@/lib/utils';

type AddCreditsRowProps = Readonly<{
  url: string;
  className?: string;
}>;

/** Zero-balance CTA row: muted copy + an "Add credits" button to the web billing page. */
export function AddCreditsRow({ url, className }: AddCreditsRowProps) {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  // The button keeps its natural width, so in a narrow window the description
  // beside it collapses to a column of single letters ("A", 160 dp, e1,
  // 2026-09-21). Stacking gives the copy the row's full width.
  const narrow = isNarrowLayout(width);
  // App Store review: iOS must not show an in-app CTA that opens an external
  // purchase/billing page. Credits are managed on the web there, so this row is
  // Android-only — gate it here so no call site can surface it on iOS.
  if (Platform.OS === 'ios') {
    return null;
  }
  return (
    <View className={cn(narrow ? 'gap-2' : 'flex-row items-center justify-between', className)}>
      <Text className={cn(narrow ? undefined : 'flex-1 pr-3', 'text-xs text-muted-foreground')}>
        {t('addCredits.description')}
      </Text>
      <Button
        size="sm"
        variant="outline"
        className={narrow ? 'w-full' : undefined}
        onPress={() => {
          void openExternalUrl(url, { label: t('addCredits.billingPage') });
        }}
      >
        <Text className="text-xs font-semibold">{t('addCredits.cta')}</Text>
      </Button>
    </View>
  );
}
