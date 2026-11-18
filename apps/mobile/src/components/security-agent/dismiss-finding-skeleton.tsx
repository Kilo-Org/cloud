import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { SheetHeader } from '@/components/sheet-header';
import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { SectionHeaderSkeleton } from '@/components/ui/section-header-skeleton';
import { Skeleton } from '@/components/ui/skeleton';
import { SCREEN_BODY_CLASS } from '@/lib/layout';

/** The reason choices the loaded form paints under its label. */
const REASON_ROW_COUNT = 5;

/**
 * The dismiss sheet's own shape while the finding loads: the sheet header with
 * its commit control held down, then the identity card, the reason group and
 * the comment field at the boxes the loaded form paints.
 */
export function DismissFindingSkeleton() {
  const { t } = useTranslation();
  return (
    <View className="flex-1 bg-background">
      <SheetHeader title={t('securityAgent.dismiss.title')} onDone={() => undefined} disabled />
      <View className={SCREEN_BODY_CLASS}>
        {/* The identity card: the title and the two reference lines. */}
        <Skeleton className="h-24 w-full rounded-xl" />
        {/* The reason group: its section label and one row per reason. */}
        <View className="gap-3">
          <SectionHeaderSkeleton />
          <RowGroup>
            {Array.from({ length: REASON_ROW_COUNT }, (_, index) => (
              <RowSkeleton key={index} />
            ))}
          </RowGroup>
        </View>
        {/* The comment field: its label line and the multiline box. */}
        <View className="gap-1.5">
          <Skeleton className="h-4 w-24 rounded" />
          <Skeleton className="h-24 w-full rounded-md" />
        </View>
      </View>
    </View>
  );
}
