import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * The settings screens' shared first-paint skeleton: a header over three
 * stacked bars. The class strings mirror the three specific screens' frames
 * (`h-16` rows for the toggles, `h-12` for the shorter trailing row) so each
 * screen loads into the same shape its content replaces.
 */
export function SettingsScreenSkeleton({ titleKey }: Readonly<{ titleKey: string }>) {
  const { t } = useTranslation();
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader className="px-6" title={t(titleKey)} />
      <View className="gap-3 px-6 pt-4">
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-12 w-full rounded-lg" />
      </View>
    </View>
  );
}
