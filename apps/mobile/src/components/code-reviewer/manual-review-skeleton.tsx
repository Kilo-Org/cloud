import { View } from 'react-native';

import { Skeleton } from '@/components/ui/skeleton';

/**
 * Loading placeholder for the manual review body while the provider status is
 * still settling: the icon bubble, the title line and the full-width action of
 * the connect state it may resolve to, so the page never shows nothing under
 * its header and the state that arrives keeps the same shape.
 *
 * It centers itself instead of going through `CenteredState`: that component
 * places a data state against the band its surface reports and the size its
 * own content reports, so its placement settles one layout pass later. A
 * placeholder has the opposite requirement: it is the only thing on screen
 * while the status is unknown, so it paints from the first frame at a
 * placement that needs no measurement.
 */
export function ManualReviewSkeleton() {
  return (
    <View className="flex-1 items-center justify-center gap-4 px-6">
      <Skeleton className="h-14 w-14 rounded-2xl" />
      <Skeleton className="h-6 w-44 rounded" />
      <Skeleton className="mt-3 h-12 w-full rounded-md" />
    </View>
  );
}
