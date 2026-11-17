import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { Skeleton } from '@/components/ui/skeleton';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { useFormSheetHeaderTopInset } from '@/lib/navigation/sheet-header-top-inset';

/** The dismiss sheet's own shape while the finding loads. */
export function DismissFindingSkeleton() {
  const { t } = useTranslation();
  const modalTopInset = useFormSheetHeaderTopInset();
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('securityAgent.dismiss.title')} modal modalTopInset={modalTopInset} />
      <View className={SCREEN_BODY_CLASS}>
        {/* The identity card, the reason choice group and the comment field. */}
        <Skeleton className="h-24 w-full rounded-xl" />
        <RowGroup>
          <RowSkeleton />
          <RowSkeleton />
          <RowSkeleton />
        </RowGroup>
        <Skeleton className="h-24 w-full rounded-md" />
        <Skeleton className="h-11 w-full rounded-md" />
      </View>
    </View>
  );
}
