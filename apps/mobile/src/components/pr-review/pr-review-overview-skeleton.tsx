import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Skeleton } from '@/components/ui/skeleton';

/**
 * The overview body's only paint while the PR/MR read is in flight.
 *
 * It is the whole screen below the tab selector for as long as the read takes,
 * including the query client's retries, so it has to read as loading without
 * any text: the bars use the shared animated `Skeleton` (pulse + shimmer) on
 * `bg-muted-soft` — `bg-muted` matches the page background, which made the old
 * static bars look like an empty scroll area — and the block carries the
 * progress role and the app's generic loading label for assistive technology
 * that would otherwise get an empty body.
 */
export function PrReviewOverviewSkeleton() {
  const { t } = useTranslation();
  return (
    <View
      className="gap-6"
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={t('common.loading')}
      accessibilityState={{ busy: true }}
    >
      <View className="gap-2">
        <Skeleton className="h-5 w-20 rounded-full bg-muted-soft" />
        <Skeleton className="h-7 w-3/4 rounded bg-muted-soft" />
        <Skeleton className="h-5 w-1/2 rounded bg-muted-soft" />
      </View>
      <View className="gap-2">
        <Skeleton className="h-3 w-32 rounded bg-muted-soft" />
        <Skeleton className="h-3 w-48 rounded bg-muted-soft" />
        <Skeleton className="h-3 w-40 rounded bg-muted-soft" />
      </View>
      <View className="gap-2">
        <Skeleton className="h-3 w-full rounded bg-muted-soft" />
        <Skeleton className="h-3 w-5/6 rounded bg-muted-soft" />
        <Skeleton className="h-3 w-2/3 rounded bg-muted-soft" />
      </View>
    </View>
  );
}
