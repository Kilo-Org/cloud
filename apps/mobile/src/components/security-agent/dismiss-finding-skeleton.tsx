import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { Skeleton } from '@/components/ui/skeleton';
import { useFormSheetHeaderTopInset } from '@/lib/navigation/sheet-header-top-inset';

/** The dismiss sheet's own shape while the finding loads. */
export function DismissFindingSkeleton() {
  const { t } = useTranslation();
  const modalTopInset = useFormSheetHeaderTopInset();
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        className="px-6"
        title={t('securityAgent.dismiss.title')}
        modal
        modalTopInset={modalTopInset}
      />
      <View className="gap-6 px-6 pt-4">
        {/* The identity card: p-3 plus a title line and the two meta lines. */}
        <Skeleton className="h-[86px] w-full rounded-lg" />
        <Skeleton className="h-[224px] w-full rounded-lg" />
        <Skeleton className="h-24 w-full rounded-lg" />
        <Skeleton className="h-11 w-full rounded-md" />
      </View>
    </View>
  );
}
