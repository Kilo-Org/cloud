// The recents read is a local storage read that settles in the first frames.
// A bare inline spinner at the section's start edge read as a clipped fragment
// of content rather than a loading state, so the pending body holds one flat
// recent row's own shape at the content width: RECENT stays a section with rows
// under it, and the row is replaced in place when the stored rows arrive.

import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Skeleton } from '@/components/ui/skeleton';

export function PrReviewRecentsPending() {
  const { t } = useTranslation();
  return (
    // A flat list row: the section already carries the page gutter, so the
    // placeholder adds none, exactly like the loaded recent rows.
    <View accessibilityRole="progressbar" accessibilityLabel={t('common.loading')} className="py-3">
      <View className="flex-row items-center gap-3">
        <View className="min-w-0 flex-1 gap-1">
          <Skeleton className="h-2.5 w-16 rounded-md" />
          <Skeleton className="h-4 w-3/4 rounded-md" />
          <Skeleton className="h-3 w-1/2 rounded-md" />
        </View>
        <Skeleton className="h-4 w-4 rounded-md" />
      </View>
    </View>
  );
}
